/**
 * Project DNA — Main OpenCode Plugin Entry Point
 * Self-synthesizing LiveTools, LiveSkills, and LiveMemory (A-Mem) for OpenCode
 */

import type { Plugin, Hooks } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin/tool"
import { z } from "zod"

import { ConfigManager, type ProjectDNAConfig } from "./core/config.js"
import { UniversalSqliteDatabase } from "./core/sqlite-adapter.js"
import { OpenCodeLLMBridge } from "./core/llm-bridge.js"
import { PluginNotifier } from "./core/notifier.js"

import { MemoryStore } from "./memory/memory-store.js"
import { DynamicLinkGenerator } from "./memory/link-generator.js"
import { DiagnosticBank } from "./memory/diagnostic-bank.js"

import { LiveToolRegistry } from "./tools/tool-registry.js"
import { LiveToolMaker } from "./tools/tool-maker.js"
import { createLiveMetaTools } from "./tools/meta-tools.js"

import { LiveSkillHarvester } from "./skills/trace-harvester.js"
import { LiveSkillDistiller } from "./skills/skill-distiller.js"
import { LiveSkillStore } from "./skills/skill-store.js"

export const ProjectDNAPlugin: Plugin = async (input, userOptions) => {
  // 1. Initialize Configuration and Workspace Storage Layout
  const configManager = new ConfigManager(
    input.directory,
    userOptions as Partial<ProjectDNAConfig>
  )
  await configManager.initializeStorage()
  const cfg = configManager.current

  // 2. Initialize Foundation Bridges, Database & Notification Service
  const db = new UniversalSqliteDatabase(configManager.memoryDbPath)
  const llmBridge = new OpenCodeLLMBridge(input.client, cfg.synthesisTimeoutMs)
  const notifier = new PluginNotifier(input.client)

  // 3. Conditionally Initialize LiveMemory Subsystem
  let memoryStore: MemoryStore | undefined
  let linkGenerator: DynamicLinkGenerator | undefined
  let diagnosticBank: DiagnosticBank | undefined

  if (cfg.enableLiveMemory) {
    memoryStore = new MemoryStore(db)
    await memoryStore.init()
    linkGenerator = new DynamicLinkGenerator(llmBridge)
    diagnosticBank = new DiagnosticBank()
  }

  // 4. Conditionally Initialize LiveTools Subsystem
  let toolRegistry: LiveToolRegistry | undefined
  let toolMaker: LiveToolMaker | undefined
  const liveToolsMap: Record<string, unknown> = {}

  if (cfg.enableLiveTools) {
    toolRegistry = new LiveToolRegistry(configManager.toolsDir)
    await toolRegistry.loadActiveTools()
    toolMaker = new LiveToolMaker(llmBridge, input.directory, configManager.toolsDir)

    // Load existing active tools into map
    Object.assign(liveToolsMap, toolRegistry.getToolMap())

    // Register meta-tools for LiveTool synthesis and lifecycle operations
    const metaTools = createLiveMetaTools({
      toolMaker,
      toolRegistry,
      liveToolsMap,
      notifier,
    })
    Object.assign(liveToolsMap, metaTools)
  }

  // 5. Conditionally Initialize LiveSkills Subsystem
  let skillHarvester: LiveSkillHarvester | undefined
  let skillDistiller: LiveSkillDistiller | undefined
  let skillStore: LiveSkillStore | undefined

  if (cfg.enableLiveSkills) {
    skillHarvester = new LiveSkillHarvester()
    skillDistiller = new LiveSkillDistiller(llmBridge)
    skillStore = new LiveSkillStore(
      configManager.activeSkillsDir,
      configManager.stagedSkillsDir,
      configManager.archivedSkillsDir
    )
    await skillStore.loadActiveSkills()
  }

  // Register Knowledge Graph query tool if LiveMemory is enabled
  if (cfg.enableLiveMemory && memoryStore) {
    const schema = tool.schema ?? z
    liveToolsMap["query_knowledge_graph"] = tool({
      description:
        "Searches the Project DNA Zettelkasten knowledge graph for atomic knowledge cards, architectural decisions, and diagnostic recovery procedures.",
      args: {
        query: schema.string().describe("Search query, keywords, or error signature"),
        limit: schema.number().optional().describe("Maximum number of cards to return (default: 5)"),
      } as any,
      async execute(args: any) {
        if (!memoryStore) throw new Error("LiveMemory subsystem is disabled.")
        const cards = await memoryStore.queryRelevant(String(args.query), args.limit ?? 5)
        return {
          title: `Knowledge Cards (${cards.length})`,
          output:
            cards.length > 0
              ? JSON.stringify(cards, null, 2)
              : "No matching knowledge cards found in graph.",
          metadata: { count: cards.length },
        }
      },
    })
  }

  // 6. Assemble OpenCode Hooks
  const hooks: Hooks = {
    // Dynamic Tool Registry exposed to OpenCode
    tool: liveToolsMap as any,

    // Dynamic schema & description mutation: Keep descriptions immutable across turns to preserve KV cache
    "tool.definition": async (inp, out) => {
      if (!toolRegistry) return
      const meta = toolRegistry.getMetadata(inp.toolID)
      if (meta) {
        if (meta.description) {
          out.description = meta.description
        }
      }
    },

    // Execution Interception: Step buffering & intent capture
    "tool.execute.before": async (inp, out) => {
      if (skillHarvester) {
        skillHarvester.recordStep(inp.sessionID, {
          tool: inp.tool,
          args: out?.args ?? {},
          output: "",
          timestamp: new Date().toISOString(),
        })
      }
    },

    // Execution Interception: Telemetry, Error detection, and Recovery logging
    "tool.execute.after": async (inp, out) => {
      const outputText = out.output ?? ""
      const titleText = out.title ?? ""
      const hasErrorMetadata =
        Boolean(out.metadata?.error) ||
        (typeof out.metadata?.exitCode === "number" && out.metadata.exitCode !== 0)
      const titleIndicatesError = /failed|failure|error|exception/i.test(titleText)
      const outputStartsWithError = /^(error|fatal|fail(ed|ure)?):\s+/i.test(outputText.trim())
      const isError = hasErrorMetadata || titleIndicatesError || outputStartsWithError

      if (skillHarvester) {
        skillHarvester.updateStepOutput(inp.sessionID, inp.tool, outputText)
      }

      if (diagnosticBank) {
        if (isError) {
          await diagnosticBank.recordFailure({
            sessionID: inp.sessionID,
            toolName: inp.tool,
            rawError: outputText || "Unknown tool error",
            resolved: false,
          })
        } else {
          // Successful execution records recovery if resolving an earlier failure
          await diagnosticBank.recordRecovery(
            inp.sessionID,
            `Executed tool ${inp.tool} with args ${JSON.stringify(inp.args ?? {})}`
          )
        }
      }
    },

    // Command Interception: Buffer CLI executions as trace steps
    "command.execute.before": async (inp) => {
      if (skillHarvester) {
        skillHarvester.recordStep(inp.sessionID, {
          tool: `command:${inp.command}`,
          args: { arguments: inp.arguments },
          output: "",
          timestamp: new Date().toISOString(),
        })
      }
    },

    // Chat Message Hook: Step buffering & intent capture (never mutates user prompt to preserve KV cache and UI clarity)
    "chat.message": async (inp, out) => {
      const textPart = out.parts.find((p) => p.type === "text")
      const userText = textPart && "text" in textPart ? (textPart.text as string) : ""

      if (userText && skillHarvester) {
        skillHarvester.setUserGoal(inp.sessionID, userText)
      }
    },

    // System Prompt Transform Hook: High-level architectural instructions
    "experimental.chat.system.transform": async (_inp, out) => {
      const activePillars = [
        cfg.enableLiveTools ? "LiveTools (LATM synthesis)" : null,
        cfg.enableLiveSkills ? "LiveSkills (Dynamic procedural lifecycle)" : null,
        cfg.enableLiveMemory ? "LiveMemory (A-Mem Zettelkasten)" : null,
      ]
        .filter(Boolean)
        .join(", ")

      out.system.push(
        `Project DNA is active [${activePillars}]: This agent autonomously writes, verifies, and reuses procedural skills, tools, and Zettelkasten memory notes. Previously created live tools from past sessions are automatically loaded as normal first-class tools and can be executed directly or via 'invoke_live_tool'. Newly synthesized tools in this session are available immediately. To inspect active tools, use 'list_live_tools'. To create new tools, use 'register_live_tool' or 'synthesize_live_tool'. To manage existing tools, use 'unregister_live_tool' to evict broken, obsolete, or duplicate zombie tools, and 'reload_live_tools' to refresh tools from disk.`
      )
    },

    // Compaction Hook: Preserves uncompacted session state across context window truncation
    "experimental.session.compacting": async (inp, out) => {
      const sessionNotes = memoryStore ? await memoryStore.getNotesForSession(inp.sessionID) : []
      const activeDiagnostics = diagnosticBank
        ? await diagnosticBank.getActiveDiagnostics(inp.sessionID)
        : []

      if (sessionNotes.length > 0 || activeDiagnostics.length > 0) {
        out.context.push(`
## Project DNA: Epistemic State to Persist Across Compaction
${
  sessionNotes.length > 0
    ? `### Established Knowledge Cards:\n${sessionNotes
        .map((n) => `- [${n.category}] ${n.title}: ${n.insight}`)
        .join("\n")}`
    : ""
}
${
  activeDiagnostics.length > 0
    ? `### Active Failure Traps to Avoid:\n${activeDiagnostics
        .map((d) => `- Error Signature: ${d.errorSignature}`)
        .join("\n")}`
    : ""
}
`)
      }
    },

    // Global Event Dispatcher: Non-blocking synthesis on turn idle
    event: async ({ event }) => {
      const ev = event as any
      const eventType = ev.type ?? ""
      const properties = ev.properties ?? {}
      const sessionID = properties.sessionID ?? ev.sessionID

      switch (eventType) {
        case "session.idle":
        case "EventSessionIdle": {
          if (!sessionID) break

          // 1. Skill harvesting with organic resolution evaluation
          if (skillHarvester && skillDistiller && skillStore) {
            const activeErrors = diagnosticBank
              ? await diagnosticBank.getActiveDiagnostics(sessionID)
              : []
            skillHarvester.evaluateAndSetResolution(sessionID, activeErrors.length > 0)

            if (skillHarvester.isEligibleForHarvest(sessionID)) {
              const trace = skillHarvester.getTrace(sessionID)
              if (trace) {
                try {
                  const distilled = await skillDistiller.distill(trace)
                  const verified = await skillDistiller.adversarialVerify(distilled)
                  if (verified.passed) {
                    await skillStore.saveSkill(distilled)
                    await notifier.notifySkillHarvested(
                      distilled.metadata.name,
                      distilled.metadata.confidenceScore
                    )
                  } else {
                    console.warn(
                      `[Project DNA] Skill verification failed for '${distilled.metadata.name}':`,
                      verified.feedback
                    )
                  }
                } catch (err) {
                  console.warn(
                    `[Project DNA] Skill distillation failed for session ${sessionID}:`,
                    err
                  )
                } finally {
                  skillHarvester.clearTrace(sessionID)
                }
              }
            }
          }

          // 2. Distill resolved diagnostics into permanent knowledge notes
          if (diagnosticBank && memoryStore) {
            try {
              await diagnosticBank.distillToMemory(memoryStore)
            } catch (err) {
              console.warn("[Project DNA] Diagnostic distillation error:", err)
            }
          }

          // 3. Record turn in tool registry to increment unused turns and archive degraded tools
          if (toolRegistry) {
            try {
              await toolRegistry.recordTurn()
              const active = toolRegistry.getToolMap()
              for (const key of Object.keys(liveToolsMap)) {
                if (!active[key] && toolRegistry.isLiveTool(key)) {
                  delete liveToolsMap[key]
                }
              }
            } catch (err) {
              console.warn("[Project DNA] Tool turn tracking error:", err)
            }
          }

          break
        }

        case "session.error":
        case "EventSessionError": {
          if (diagnosticBank && sessionID) {
            await diagnosticBank.recordFailure({
              sessionID,
              rawError: properties.error ?? ev.error ?? "Session runtime error",
              resolved: false,
            })
          }
          break
        }

        case "command.executed":
        case "EventCommandExecuted": {
          const cmdName = properties.name ?? ev.command ?? "shell"
          const cmdArgs = properties.arguments ?? ev.arguments ?? ""
          const cmdOutput = properties.output ?? ev.output ?? ""
          const exitCode = properties.exitCode ?? ev.exitCode

          if (skillHarvester && sessionID) {
            skillHarvester.updateStepOutput(
              sessionID,
              `command:${cmdName}`,
              cmdOutput,
              exitCode
            )
          }

          if (diagnosticBank && exitCode !== undefined && exitCode !== 0) {
            await diagnosticBank.recordFailure({
              sessionID: sessionID ?? "global",
              command: `${cmdName} ${cmdArgs}`.trim(),
              rawError: cmdOutput || `Command exited with code ${exitCode}`,
              resolved: false,
            })
          }
          break
        }
      }
    },

    // Dispose Hook: Flushes caches and closes SQLite database
    dispose: async () => {
      db.close()
    },
  }

  return hooks
}

export default ProjectDNAPlugin
