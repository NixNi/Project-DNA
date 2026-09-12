/**
 * LiveTools Meta-Tools Factory
 * Registers meta-tools for synthesizing, registering, invoking, listing,
 * unregistering, and reloading autonomous LiveTools.
 */

import { tool } from "@opencode-ai/plugin/tool"
import { z } from "zod"
import { randomUUID } from "node:crypto"
import type { ToolPackageMetadata } from "../../specs/contracts/live-tools.js"
import type { LiveToolRegistry } from "./tool-registry.js"
import type { LiveToolMaker } from "./tool-maker.js"
import type { PluginNotifier } from "../core/notifier.js"

export interface LiveMetaToolsContext {
  toolMaker: LiveToolMaker
  toolRegistry: LiveToolRegistry
  liveToolsMap: Record<string, unknown>
  notifier: PluginNotifier
}

export function incrementPatch(version: string): string {
  const parts = version.split(".").map(Number)
  if (parts.length === 3 && parts.every((n) => !isNaN(n))) {
    return `${parts[0]}.${parts[1]}.${parts[2] + 1}`
  }
  return "1.0.1"
}

export function createLiveMetaTools(ctx: LiveMetaToolsContext): Record<string, unknown> {
  const { toolMaker, toolRegistry, liveToolsMap, notifier } = ctx
  const schema = tool.schema ?? z
  const metaTools: Record<string, unknown> = {}

  // 1. Synthesize meta-tool: Allows the agent to synthesize, verify, and hot-load new tools
  metaTools["synthesize_live_tool"] = tool({
    description:
      "Synthesizes a new reusable TypeScript tool or registers a model-authored implementation, validates its AST security, verifies it in an isolated test sandbox, and hot-loads it immediately into OpenCode. Note: Provide explicit sampleInputs if your tool expects specific parameter formats, as auto-generated parameters use generic placeholders that may not work for specialized validation.",
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
        .describe(
          "Optional representative inputs for test verification. If omitted, mock inputs are automatically synthesized from the tool's args schema. WARNING: Auto-generated parameters use generic placeholders (e.g. 'test', 1, [1], true) which may produce invalid parameters that fail verification if your tool expects specific formats (e.g. valid file paths, URLs, regex constraints). Always provide explicit sampleInputs when your tool has specific parameter requirements."
        ),
      expectedOutputs: schema
        .array(schema.any())
        .optional()
        .describe("Expected outputs corresponding to the sample inputs"),
    } as any,
    async execute(args: any) {
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

  // 2. Direct meta-tool: Allows the agent to directly submit model-authored tools with zero LLM sub-session latency
  metaTools["register_live_tool"] = tool({
    description:
      "Directly registers a model-authored TypeScript tool into OpenCode with zero background LLM latency. Validates AST security, verifies in isolated subprocess sandbox, and hot-loads into the live registry. Tool source must use 'args: { ... }' with zod schemas (do not use 'input: z.object'). Unit tests automatically resolve relative imports. Note: If sampleInputs is omitted, generic mock inputs are auto-generated from the schema, but generic values ('test', 1, [1]) may generate invalid parameters that fail verification if your tool requires specific formats (e.g. valid file paths, URLs, regex constraints); provide explicit sampleInputs in those cases.",
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
        .describe(
          "Optional representative inputs for automated verification test. If omitted, mock inputs are automatically synthesized from the tool's args schema. WARNING: Auto-generated parameters use generic placeholders (e.g. 'test', 1, [1], true) which may produce invalid parameters that fail verification if your tool expects specific formats (e.g. valid file paths, URLs, positive integers, non-empty arrays with specific elements, or regex matches). Always provide explicit sampleInputs when your tool has specific parameter requirements."
        ),
    } as any,
    async execute(args: any) {
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

  // 3. Dispatcher meta-tool: Guarantees 100% LLM KV cache preservation by executing tools via fixed gateway
  metaTools["invoke_live_tool"] = tool({
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
      const toolName = String(callArgs.toolName)
      const toolArgs =
        callArgs.args && typeof callArgs.args === "object" ? callArgs.args : {}
      return (await toolRegistry.invokeTool(toolName, toolArgs, context)) as any
    },
  })

  // 4. Catalog meta-tool: Inspect available synthesized tools without altering prompt prefix
  metaTools["list_live_tools"] = tool({
    description:
      "Lists all active synthesized and registered LiveTools, their descriptions, expected parameter schemas, and health telemetry without mutating the LLM prompt prefix.",
    args: {} as any,
    async execute() {
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

  // 5. Unregister meta-tool: Clean eviction of broken, degraded, or duplicate zombie tools
  metaTools["unregister_live_tool"] = tool({
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

  // 6. Reload meta-tool: Refreshes active tools from registry.json and disk, synchronizing liveToolsMap
  metaTools["reload_live_tools"] = tool({
    description:
      "Reloads all active LiveTools from disk and registry.json, invalidates module caches using fresh versioned entrypoints, and synchronizes the live execution registry. Use this after manual file edits, external updates, or to recover stale tool references without restarting OpenCode.",
    args: {} as any,
    async execute() {
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

  return metaTools
}
