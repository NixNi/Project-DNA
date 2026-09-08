/**
 * Project DNA — Main OpenCode Plugin Entry Point
 * Self-synthesizing LiveTools, LiveSkills, and LiveMemory (A-Mem) for OpenCode
 */

import type { Plugin, Hooks } from "@opencode-ai/plugin"
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
  const llmBridge = new OpenCodeLLMBridge(input.client)

  // 3. Initialize LiveMemory Subsystem
  const memoryStore = new MemoryStore(db)
  await memoryStore.init()
  const linkGenerator = new DynamicLinkGenerator(llmBridge)
  const diagnosticBank = new DiagnosticBank()

  // 4. Initialize LiveTools Subsystem
  const toolRegistry = new LiveToolRegistry(configManager.toolsDir)
  await toolRegistry.loadActiveTools()
  const toolMaker = new LiveToolMaker(llmBridge, input.directory, configManager.toolsDir)

  // 5. Initialize LiveSkills Subsystem
  const skillHarvester = new LiveSkillHarvester()
  const skillDistiller = new LiveSkillDistiller(llmBridge)
  const skillStore = new LiveSkillStore(
    configManager.activeSkillsDir,
    configManager.stagedSkillsDir,
    configManager.archivedSkillsDir
  )
  await skillStore.loadActiveSkills()

  // 6. Assemble OpenCode Hooks
  const hooks: Hooks = {
    // Dynamic Tool Registry exposed to OpenCode
    tool: toolRegistry.getToolMap() as any,

    // Dynamic schema & description mutation
    "tool.definition": async (inp, out) => {
      const meta = toolRegistry.getMetadata(inp.toolID)
      if (meta) {
        out.description = meta.description
        if (meta.parameters && Object.keys(meta.parameters).length > 0) {
          out.parameters = meta.parameters
        }
      }
    },

    // Execution Interception: Step buffering & intent capture
    "tool.execute.before": async (inp) => {
      skillHarvester.recordStep(inp.sessionID, {
        tool: inp.tool,
        args: inp.args ?? {},
        output: "",
        timestamp: new Date().toISOString(),
      })
    },

    // Execution Interception: Telemetry, Error detection, and Recovery logging
    "tool.execute.after": async (inp, out) => {
      const isError = /error|failed|exception/i.test(out.output ?? "")
      const durationMs = 100 // Estimate if not directly provided

      if (toolRegistry.isLiveTool(inp.tool)) {
        await toolRegistry.recordExecution(inp.tool, !isError, durationMs)
      }

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
    },

    // Chat Message Hook: Context enrichment with Top-K Memory Cards & Relevant Skills
    "chat.message": async (inp, out) => {
      const textPart = out.parts.find((p) => p.type === "text")
      const userText = textPart && "text" in textPart ? (textPart.text as string) : ""

      if (userText) {
        skillHarvester.setUserGoal(inp.sessionID, userText)

        // Retrieve relevant skills
        const matchedSkills = await skillStore.matchSkills(userText)
        const topSkills = matchedSkills.slice(0, cfg.maxInjectedSkills)

        // Retrieve relevant Zettelkasten memory cards
        const relevantCards = await memoryStore.queryRelevant(userText, cfg.maxInjectedNotes)

        const enrichments: string[] = []

        if (topSkills.length > 0) {
          enrichments.push(
            `### Project DNA: Relevant Procedural Skills\n` +
              topSkills.map((s) => s.injectedGuideline).join("\n\n")
          )
        }

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
      out.system.push(
        "Project DNA is active: This agent autonomously writes, verifies, and reuses procedural skills, tools, and Zettelkasten memory notes."
      )
    },

    // Compaction Hook: Preserves uncompacted session state across context window truncation
    "experimental.session.compacting": async (inp, out) => {
      const sessionNotes = await memoryStore.getNotesForSession(inp.sessionID)
      const activeDiagnostics = await diagnosticBank.getActiveDiagnostics(inp.sessionID)

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
          // Agent turn is idle: prime moment for background synthesis!
          const sessionID = ev.sessionID

          // 1. Check if session trajectory is eligible for skill harvesting
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

          // 2. Distill resolved diagnostics into permanent knowledge notes
          try {
            await diagnosticBank.distillToMemory(memoryStore)
          } catch {
            // Non-blocking
          }

          break
        }

        case "EventSessionError": {
          await diagnosticBank.recordFailure({
            sessionID: ev.sessionID,
            rawError: ev.error ?? "Session runtime error",
            resolved: false,
          })
          break
        }

        case "EventCommandExecuted": {
          if (ev.exitCode !== 0) {
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
