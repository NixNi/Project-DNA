/**
 * Project DNA — Main OpenCode Plugin Entry Point
 * Self-synthesizing LiveTools, LiveSkills, and LiveMemory (A-Mem) for OpenCode
 */

import type { Plugin, Hooks } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin/tool"
import { z } from "zod"
import { randomUUID } from "node:crypto"

import { ConfigManager, type ProjectDNAConfig } from "./core/config.js"
import { UniversalSqliteDatabase } from "./core/sqlite-adapter.js"
import { OpenCodeLLMBridge } from "./core/llm-bridge.js"

import { MemoryStore } from "./memory/memory-store.js"
import { DynamicLinkGenerator } from "./memory/link-generator.js"
import { DiagnosticBank } from "./memory/diagnostic-bank.js"

import { LiveToolRegistry } from "./tools/tool-registry.js"
import { LiveToolMaker } from "./tools/tool-maker.js"

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

  // 2. Initialize Foundation Bridges & Database
  const db = new UniversalSqliteDatabase(configManager.memoryDbPath)
  const llmBridge = new OpenCodeLLMBridge(input.client, cfg.synthesisTimeoutMs)

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

    // Meta-tool: Allows the agent to explicitly synthesize, verify, and hot-load new tools
    const schema = tool.schema ?? z
    liveToolsMap["synthesize_live_tool"] = tool({
      description:
        "Synthesizes a new reusable TypeScript tool or registers a model-authored implementation, validates its AST security, verifies it in an isolated test sandbox, and hot-loads it immediately into OpenCode.",
      args: {
        toolName: schema
          .string()
          .regex(/^[a-z0-9_-]+$/)
          .describe("Unique snake_case or kebab-case name of the new tool"),
        intent: schema
          .string()
          .describe("Detailed description of what the tool accomplishes and its requirements"),
        sourceCode: schema
          .string()
          .optional()
          .describe("Optional: The complete TypeScript source code if written directly by the model. When provided, bypasses background LLM synthesis."),
        testCode: schema
          .string()
          .optional()
          .describe("Optional: Unit test TypeScript code using node:test or bun:test to verify the tool in the sandbox."),
        sampleInputs: schema
          .array(schema.record(schema.string(), schema.any()))
          .optional()
          .describe("Representative input arguments for test verification"),
        expectedOutputs: schema
          .array(schema.any())
          .optional()
          .describe("Expected outputs corresponding to the sample inputs"),
      } as any,
      async execute(args: any) {
        if (!toolMaker || !toolRegistry) {
          throw new Error("LiveTools subsystem is disabled.")
        }

        const toolName = String(args.toolName)
        const intent = String(args.intent)
        const sourceCode = args.sourceCode ? String(args.sourceCode) : undefined
        const testCode = args.testCode ? String(args.testCode) : undefined
        const sampleInputs = (Array.isArray(args.sampleInputs) ? args.sampleInputs : []) as Record<string, unknown>[]
        const expectedOutputs = (Array.isArray(args.expectedOutputs) ? args.expectedOutputs : []) as unknown[]

        await toolMaker.synthesize({
          toolName,
          intent,
          sourceCode,
          testCode,
          sampleInputs,
          expectedOutputs,
        })

        const metadata = {
          id: randomUUID(),
          name: toolName,
          version: "1.0.0",
          description: intent,
          entrypoint: `src/${toolName}.ts`,
          testFile: `tests/${toolName}.test.ts`,
          status: "ACTIVE" as const,
          parameters: {},
          telemetry: {
            totalInvocations: 0,
            successCount: 0,
            failureCount: 0,
            avgDurationMs: 0,
            healthScore: 1.0,
          },
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }

        // Hot-load executable module into memory and persist to registry.json
        const executable = await toolRegistry.registerAndLoad(metadata)
        if (executable) {
          liveToolsMap[toolName] = executable
        }

        return {
          title: `Synthesized & Hot-Loaded Tool: ${toolName}`,
          output: `Tool '${toolName}' was successfully synthesized, passed AST security validation, passed sandbox unit testing, and is now actively hot-loaded and available for invocation!`,
        }
      },
    })

    // Direct meta-tool: Allows the agent to directly submit model-authored tools with zero LLM sub-session latency
    liveToolsMap["register_live_tool"] = tool({
      description:
        "Directly registers a model-authored TypeScript tool into OpenCode with zero background LLM latency. Validates AST security, verifies in isolated subprocess sandbox, and hot-loads into the live registry.",
      args: {
        toolName: schema
          .string()
          .regex(/^[a-z0-9_-]+$/)
          .describe("Unique snake_case or kebab-case name of the new tool"),
        description: schema
          .string()
          .describe("Clear description of what the tool accomplishes and its argument schema"),
        sourceCode: schema
          .string()
          .describe(
            "Complete TypeScript source code of the tool. Must import { tool } from '@opencode-ai/plugin/tool' and { z } from 'zod', and export the tool instance."
          ),
        testCode: schema
          .string()
          .optional()
          .describe("Optional TypeScript unit test code using node:test or bun:test to verify the tool"),
        sampleInputs: schema
          .array(schema.record(schema.string(), schema.any()))
          .optional()
          .describe("Optional representative inputs for automated verification test"),
      } as any,
      async execute(args: any) {
        if (!toolMaker || !toolRegistry) {
          throw new Error("LiveTools subsystem is disabled.")
        }

        const toolName = String(args.toolName)
        const desc = String(args.description)
        const sourceCode = String(args.sourceCode)
        const testCode = args.testCode ? String(args.testCode) : undefined
        const sampleInputs = Array.isArray(args.sampleInputs) ? args.sampleInputs : []

        await toolMaker.registerDirect({
          toolName,
          description: desc,
          sourceCode,
          testCode,
          sampleInputs,
        })

        const metadata = {
          id: randomUUID(),
          name: toolName,
          version: "1.0.0",
          description: desc,
          entrypoint: `src/${toolName}.ts`,
          testFile: `tests/${toolName}.test.ts`,
          status: "ACTIVE" as const,
          parameters: {},
          telemetry: {
            totalInvocations: 0,
            successCount: 0,
            failureCount: 0,
            avgDurationMs: 0,
            healthScore: 1.0,
          },
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }

        const executable = await toolRegistry.registerAndLoad(metadata)
        if (executable) {
          liveToolsMap[toolName] = executable
        }

        return {
          title: `Registered & Hot-Loaded Tool: ${toolName}`,
          output: `Tool '${toolName}' was directly registered by the model, passed AST security validation, passed sandbox unit testing, and is now actively hot-loaded and available for invocation!`,
        }
      },
    })
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

  // 6. Assemble OpenCode Hooks
  const hooks: Hooks = {
    // Dynamic Tool Registry exposed to OpenCode
    tool: liveToolsMap as any,

    // Dynamic schema & description mutation
    "tool.definition": async (inp, out) => {
      if (!toolRegistry) return
      const meta = toolRegistry.getMetadata(inp.toolID)
      if (meta) {
        out.description = meta.description
        if (meta.parameters && Object.keys(meta.parameters).length > 0) {
          out.parameters = meta.parameters
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
      const isError = /error|failed|exception/i.test(out.output ?? "")
      const durationMs = 100 // Estimate if not directly provided

      if (toolRegistry && toolRegistry.isLiveTool(inp.tool)) {
        await toolRegistry.recordExecution(inp.tool, !isError, durationMs)
      }

      if (diagnosticBank) {
        if (isError) {
          await diagnosticBank.recordFailure({
            sessionID: inp.sessionID,
            toolName: inp.tool,
            rawError: out.output ?? "Unknown tool error",
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

    // Chat Message Hook: Context enrichment with Top-K Memory Cards & Relevant Skills
    "chat.message": async (inp, out) => {
      const textPart = out.parts.find((p) => p.type === "text")
      const userText = textPart && "text" in textPart ? (textPart.text as string) : ""

      if (userText) {
        if (skillHarvester) {
          skillHarvester.setUserGoal(inp.sessionID, userText)
        }

        const enrichments: string[] = []

        // Retrieve relevant skills if enabled
        if (skillStore) {
          const matchedSkills = await skillStore.matchSkills(userText)
          const topSkills = matchedSkills.slice(0, cfg.maxInjectedSkills)
          if (topSkills.length > 0) {
            enrichments.push(
              `### Project DNA: Relevant Procedural Skills\n` +
                topSkills.map((s) => s.injectedGuideline).join("\n\n")
            )
          }
        }

        // Retrieve relevant Zettelkasten memory cards if enabled
        if (memoryStore) {
          const relevantCards = await memoryStore.queryRelevant(userText, cfg.maxInjectedNotes)
          if (relevantCards.length > 0) {
            enrichments.push(
              `### Project DNA: Interconnected Knowledge Cards\n` +
                relevantCards
                  .map(
                    (c) =>
                      `- [${c.category}] **${c.title}**: ${c.insight} (Tags: ${c.tags.join(", ")})`
                  )
                  .join("\n")
            )
          }
        }

        if (enrichments.length > 0) {
          out.parts.push({
            type: "text",
            text: `\n\n${enrichments.join("\n\n")}`,
          } as any)
        }
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
        `Project DNA is active [${activePillars}]: This agent autonomously writes, verifies, and reuses procedural skills, tools, and Zettelkasten memory notes. To create a new tool, you can write the TypeScript code directly via 'register_live_tool' (fastest, zero background LLM latency) or delegate synthesis via 'synthesize_live_tool'.`
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
      switch (ev.type) {
        case "EventSessionIdle": {
          const sessionID = ev.sessionID

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
                  }
                } catch {
                  // Synthesis failure non-blocking
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
            } catch {
              // Non-blocking
            }
          }

          break
        }

        case "EventSessionError": {
          if (diagnosticBank) {
            await diagnosticBank.recordFailure({
              sessionID: ev.sessionID,
              rawError: ev.error ?? "Session runtime error",
              resolved: false,
            })
          }
          break
        }

        case "EventCommandExecuted": {
          if (diagnosticBank && ev.exitCode !== 0) {
            await diagnosticBank.recordFailure({
              sessionID: ev.sessionID ?? "global",
              command: ev.command,
              rawError: ev.output ?? `Command exited with code ${ev.exitCode}`,
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
