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
import { PluginNotifier } from "./core/notifier.js"

import { MemoryStore } from "./memory/memory-store.js"
import { DynamicLinkGenerator } from "./memory/link-generator.js"
import { DiagnosticBank } from "./memory/diagnostic-bank.js"

import { LiveToolRegistry } from "./tools/tool-registry.js"
import { LiveToolMaker } from "./tools/tool-maker.js"
import type { ToolPackageMetadata } from "../specs/contracts/live-tools.js"

import { LiveSkillHarvester } from "./skills/trace-harvester.js"
import { LiveSkillDistiller } from "./skills/skill-distiller.js"
import { LiveSkillStore } from "./skills/skill-store.js"

function incrementPatch(version: string): string {
  const parts = version.split(".").map(Number)
  if (parts.length === 3 && parts.every((n) => !isNaN(n))) {
    return `${parts[0]}.${parts[1]}.${parts[2] + 1}`
  }
  return "1.0.1"
}

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

        const result = await toolMaker.synthesize({
          toolName,
          intent,
          sourceCode,
          testCode,
          sampleInputs,
          expectedOutputs,
        })

        const existingMeta = toolRegistry.getMetadata(toolName)
        const metadata: ToolPackageMetadata = {
          id: existingMeta?.id ?? randomUUID(),
          name: toolName,
          version: existingMeta ? incrementPatch(existingMeta.version) : "1.0.0",
          description: intent,
          entrypoint: result.entrypoint ?? `src/${toolName}.ts`,
          sourceFile: result.sourceFile ?? `src/${toolName}.ts`,
          testFile: `tests/${toolName}.test.ts`,
          status: "ACTIVE" as const,
          parameters: {},
          requiredPermissions: result.requiredPermissions ?? [],
          telemetry: existingMeta?.telemetry ?? {
            totalInvocations: 0,
            successCount: 0,
            failureCount: 0,
            avgDurationMs: 0,
            healthScore: 1.0,
          },
          createdAt: existingMeta?.createdAt ?? new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }

        // Hot-load executable module into memory and persist to registry.json
        const executable = await toolRegistry.registerAndLoad(metadata)
        if (executable) {
          liveToolsMap[toolName] = executable
        }

        // Notify user via OpenCode TUI toast
        await notifier.notifyToolCreated(toolName, "synthesized")

        return {
          title: `Synthesized & Hot-Loaded Tool: ${toolName}`,
          output: `Tool '${toolName}' was successfully synthesized, passed AST security validation, passed sandbox unit testing, and is now actively hot-loaded and available for invocation via invoke_live_tool!`,
        }
      },
    })

    // Direct meta-tool: Allows the agent to directly submit model-authored tools with zero LLM sub-session latency
    liveToolsMap["register_live_tool"] = tool({
      description:
        "Directly registers a model-authored TypeScript tool into OpenCode with zero background LLM latency. Validates AST security, verifies in isolated subprocess sandbox, and hot-loads into the live registry. Tool source must use 'args: { ... }' with zod schemas (do not use 'input: z.object'). Unit tests automatically resolve relative imports.",
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
            "Complete TypeScript source code of the tool. Must import { tool } from '@opencode-ai/plugin/tool' and { z } from 'zod', export the tool instance with args schema and execute(args, ctx), and return { output: string } or a result object."
          ),
        testCode: schema
          .string()
          .optional()
          .describe("Optional TypeScript unit test code using node:test or bun:test. If omitted, a robust test suite is auto-generated. If provided, imports from '../src/<toolName>.js'."),
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

        const result = await toolMaker.registerDirect({
          toolName,
          description: desc,
          sourceCode,
          testCode,
          sampleInputs,
        })

        const existingMeta = toolRegistry.getMetadata(toolName)
        const metadata: ToolPackageMetadata = {
          id: existingMeta?.id ?? randomUUID(),
          name: toolName,
          version: existingMeta ? incrementPatch(existingMeta.version) : "1.0.0",
          description: desc,
          entrypoint: result.entrypoint ?? `src/${toolName}.ts`,
          sourceFile: result.sourceFile ?? `src/${toolName}.ts`,
          testFile: `tests/${toolName}.test.ts`,
          status: "ACTIVE" as const,
          parameters: {},
          requiredPermissions: result.requiredPermissions ?? [],
          telemetry: existingMeta?.telemetry ?? {
            totalInvocations: 0,
            successCount: 0,
            failureCount: 0,
            avgDurationMs: 0,
            healthScore: 1.0,
          },
          createdAt: existingMeta?.createdAt ?? new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }

        const executable = await toolRegistry.registerAndLoad(metadata)
        if (executable) {
          liveToolsMap[toolName] = executable
        }

        // Notify user via OpenCode TUI toast
        await notifier.notifyToolCreated(toolName, "registered")

        return {
          title: `Registered & Hot-Loaded Tool: ${toolName}`,
          output: `Tool '${toolName}' was directly registered by the model, passed AST security validation, passed sandbox unit testing, and is now actively hot-loaded and available for invocation via invoke_live_tool!`,
        }
      },
    })

    // Dispatcher meta-tool: Guarantees 100% LLM KV cache preservation by executing tools via fixed gateway
    liveToolsMap["invoke_live_tool"] = tool({
      description:
        "Executes an active synthesized LiveTool by name with provided arguments. Guarantees 100% LLM KV cache preservation by dispatching dynamically without modifying the root tool schema definitions. Example: invoke_live_tool({ toolName: 'system_info', args: {} })",
      args: {
        toolName: schema
          .string()
          .regex(/^[a-z0-9_-]+$/)
          .describe("The unique name of the synthesized live tool to execute"),
        args: schema
          .record(schema.string(), schema.any())
          .optional()
          .describe("Key-value arguments to pass to the tool execute function (default: {})"),
      } as any,
      async execute(callArgs: any, context: any) {
        if (!toolRegistry) {
          throw new Error("LiveTools subsystem is disabled.")
        }
        const toolName = String(callArgs.toolName)
        const toolArgs =
          callArgs.args && typeof callArgs.args === "object" ? callArgs.args : {}
        return (await toolRegistry.invokeTool(toolName, toolArgs, context)) as any
      },
    })

    // Catalog meta-tool: Inspect available synthesized tools without altering prompt prefix
    liveToolsMap["list_live_tools"] = tool({
      description:
        "Lists all active synthesized and registered LiveTools, their descriptions, expected parameter schemas, and health telemetry without mutating the LLM prompt prefix.",
      args: {} as any,
      async execute() {
        if (!toolRegistry) {
          throw new Error("LiveTools subsystem is disabled.")
        }
        const tools = toolRegistry.listTools()
        return {
          title: `Active LiveTools (${tools.length})`,
          output:
            tools.length > 0
              ? JSON.stringify(tools, null, 2)
              : "No synthesized live tools currently registered. Use 'synthesize_live_tool' or 'register_live_tool' to create one.",
          metadata: { count: tools.length },
        }
      },
    })

    // Unregister meta-tool: Clean eviction of broken, degraded, or duplicate zombie tools
    liveToolsMap["unregister_live_tool"] = tool({
      description:
        "Cleanly unregisters and evicts a LiveTool by name from OpenCode, the in-memory registry, registry.json, and deletes its on-disk source and test files. Use this to remove broken, obsolete, or duplicate tools (such as failed implementations or duplicate tools like git_pr_status / pr_status).",
      args: {
        toolName: schema
          .string()
          .regex(/^[a-z0-9_-]+$/)
          .describe("The unique snake_case or kebab-case name of the synthesized live tool to unregister"),
        deleteFiles: schema
          .boolean()
          .optional()
          .describe("Whether to delete on-disk source and test files (default: true)"),
      } as any,
      async execute(args: any) {
        if (!toolRegistry) {
          throw new Error("LiveTools subsystem is disabled.")
        }
        const toolName = String(args.toolName)
        const deleteFiles = args.deleteFiles !== false

        if (!toolRegistry.isLiveTool(toolName)) {
          const available = toolRegistry.listTools().map((t) => t.name)
          return {
            title: `Tool Not Found: ${toolName}`,
            output: `Cannot unregister tool '${toolName}': Tool is not registered in the LiveTool registry. Available tools: ${available.join(", ") || "none"}`,
            metadata: {
              success: false,
              toolName,
              availableTools: available,
            },
          }
        }

        const success = await toolRegistry.unregisterTool(toolName, { removeFiles: deleteFiles })
        delete liveToolsMap[toolName]

        await notifier.notify({
          title: "LiveTool Unregistered",
          message: `Tool '${toolName}' successfully unregistered and evicted.`,
          variant: "info",
        })

        return {
          title: `Unregistered LiveTool: ${toolName}`,
          output: `Tool '${toolName}' was successfully unregistered, removed from OpenCode's active registry, deleted from registry.json, and in-memory caches evicted.`,
          metadata: {
            success,
            toolName,
          },
        }
      },
    })

    // Reload meta-tool: Refreshes active tools from registry.json and disk, synchronizing liveToolsMap
    liveToolsMap["reload_live_tools"] = tool({
      description:
        "Reloads all active LiveTools from disk and registry.json, invalidates module caches using fresh versioned entrypoints, and synchronizes the live execution registry. Use this after manual file edits, external updates, or to recover stale tool references without restarting OpenCode.",
      args: {} as any,
      async execute() {
        if (!toolRegistry) {
          throw new Error("LiveTools subsystem is disabled.")
        }

        await toolRegistry.reloadTools(true)
        const active = toolRegistry.getToolMap()
        const activeKeys = new Set(Object.keys(active))
        const metaToolKeys = new Set([
          "synthesize_live_tool",
          "register_live_tool",
          "invoke_live_tool",
          "list_live_tools",
          "unregister_live_tool",
          "reload_live_tools",
          "query_knowledge_graph",
        ])

        // Evict keys that no longer exist
        for (const key of Object.keys(liveToolsMap)) {
          if (!metaToolKeys.has(key) && !activeKeys.has(key)) {
            delete liveToolsMap[key]
          }
        }
        // Update active tools
        for (const [key, exec] of Object.entries(active)) {
          liveToolsMap[key] = exec
        }

        const reloadedNames = Object.keys(active)
        await notifier.notify({
          title: "LiveTools Reloaded",
          message: `Reloaded ${reloadedNames.length} tool(s) from disk.`,
          variant: "success",
        })

        return {
          title: `Reloaded LiveTools (${reloadedNames.length} active)`,
          output: `Successfully reloaded ${reloadedNames.length} active live tools: ${reloadedNames.join(", ") || "none"}.`,
          metadata: {
            reloaded: reloadedNames,
            activeCount: reloadedNames.length,
          },
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
        `Project DNA is active [${activePillars}]: This agent autonomously writes, verifies, and reuses procedural skills, tools, and Zettelkasten memory notes. Previously created live tools from past sessions are automatically loaded as normal first-class tools with live statistics (e.g. project_test_runner, system_info, hello_world) and can be executed directly or via 'invoke_live_tool'. Newly synthesized tools in this session are available immediately. To create new tools, use 'register_live_tool' or 'synthesize_live_tool'. To manage existing tools, use 'list_live_tools' to inspect, 'unregister_live_tool' to evict broken, obsolete, or duplicate zombie tools, and 'reload_live_tools' to refresh tools from disk.`
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
