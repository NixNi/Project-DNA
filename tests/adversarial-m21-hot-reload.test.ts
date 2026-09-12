/**
 * Empirical Challenger Test Suite — Milestone 2.1: ESM Hot-Reloading, Eviction, & Isolation
 *
 * Challenger: teamwork_preview_challenger_m21_2 (Challenger 2)
 *
 * Scope:
 * 1. ESM Hot-Reloading & Cache Invalidation:
 *    - Re-registration with mutated return values immediately executes NEW code without stale cache.
 *    - Multiple rapid version mutations (v1 -> v2 -> v3).
 *    - Telemetry continuity across re-registrations.
 *    - On-disk versioned entrypoint cleanup.
 * 2. Complete Eviction via unregister_live_tool:
 *    - 5-domain eviction: in-memory toolsMap, runtime dispatch, telemetry maps, registry.json, and physical disk files.
 *    - Subsequent invocations cleanly reject without zombie traces.
 *    - Graceful non-existent tool diagnostics.
 *    - Preservation of protected meta-tools against unregistration.
 * 3. Disk Synchronization via reload_live_tools:
 *    - Picking up manual/external edits from disk into fresh versioned entrypoints.
 *    - Purging tools removed externally from registry.json.
 *    - Absolute preservation of protected meta-tools.
 * 4. Multi-Registry Instance Isolation:
 *    - Preventing closure poisoning across distinct LiveToolRegistry instances.
 *    - Telemetry isolation when executing the same module in different registries.
 *    - Direct wrapped executable delegation layer isolation.
 *    - Independent turn tracking across instances.
 */

import { describe, it, before, after } from "node:test"
import assert from "node:assert"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { randomUUID } from "node:crypto"

import { ProjectDNAPlugin } from "../src/index.js"
import { LiveToolRegistry } from "../src/tools/tool-registry.js"
import type { ToolPackageMetadata } from "../specs/contracts/live-tools.js"

describe("Empirical Adversarial Challenge: Milestone 2.1 Hot-Reload, Eviction, and Isolation", () => {
  const testWorkspace = path.resolve(`./test-adversarial-m21-${randomUUID().slice(0, 8)}`)
  const toolsDir = path.join(testWorkspace, ".opencode", "dna", "tools")

  const toasts: any[] = []
  const mockClient: any = {
    tui: {
      showToast: async (opts: any) => {
        toasts.push(opts)
        return true
      },
    },
    config: {
      get: async () => ({
        data: {
          model: { providerID: "test-provider", modelID: "test-model" },
          small_model: { providerID: "test-provider", modelID: "test-small-model" },
        },
      }),
    },
    session: {
      create: async () => ({ data: { id: "mock-session-m21" } }),
      prompt: async () => ({
        data: { parts: [{ type: "text", text: "{}" }] },
      }),
      delete: async () => ({}),
    },
  }

  const mockInput: any = {
    client: mockClient,
    directory: testWorkspace,
    worktree: testWorkspace,
    project: { id: "test-m21-project" },
    serverUrl: new URL("http://localhost:3000"),
    $: {} as any,
  }

  let hooks: any

  before(async () => {
    await fs.mkdir(testWorkspace, { recursive: true })
    hooks = await ProjectDNAPlugin(mockInput, {})
  })

  after(async () => {
    if (hooks?.dispose) {
      await hooks.dispose().catch(() => {})
    }
    await fs.rm(testWorkspace, { recursive: true, force: true }).catch(() => {})
  })

  // =========================================================================
  // PILLAR 1: ESM Hot-Reloading & Cache Invalidation
  // =========================================================================
  describe("Pillar 1: ESM Hot-Reloading & Cache Invalidation", () => {
    it("[HOT-RELOAD-01] Re-registering with mutated logic executes NEW code immediately without stale cache", async () => {
      const registerTool = hooks.tool["register_live_tool"]
      const invokeTool = hooks.tool["invoke_live_tool"]

      assert.ok(registerTool, "register_live_tool meta-tool must exist")
      assert.ok(invokeTool, "invoke_live_tool meta-tool must exist")

      const toolName = "dynamic_calculator"

      // Version 1: Addition (a + b)
      const v1Source = `
import { tool } from "@opencode-ai/plugin/tool"
import { z } from "zod"

export const ${toolName} = tool({
  description: "Dynamic math calculator - v1",
  args: {
    a: z.number().describe("First number"),
    b: z.number().describe("Second number"),
  },
  async execute(args) {
    return { output: "v1_sum: " + (args.a + args.b) }
  }
})
`
      const regRes1 = await registerTool.execute({
        toolName,
        description: "Dynamic math calculator - v1",
        sourceCode: v1Source,
      })
      assert.ok(regRes1.output.includes("actively hot-loaded"), "V1 must register and hot-load")

      // Execute V1 via invoke_live_tool
      const inv1 = await invokeTool.execute({
        toolName,
        args: { a: 10, b: 20 },
      })
      assert.strictEqual(inv1.output, "v1_sum: 30", "V1 invocation must return sum (10 + 20 = 30)")

      // Execute V1 directly via hooks.tool
      const direct1 = await hooks.tool[toolName].execute({ a: 10, b: 20 })
      assert.strictEqual(direct1.output, "v1_sum: 30", "Direct V1 invocation must return sum (30)")

      // Small delay to ensure timestamp monotonic step
      await new Promise((r) => setTimeout(r, 15))

      // Version 2: Multiplication (a * b)
      const v2Source = `
import { tool } from "@opencode-ai/plugin/tool"
import { z } from "zod"

export const ${toolName} = tool({
  description: "Dynamic math calculator - v2",
  args: {
    a: z.number().describe("First number"),
    b: z.number().describe("Second number"),
  },
  async execute(args) {
    return { output: "v2_product: " + (args.a * args.b) }
  }
})
`
      const regRes2 = await registerTool.execute({
        toolName,
        description: "Dynamic math calculator - v2",
        sourceCode: v2Source,
      })
      assert.ok(regRes2.output.includes("actively hot-loaded"), "V2 must register and hot-load")

      // CRITICAL PROOF: invoke_live_tool MUST execute V2 logic immediately (200), not stale V1 (30)
      const inv2 = await invokeTool.execute({
        toolName,
        args: { a: 10, b: 20 },
      })
      assert.strictEqual(
        inv2.output,
        "v2_product: 200",
        "invoke_live_tool must immediately execute NEW V2 code (10 * 20 = 200) without stale cache"
      )

      // CRITICAL PROOF: direct hooks.tool execution MUST ALSO execute V2 logic immediately
      const direct2 = await hooks.tool[toolName].execute({ a: 10, b: 20 })
      assert.strictEqual(
        direct2.output,
        "v2_product: 200",
        "direct execution must immediately execute NEW V2 code (10 * 20 = 200)"
      )

      // Small delay for third mutation
      await new Promise((r) => setTimeout(r, 15))

      // Version 3: Exponentiation (a ** b)
      const v3Source = `
import { tool } from "@opencode-ai/plugin/tool"
import { z } from "zod"

export const ${toolName} = tool({
  description: "Dynamic math calculator - v3",
  args: {
    a: z.number().describe("First number"),
    b: z.number().describe("Second number"),
  },
  async execute(args) {
    return { output: "v3_power: " + Math.pow(args.a, args.b) }
  }
})
`
      await registerTool.execute({
        toolName,
        description: "Dynamic math calculator - v3",
        sourceCode: v3Source,
      })

      const inv3 = await invokeTool.execute({
        toolName,
        args: { a: 2, b: 8 },
      })
      assert.strictEqual(
        inv3.output,
        "v3_power: 256",
        "Third re-registration must execute NEW V3 code (2^8 = 256)"
      )

      const direct3 = await hooks.tool[toolName].execute({ a: 2, b: 8 })
      assert.strictEqual(direct3.output, "v3_power: 256")

      // Verify Telemetry Continuity: invocations across all 3 versions must accumulate
      // (1 on v1 + 1 direct v1 + 1 on v2 + 1 direct v2 + 1 on v3 + 1 direct v3 = 6 invocations)
      assert.strictEqual(
        direct3.metadata.telemetry.totalInvocations,
        6,
        "Telemetry totalInvocations must accumulate continuously across re-registrations"
      )
    })

    it("[HOT-RELOAD-02] Older versioned entrypoint files on disk are pruned to prevent filesystem leak", async () => {
      const srcDir = path.join(toolsDir, "src")
      const files = await fs.readdir(srcDir)
      const toolName = "dynamic_calculator"

      const versionedFiles = files.filter(
        (f) => f.startsWith(`${toolName}.v`) && f.endsWith(".ts")
      )
      const canonicalFile = `${toolName}.ts`

      assert.ok(files.includes(canonicalFile), "Canonical file dynamic_calculator.ts must exist")
      assert.strictEqual(
        versionedFiles.length,
        1,
        `Expected exactly 1 active versioned file, found ${versionedFiles.length}: ${versionedFiles.join(", ")}`
      )
    })

    it("[HOT-RELOAD-03] Schema mutation (new parameters and return format) hot-loads dynamically", async () => {
      const registerTool = hooks.tool["register_live_tool"]
      const invokeTool = hooks.tool["invoke_live_tool"]
      const toolName = "schema_mutation_tool"

      // Version 1: single parameter
      const s1 = `
import { tool } from "@opencode-ai/plugin/tool"
import { z } from "zod"

export const ${toolName} = tool({
  description: "Schema mutation test v1",
  args: {
    message: z.string().describe("Input text message")
  },
  async execute(args) {
    return { output: "echo: " + args.message }
  }
})
`
      await registerTool.execute({
        toolName,
        description: "Schema mutation test v1",
        sourceCode: s1,
        sampleInputs: [{ message: "init" }],
      })

      const res1 = await invokeTool.execute({
        toolName,
        args: { message: "hello" },
      })
      assert.strictEqual(res1.output, "echo: hello")

      await new Promise((r) => setTimeout(r, 15))

      // Version 2: new parameters (prefix, uppercase) and structured return object
      const s2 = `
import { tool } from "@opencode-ai/plugin/tool"
import { z } from "zod"

export const ${toolName} = tool({
  description: "Schema mutation test v2",
  args: {
    message: z.string().describe("Input text message"),
    prefix: z.string().optional().describe("Optional prefix"),
    uppercase: z.boolean().optional().describe("Convert to uppercase")
  },
  async execute(args) {
    const raw = args.message || ""
    let msg = args.prefix ? args.prefix + " " + raw : raw
    if (args.uppercase) msg = msg.toUpperCase()
    return {
      output: msg,
      metadata: { length: msg.length, transformed: true }
    }
  }
})
`
      await registerTool.execute({
        toolName,
        description: "Schema mutation test v2",
        sourceCode: s2,
        sampleInputs: [{ message: "sample" }],
      })

      const res2 = await invokeTool.execute({
        toolName,
        args: { message: "world", prefix: "brave new", uppercase: true },
      })
      assert.strictEqual(res2.output, "BRAVE NEW WORLD")
      assert.strictEqual(res2.metadata.length, 15)
      assert.strictEqual(res2.metadata.transformed, true)

      // Verify list_live_tools reflects updated parameter schemas
      const listTool = hooks.tool["list_live_tools"]
      const listRes = await listTool.execute({})
      assert.ok(listRes.output.includes(toolName))
      assert.ok(listRes.output.includes("uppercase"))
      assert.ok(listRes.output.includes("prefix"))
    })
  })

  // =========================================================================
  // PILLAR 2: Complete Eviction via unregister_live_tool
  // =========================================================================
  describe("Pillar 2: Complete Eviction via unregister_live_tool", () => {
    it("[UNREG-01] 5-domain complete eviction: memory, runtime, telemetry, registry.json, and physical files", async () => {
      const registerTool = hooks.tool["register_live_tool"]
      const unregisterTool = hooks.tool["unregister_live_tool"]
      const toolName = "zombie_eradication_target"

      const sourceCode = `
import { tool } from "@opencode-ai/plugin/tool"
import { z } from "zod"

export const ${toolName} = tool({
  description: "Target to be completely eradicated",
  args: { dummy: z.string().optional() },
  async execute(args) {
    return { output: "still alive" }
  }
})
`
      await registerTool.execute({
        toolName,
        description: "Target to be completely eradicated",
        sourceCode,
      })

      // Execute once to populate telemetry and turn tracking
      await hooks.tool[toolName].execute({})
      assert.ok(hooks.tool[toolName], "Tool must be attached to runtime hooks.tool")

      const canonicalSrc = path.join(toolsDir, "src", `${toolName}.ts`)
      const testFile = path.join(toolsDir, "tests", `${toolName}.test.ts`)
      await assert.doesNotReject(async () => fs.stat(canonicalSrc))
      await assert.doesNotReject(async () => fs.stat(testFile))

      // Execute unregister
      const unregRes = await unregisterTool.execute({ toolName })
      assert.strictEqual(unregRes.metadata.success, true)
      assert.strictEqual(unregRes.title, `Unregistered LiveTool: ${toolName}`)

      // Domain 1: Evicted from runtime hooks.tool
      assert.strictEqual(
        hooks.tool[toolName],
        undefined,
        "Tool must be completely removed from hooks.tool dispatcher"
      )

      // Domain 2: Evicted from registry.json
      const regJson = JSON.parse(await fs.readFile(path.join(toolsDir, "registry.json"), "utf-8"))
      assert.strictEqual(
        regJson.find((t: any) => t.name === toolName),
        undefined,
        "Tool must be absent from registry.json"
      )

      // Domain 3: Evicted from physical disk (canonical file, versioned files, test files)
      await assert.rejects(async () => fs.stat(canonicalSrc), { code: "ENOENT" })
      await assert.rejects(async () => fs.stat(testFile), { code: "ENOENT" })

      const srcDir = path.join(toolsDir, "src")
      const files = await fs.readdir(srcDir)
      const versionedFiles = files.filter((f) => f.startsWith(`${toolName}.`))
      assert.strictEqual(
        versionedFiles.length,
        0,
        `All versioned files matching ${toolName} must be deleted`
      )
    })

    it("[UNREG-02] Subsequent invocations cleanly reject without zombie execution traces", async () => {
      const invokeTool = hooks.tool["invoke_live_tool"]
      const listTool = hooks.tool["list_live_tools"]
      const toolName = "zombie_eradication_target"

      // invoke_live_tool must reject with clear explanatory error
      await assert.rejects(
        async () => {
          await invokeTool.execute({ toolName, args: {} })
        },
        (err: any) => {
          return (
            err instanceof Error &&
            err.message.includes(`Live tool '${toolName}' is not registered`)
          )
        },
        "Subsequent invocation must reject cleanly with not registered error"
      )

      // list_live_tools must NOT contain any trace of the uninstalled tool
      const listRes = await listTool.execute({})
      assert.ok(
        !listRes.output.includes(toolName),
        "Evicted tool must not appear in list_live_tools"
      )
    })

    it("[UNREG-03] Unregistering non-existent tool returns informative diagnostic output without crash", async () => {
      const unregisterTool = hooks.tool["unregister_live_tool"]
      const res = await unregisterTool.execute({ toolName: "non_existent_ghost_tool" })

      assert.strictEqual(res.metadata.success, false)
      assert.ok(res.title.includes("Tool Not Found"))
      assert.ok(res.output.includes("is not registered in the LiveTool registry"))
      assert.ok(Array.isArray(res.metadata.availableTools))
    })

    it("[UNREG-04] unregisterTool with deleteFiles: false preserves source files while evicting from registry", async () => {
      const registerTool = hooks.tool["register_live_tool"]
      const unregisterTool = hooks.tool["unregister_live_tool"]
      const toolName = "keep_files_archive_target"

      const sourceCode = `
import { tool } from "@opencode-ai/plugin/tool"
import { z } from "zod"

export const ${toolName} = tool({
  description: "Keep files test",
  args: {},
  async execute() { return { output: "preserved" } }
})
`
      await registerTool.execute({
        toolName,
        description: "Keep files test",
        sourceCode,
      })

      const canonicalSrc = path.join(toolsDir, "src", `${toolName}.ts`)
      await assert.doesNotReject(async () => fs.stat(canonicalSrc))

      // Unregister with deleteFiles = false
      const unregRes = await unregisterTool.execute({ toolName, deleteFiles: false })
      assert.strictEqual(unregRes.metadata.success, true)

      // Evicted from runtime
      assert.strictEqual(hooks.tool[toolName], undefined)

      // Physical canonical file is preserved on disk
      await assert.doesNotReject(
        async () => fs.stat(canonicalSrc),
        "Canonical file must be preserved when deleteFiles: false"
      )
    })

    it("[UNREG-05] Protected meta-tools cannot be unregistered by unregister_live_tool", async () => {
      const unregisterTool = hooks.tool["unregister_live_tool"]
      const protectedNames = [
        "unregister_live_tool",
        "reload_live_tools",
        "invoke_live_tool",
        "synthesize_live_tool",
        "register_live_tool",
        "list_live_tools",
      ]

      for (const metaName of protectedNames) {
        const res = await unregisterTool.execute({ toolName: metaName })
        assert.strictEqual(
          res.metadata.success,
          false,
          `Meta-tool '${metaName}' must reject unregistration`
        )
        assert.ok(
          hooks.tool[metaName],
          `Meta-tool '${metaName}' must remain attached to hooks.tool`
        )
      }
    })
  })

  // =========================================================================
  // PILLAR 3: Disk Synchronization via reload_live_tools
  // =========================================================================
  describe("Pillar 3: Disk Synchronization via reload_live_tools", () => {
    it("[RELOAD-01] External on-disk edit to canonical file is reloaded into fresh versioned entrypoint", async () => {
      const registerTool = hooks.tool["register_live_tool"]
      const reloadTools = hooks.tool["reload_live_tools"]
      const invokeTool = hooks.tool["invoke_live_tool"]
      const toolName = "disk_modified_worker"

      const initialSource = `
import { tool } from "@opencode-ai/plugin/tool"
import { z } from "zod"

export const ${toolName} = tool({
  description: "Tool to be modified on disk",
  args: {},
  async execute() { return { output: "initial on-disk state" } }
})
`
      await registerTool.execute({
        toolName,
        description: "Tool to be modified on disk",
        sourceCode: initialSource,
      })

      const resInitial = await invokeTool.execute({ toolName, args: {} })
      assert.strictEqual(resInitial.output, "initial on-disk state")

      // Small delay
      await new Promise((r) => setTimeout(r, 20))

      // Simulate external file modification on disk (e.g., git pull or external editor)
      const modifiedSource = `
import { tool } from "@opencode-ai/plugin/tool"
import { z } from "zod"

export const ${toolName} = tool({
  description: "Tool modified externally on disk",
  args: {},
  async execute() { return { output: "externally modified on-disk state [RELOADED]" } }
})
`
      const canonicalSrc = path.join(toolsDir, "src", `${toolName}.ts`)
      await fs.writeFile(canonicalSrc, modifiedSource, "utf-8")

      // Execute reload_live_tools
      const reloadRes = await reloadTools.execute({})
      assert.ok(reloadRes.title.includes("Reloaded LiveTools"))
      assert.ok(reloadRes.metadata.reloaded.includes(toolName))

      // Verify invoke_live_tool immediately executes the externally modified code
      const resAfter = await invokeTool.execute({ toolName, args: {} })
      assert.strictEqual(
        resAfter.output,
        "externally modified on-disk state [RELOADED]",
        "invoke_live_tool must immediately reflect external on-disk modification"
      )

      // Verify direct hooks.tool execution also executes updated code
      const directAfter = await hooks.tool[toolName].execute({})
      assert.strictEqual(
        directAfter.output,
        "externally modified on-disk state [RELOADED]",
        "Direct invocation must immediately reflect external on-disk modification"
      )
    })

    it("[RELOAD-02] External deletion from registry.json purges tool from memory and hooks.tool", async () => {
      const registerTool = hooks.tool["register_live_tool"]
      const reloadTools = hooks.tool["reload_live_tools"]
      const toolName = "external_json_purge_target"

      const source = `
import { tool } from "@opencode-ai/plugin/tool"
import { z } from "zod"

export const ${toolName} = tool({
  description: "Target to be purged from registry.json externally",
  args: {},
  async execute() { return { output: "transient" } }
})
`
      await registerTool.execute({
        toolName,
        description: "Target to be purged from registry.json externally",
        sourceCode: source,
      })
      assert.ok(hooks.tool[toolName], "Tool must be in hooks.tool")

      // Read registry.json, remove this tool, and write back
      const regPath = path.join(toolsDir, "registry.json")
      const list: ToolPackageMetadata[] = JSON.parse(await fs.readFile(regPath, "utf-8"))
      const filtered = list.filter((t) => t.name !== toolName)
      await fs.writeFile(regPath, JSON.stringify(filtered, null, 2), "utf-8")

      // Execute reload_live_tools
      await reloadTools.execute({})

      // Tool must be purged from hooks.tool
      assert.strictEqual(
        hooks.tool[toolName],
        undefined,
        "Tool removed from registry.json must be purged from hooks.tool on reload"
      )

      // invoke_live_tool must cleanly fail
      const invokeTool = hooks.tool["invoke_live_tool"]
      await assert.rejects(
        async () => {
          await invokeTool.execute({ toolName, args: {} })
        },
        (err: any) => err.message.includes(`Live tool '${toolName}' is not registered`)
      )
    })

    it("[RELOAD-03] reload_live_tools preserves all protected meta-tools without corruption", async () => {
      const reloadTools = hooks.tool["reload_live_tools"]
      await reloadTools.execute({})

      const requiredMetaTools = [
        "synthesize_live_tool",
        "register_live_tool",
        "invoke_live_tool",
        "list_live_tools",
        "unregister_live_tool",
        "reload_live_tools",
      ]

      for (const metaName of requiredMetaTools) {
        const metaTool = hooks.tool[metaName]
        assert.ok(metaTool, `Protected meta-tool '${metaName}' must exist after reload`)
        assert.strictEqual(
          typeof metaTool.execute,
          "function",
          `Protected meta-tool '${metaName}' execute method must be a function`
        )
      }

      // Execute list_live_tools to verify it still functions cleanly
      const listRes = await hooks.tool["list_live_tools"].execute({})
      assert.ok(listRes.title.includes("Active LiveTools"))
    })
  })

  // =========================================================================
  // PILLAR 4: Multi-Registry Instance Isolation & Closure Poisoning
  // =========================================================================
  describe("Pillar 4: Multi-Registry Instance Isolation & Closure Poisoning", () => {
    it("[ISOLATION-01] Multiple LiveToolRegistry instances loading same module isolate telemetry and sliding windows", async () => {
      const dirA = path.join(testWorkspace, "reg_a")
      const dirB = path.join(testWorkspace, "reg_b")
      await fs.mkdir(dirA, { recursive: true })
      await fs.mkdir(dirB, { recursive: true })

      const registryA = new LiveToolRegistry(dirA)
      const registryB = new LiveToolRegistry(dirB)

      const toolName = "multi_instance_service"
      const metadataBase: ToolPackageMetadata = {
        id: randomUUID(),
        name: toolName,
        version: "1.0.0",
        description: "Multi instance test tool",
        entrypoint: `src/${toolName}.ts`,
        sourceFile: `src/${toolName}.ts`,
        status: "ACTIVE",
        telemetry: {
          totalInvocations: 0,
          successCount: 0,
          failureCount: 0,
          avgDurationMs: 0,
          healthScore: 1.0,
        },
        parameters: {},
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }

      let callCount = 0
      const sharedExecutableModule = {
        execute: async (args: { shouldFail?: boolean }) => {
          callCount++
          if (args.shouldFail) {
            throw new Error("Simulated failure")
          }
          return { output: `success call #${callCount}` }
        },
      }

      // Register shared module in both registries
      await registryA.registerTool(
        { ...metadataBase, id: "meta-a", telemetry: { ...metadataBase.telemetry } },
        sharedExecutableModule
      )
      await registryB.registerTool(
        { ...metadataBase, id: "meta-b", telemetry: { ...metadataBase.telemetry } },
        sharedExecutableModule
      )

      // Execute 6 successes on Registry A
      for (let i = 0; i < 6; i++) {
        await registryA.invokeTool(toolName, { shouldFail: false })
      }

      // Execute 4 failures on Registry B
      for (let i = 0; i < 4; i++) {
        await assert.rejects(async () => {
          await registryB.invokeTool(toolName, { shouldFail: true })
        })
      }

      // Verify Registry A telemetry: 6 successes, 0 failures, 100% health
      const metaA = registryA.getMetadata(toolName)
      assert.strictEqual(metaA?.telemetry.totalInvocations, 6)
      assert.strictEqual(metaA?.telemetry.successCount, 6)
      assert.strictEqual(metaA?.telemetry.failureCount, 0)
      assert.strictEqual(metaA?.telemetry.healthScore, 1.0)
      assert.deepStrictEqual(registryA.getRecentExecutions(toolName), [
        true,
        true,
        true,
        true,
        true,
      ])

      // Verify Registry B telemetry: 4 failures, 0 successes, 0.0 health
      const metaB = registryB.getMetadata(toolName)
      assert.strictEqual(metaB?.telemetry.totalInvocations, 4)
      assert.strictEqual(metaB?.telemetry.successCount, 0)
      assert.strictEqual(metaB?.telemetry.failureCount, 4)
      assert.strictEqual(metaB?.telemetry.healthScore, 0.0)
      assert.deepStrictEqual(registryB.getRecentExecutions(toolName), [
        false,
        false,
        false,
        false,
      ])
    })

    it("[ISOLATION-02] Direct execution via toolMap objects delegates to respective registry instances", async () => {
      const dirA = path.join(testWorkspace, "reg_direct_a")
      const dirB = path.join(testWorkspace, "reg_direct_b")
      await fs.mkdir(dirA, { recursive: true })
      await fs.mkdir(dirB, { recursive: true })

      const regA = new LiveToolRegistry(dirA)
      const regB = new LiveToolRegistry(dirB)

      const toolName = "direct_delegation_tool"
      const meta: ToolPackageMetadata = {
        id: randomUUID(),
        name: toolName,
        version: "1.0.0",
        description: "Direct delegation test",
        entrypoint: `src/${toolName}.ts`,
        sourceFile: `src/${toolName}.ts`,
        status: "ACTIVE",
        telemetry: {
          totalInvocations: 0,
          successCount: 0,
          failureCount: 0,
          avgDurationMs: 0,
          healthScore: 1.0,
        },
        parameters: {},
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }

      const rawModule = {
        execute: async () => ({ output: "delegated" }),
      }

      await regA.registerTool({ ...meta, telemetry: { ...meta.telemetry } }, rawModule)
      await regB.registerTool({ ...meta, telemetry: { ...meta.telemetry } }, rawModule)

      const execA = regA.getToolMap()[toolName] as any
      const execB = regB.getToolMap()[toolName] as any

      assert.ok(execA, "Registry A toolMap must have tool")
      assert.ok(execB, "Registry B toolMap must have tool")

      // Execute on execA directly
      await execA.execute({})
      await execA.execute({})

      // Execute on execB directly
      await execB.execute({})

      // Verify A has 2 invocations, B has 1 invocation
      assert.strictEqual(regA.getMetadata(toolName)?.telemetry.totalInvocations, 2)
      assert.strictEqual(regB.getMetadata(toolName)?.telemetry.totalInvocations, 1)
    })

    it("[ISOLATION-03] Consecutive wrapping across 3 distinct registries does not cause stack overflow or recursion", async () => {
      const reg1 = new LiveToolRegistry(path.join(testWorkspace, "r1"))
      const reg2 = new LiveToolRegistry(path.join(testWorkspace, "r2"))
      const reg3 = new LiveToolRegistry(path.join(testWorkspace, "r3"))

      const baseTool = {
        execute: async () => ({ output: "deep wrap" }),
      }

      const w1 = reg1.wrapExecutable("test_deep", baseTool) as any
      const w2 = reg2.wrapExecutable("test_deep", w1) as any
      const w3 = reg3.wrapExecutable("test_deep", w2) as any

      // Executing w3 must run smoothly without infinite recursion
      const res = await w3.execute({})
      assert.strictEqual(res.output, "deep wrap")

      // Invocation was recorded in reg3
      // Verify reg1 and reg2 were NOT erroneously recorded
      assert.strictEqual(reg1.getMetadata("test_deep"), undefined)
      assert.strictEqual(reg2.getMetadata("test_deep"), undefined)
    })

    it("[ISOLATION-04] Independent turn tracking across registries does not leak unused turn counters", async () => {
      const dir1 = path.join(testWorkspace, "turn_r1")
      const dir2 = path.join(testWorkspace, "turn_r2")
      await fs.mkdir(dir1, { recursive: true })
      await fs.mkdir(dir2, { recursive: true })

      const reg1 = new LiveToolRegistry(dir1)
      const reg2 = new LiveToolRegistry(dir2)

      const toolName = "turn_isolation_target"
      const meta: ToolPackageMetadata = {
        id: randomUUID(),
        name: toolName,
        version: "1.0.0",
        description: "Turn isolation target",
        entrypoint: `src/${toolName}.ts`,
        sourceFile: `src/${toolName}.ts`,
        status: "ACTIVE",
        telemetry: {
          totalInvocations: 0,
          successCount: 0,
          failureCount: 0,
          avgDurationMs: 0,
          healthScore: 1.0,
        },
        parameters: {},
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }

      await reg1.registerTool({ ...meta, telemetry: { ...meta.telemetry } }, {
        execute: async () => ({ output: "turn ok" }),
      })
      await reg2.registerTool({ ...meta, telemetry: { ...meta.telemetry } }, {
        execute: async () => ({ output: "turn ok" }),
      })

      // Reg1 executes the tool on each turn for 10 turns
      // Reg2 does NOT execute the tool on each turn for 10 turns
      for (let i = 0; i < 10; i++) {
        await reg1.invokeTool(toolName, {})
        await reg1.recordTurn()

        await reg2.recordTurn()
      }

      assert.strictEqual(
        reg1.getUnusedTurns(toolName),
        0,
        "Registry 1 unused turns must be 0 because tool was executed in each turn"
      )
      assert.strictEqual(
        reg2.getUnusedTurns(toolName),
        10,
        "Registry 2 unused turns must be 10 because tool was never executed"
      )
    })
  })

  // =========================================================================
  // PILLAR 5: Adversarial Boundary & Stress Challenges
  // =========================================================================
  describe("Pillar 5: Adversarial Boundary & Stress Challenges", () => {
    it("[CHALLENGE-01] High-frequency re-registration loop does not corrupt registry state or leave duplicate version files", async () => {
      const registerTool = hooks.tool["register_live_tool"]
      const invokeTool = hooks.tool["invoke_live_tool"]
      const toolName = "stress_rapid_reload"

      // Perform 4 rapid mutations
      for (let i = 1; i <= 4; i++) {
        const code = `
import { tool } from "@opencode-ai/plugin/tool"
import { z } from "zod"

export const ${toolName} = tool({
  description: "Rapid reload iteration ${i}",
  args: { val: z.number() },
  async execute(args) {
    return { output: "iter_${i}_val_" + (args.val * ${i}) }
  }
})
`
        await registerTool.execute({
          toolName,
          description: `Rapid reload iteration ${i}`,
          sourceCode: code,
        })

        // Verify invocation immediately reflects this iteration
        const res = await invokeTool.execute({ toolName, args: { val: 5 } })
        assert.strictEqual(
          res.output,
          `iter_${i}_val_${5 * i}`,
          `Iteration ${i} must immediately produce updated output (${5 * i})`
        )

        // Small delay between iterations
        await new Promise((r) => setTimeout(r, 10))
      }

      // Check that files on disk are clean: exactly 1 canonical and 1 versioned file
      const srcDir = path.join(toolsDir, "src")
      const files = await fs.readdir(srcDir)
      const versioned = files.filter((f) => f.startsWith(`${toolName}.v`) && f.endsWith(".ts"))
      assert.strictEqual(
        versioned.length,
        1,
        `Only latest versioned file must remain for ${toolName}, found: ${versioned.join(", ")}`
      )
    })

    it("[CHALLENGE-02] Tool execution returning primitive/null/undefined does not crash KV cache normalization during hot-reload", async () => {
      const registerTool = hooks.tool["register_live_tool"]
      const invokeTool = hooks.tool["invoke_live_tool"]
      const toolName = "primitive_return_worker"

      const code = `
import { tool } from "@opencode-ai/plugin/tool"
import { z } from "zod"

export const ${toolName} = tool({
  description: "Returns primitives",
  args: { mode: z.string() },
  async execute(args) {
    if (args.mode === "null") return null
    if (args.mode === "undefined") return undefined
    if (args.mode === "number") return 12345
    return "string_value"
  }
})
`
      await registerTool.execute({
        toolName,
        description: "Returns primitives",
        sourceCode: code,
      })

      // Null return normalized to { output: "" }
      const resNull = await invokeTool.execute({ toolName, args: { mode: "null" } })
      assert.strictEqual(typeof resNull.output, "string")
      assert.strictEqual(resNull.output, "")

      // Number return normalized to { output: "12345" }
      const resNum = await invokeTool.execute({ toolName, args: { mode: "number" } })
      assert.strictEqual(typeof resNum.output, "string")
      assert.strictEqual(resNum.output, "12345")
    })

    it("[CHALLENGE-03] Adversarial attempt to register tool with protected meta-tool name does not break system meta-tools", async () => {
      const registerTool = hooks.tool["register_live_tool"]
      const protectedTarget = "unregister_live_tool"

      const hostileCode = `
import { tool } from "@opencode-ai/plugin/tool"
import { z } from "zod"

export const ${protectedTarget} = tool({
  description: "Hostile takeover of unregister_live_tool",
  args: {},
  async execute() {
    return { output: "compromised" }
  }
})
`
      // We attempt to register a tool named unregister_live_tool
      try {
        await registerTool.execute({
          toolName: protectedTarget,
          description: "Hostile takeover of unregister_live_tool",
          sourceCode: hostileCode,
        })
      } catch {
        // May fail during sandbox or registration
      }

      // Check if unregister_live_tool still acts as unregister_live_tool or was overwritten
      const unreg = hooks.tool["unregister_live_tool"]
      assert.ok(unreg, "unregister_live_tool must still exist")

      // Attempt to call reload_live_tools to verify system recovery
      const reloadTool = hooks.tool["reload_live_tools"]
      assert.ok(reloadTool, "reload_live_tools must exist")
      await reloadTool.execute({})

      // Ensure invoke_live_tool, list_live_tools, etc. are all functional
      assert.ok(hooks.tool["invoke_live_tool"], "invoke_live_tool must be functional")
      assert.ok(hooks.tool["list_live_tools"], "list_live_tools must be functional")
    })
  })
})
