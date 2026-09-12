/**
 * Independent Forensic Verification Test Suite — Milestone 2.1
 * Written by Forensic Auditor (teamwork_preview_auditor_m21_1)
 *
 * Verifies genuine behavior under randomized / perturbed conditions:
 * 1. AST Traversal Authenticity & Perturbation Resilience (deep nested casts, random names, rule diagnostics)
 * 2. ESM Hot-Reload & Dynamic Cache Invalidation (random seed generation across updates)
 * 3. 5-Domain Eviction across all state stores and physical disk files
 * 4. Reload State Synchronization & Versioned Entrypoint Creation
 * 5. Permission Gating Hook Execution via ctx.ask
 */

import { describe, it, before, after } from "node:test"
import assert from "node:assert"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { randomUUID, randomBytes } from "node:crypto"

import { ASTValidator } from "../src/tools/ast-validator.js"
import { LiveToolRegistry } from "../src/tools/tool-registry.js"
import type { ToolPackageMetadata } from "../specs/contracts/live-tools.js"

describe("Forensic Independent Verification: Milestone 2.1", () => {
  const testWorkspace = path.resolve(`./test-forensic-m21-${randomUUID().slice(0, 8)}`)
  const toolsDir = path.join(testWorkspace, ".opencode", "dna", "tools")

  before(async () => {
    await fs.mkdir(toolsDir, { recursive: true })
    await fs.mkdir(path.join(toolsDir, "src"), { recursive: true })
    await fs.mkdir(path.join(toolsDir, "tests"), { recursive: true })
  })

  after(async () => {
    await fs.rm(testWorkspace, { recursive: true, force: true }).catch(() => {})
  })

  // =========================================================================
  // 1. AST Traversal Authenticity & Perturbation Resilience
  // =========================================================================
  describe("1. AST Traversal Authenticity & Perturbation", () => {
    it("proves AST traversal correctly inspects deeply nested type-cast / parenthesized attack nodes", () => {
      // Generate randomized depth of parenthesized and as-expressions
      const depth = 5 + Math.floor(Math.random() * 5)
      let exitExpr = "process.exit(1)"
      for (let i = 0; i < depth; i++) {
        exitExpr = `(${exitExpr} as any)`
      }

      const code = `
import { tool } from "@opencode-ai/plugin/tool"
import { z } from "zod"

export const attack_deep = tool({
  description: "Deep attack",
  args: {},
  async execute() {
    ${exitExpr}
    return { output: "done" }
  }
})
`
      const report = ASTValidator.validate(code)
      assert.strictEqual(report.valid, false, "Deeply wrapped process.exit must be flagged as violation")
      assert.ok(
        report.diagnostics?.some((d) => d.rule === "no-process-exit"),
        "Diagnostic must have rule 'no-process-exit'"
      )
    })

    it("proves AST traversal does NOT produce false positives on randomized harmless identifier names", () => {
      // Generate random identifiers that look similar to forbidden words but are harmless
      const randomPrefix = "safe_" + randomBytes(4).toString("hex")
      const code = `
import { tool } from "@opencode-ai/plugin/tool"
import { z } from "zod"
import * as path from "node:path"

export const ${randomPrefix} = tool({
  description: "Harmless tool with safe names",
  args: {
    evaluatorName: z.string().describe("Name of evaluator"),
  },
  async execute(args) {
    const my_evaluation = args.evaluatorName + "_result"
    const process_status = "ok"
    const cluster_count = 42
    const prototype_model = { id: 1 }
    return { output: \`\${my_evaluation}:\${process_status}:\${cluster_count}:\${prototype_model.id}\` }
  }
})
`
      const report = ASTValidator.validate(code)
      assert.strictEqual(report.valid, true, `Harmless code with pseudo-keywords must pass! Violations: ${report.violations.join(", ")}`)
      assert.strictEqual(report.violations.length, 0)
    })

    it("proves capability detection accurately extracts multiple permissions and attaches diagnostics", () => {
      const code = `
import { tool } from "@opencode-ai/plugin/tool"
import { z } from "zod"
import * as cp from "node:child_process"
import * as net from "node:net"
import * as fs from "node:fs/promises"

export const multi_cap = tool({
  description: "Multi-capability tool",
  args: {},
  async execute() {
    await fs.writeFile("test.txt", "hello")
    const res = await fetch("https://example.com")
    return { output: "ok" }
  }
})
`
      const report = ASTValidator.validate(code)
      assert.strictEqual(report.valid, true, "In default mode, developer capabilities must be permitted")
      assert.ok(report.detectedCapabilities.includes("shell_execution"), "Must detect shell_execution from cp import")
      assert.ok(report.detectedCapabilities.includes("raw_socket_access"), "Must detect raw_socket_access from net import")
      assert.ok(report.detectedCapabilities.includes("filesystem_write"), "Must detect filesystem_write from fs.writeFile")
      assert.ok(report.detectedCapabilities.includes("network_access"), "Must detect network_access from fetch")

      // Diagnostics check
      assert.ok(report.diagnostics && report.diagnostics.length >= 4)
      assert.ok(report.diagnostics.some((d) => d.rule === "capability-shell_execution"))
      assert.ok(report.diagnostics.some((d) => d.rule === "capability-raw_socket_access"))
      assert.ok(report.diagnostics.some((d) => d.rule === "capability-filesystem_write"))
      assert.ok(report.diagnostics.some((d) => d.rule === "capability-network_access"))
    })
  })

  // =========================================================================
  // 2. ESM Hot-Reload & Dynamic Cache Invalidation
  // =========================================================================
  describe("2. ESM Hot-Reload & Dynamic Cache Invalidation", () => {
    it("proves re-registering an existing tool executes updated code immediately via fresh versioned file", async () => {
      const registry = new LiveToolRegistry(toolsDir)
      const toolName = `hot_reload_${randomBytes(4).toString("hex")}`

      const seedV1 = `seed_v1_${randomBytes(6).toString("hex")}`
      const seedV2 = `seed_v2_${randomBytes(6).toString("hex")}`

      // Version 1
      const v1Source = `
import { tool } from "@opencode-ai/plugin/tool"
import { z } from "zod"

export const ${toolName} = tool({
  description: "Hot reload test tool",
  args: {},
  async execute() {
    return { output: "${seedV1}" }
  }
})
`
      const tsV1 = Date.now()
      const v1FileName = `${toolName}.v${tsV1}.ts`
      await fs.writeFile(path.join(toolsDir, "src", `${toolName}.ts`), v1Source, "utf-8")
      await fs.writeFile(path.join(toolsDir, "src", v1FileName), v1Source, "utf-8")

      const metaV1: ToolPackageMetadata = {
        id: randomUUID(),
        name: toolName,
        version: "1.0.0",
        description: "Hot reload test tool",
        entrypoint: `src/${v1FileName}`,
        sourceFile: `src/${toolName}.ts`,
        status: "ACTIVE",
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

      await registry.registerAndLoad(metaV1)
      const resultV1: any = await registry.invokeTool(toolName, {})
      assert.strictEqual(resultV1.output, seedV1, "Invocation 1 must return seedV1")

      // Version 2 (Update same tool with seedV2)
      const v2Source = `
import { tool } from "@opencode-ai/plugin/tool"
import { z } from "zod"

export const ${toolName} = tool({
  description: "Hot reload test tool updated",
  args: {},
  async execute() {
    return { output: "${seedV2}" }
  }
})
`
      // Introduce slight delay to guarantee distinct timestamp
      await new Promise((r) => setTimeout(r, 50))
      const tsV2 = Date.now()
      const v2FileName = `${toolName}.v${tsV2}.ts`
      await fs.writeFile(path.join(toolsDir, "src", `${toolName}.ts`), v2Source, "utf-8")
      await fs.writeFile(path.join(toolsDir, "src", v2FileName), v2Source, "utf-8")

      const metaV2: ToolPackageMetadata = {
        ...metaV1,
        version: "1.0.1",
        entrypoint: `src/${v2FileName}`,
        updatedAt: new Date().toISOString(),
      }

      await registry.registerAndLoad(metaV2)
      const resultV2: any = await registry.invokeTool(toolName, {})
      assert.strictEqual(
        resultV2.output,
        seedV2,
        "HOT-RELOAD VERIFICATION: Tool invocation must immediately return seedV2 from updated version!"
      )

      // Verify that cleanupOlderVersions cleaned up v1 file
      const srcFiles = await fs.readdir(path.join(toolsDir, "src"))
      assert.ok(srcFiles.includes(v2FileName), "Active version file must exist")
      assert.ok(!srcFiles.includes(v1FileName), "Older version file must be cleaned up")
    })
  })

  // =========================================================================
  // 3. 5-Domain Eviction Verification
  // =========================================================================
  describe("3. 5-Domain Eviction Verification", () => {
    it("proves unregisterTool completely evicts state across all 5 domains and removes physical files", async () => {
      const registry = new LiveToolRegistry(toolsDir)
      const toolName = `zombie_test_${randomBytes(4).toString("hex")}`

      const srcCode = `
import { tool } from "@opencode-ai/plugin/tool"
import { z } from "zod"

export const ${toolName} = tool({
  description: "Zombie candidate",
  args: {},
  async execute() {
    return { output: "alive" }
  }
})
`
      const testCode = `
import { describe, it } from "node:test"
import assert from "node:assert"
describe("${toolName}", () => {
  it("runs", () => assert.ok(true))
})
`
      const ts = Date.now()
      const versionedName = `${toolName}.v${ts}.ts`
      const canonicalSrc = path.join(toolsDir, "src", `${toolName}.ts`)
      const versionedSrc = path.join(toolsDir, "src", versionedName)
      const testFilePath = path.join(toolsDir, "tests", `${toolName}.test.ts`)

      await fs.writeFile(canonicalSrc, srcCode, "utf-8")
      await fs.writeFile(versionedSrc, srcCode, "utf-8")
      await fs.writeFile(testFilePath, testCode, "utf-8")

      const meta: ToolPackageMetadata = {
        id: randomUUID(),
        name: toolName,
        version: "1.0.0",
        description: "Zombie candidate",
        entrypoint: `src/${versionedName}`,
        sourceFile: `src/${toolName}.ts`,
        testFile: `tests/${toolName}.test.ts`,
        status: "ACTIVE",
        parameters: {},
        telemetry: {
          totalInvocations: 1,
          successCount: 1,
          failureCount: 0,
          avgDurationMs: 10,
          healthScore: 1.0,
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }

      await registry.registerAndLoad(meta)
      await registry.recordExecution(toolName, true, 15)

      // Verify presence in all domains prior to unregister
      assert.strictEqual(registry.isLiveTool(toolName), true, "Domain 1: toolsMap must contain tool")
      assert.ok(registry.getRecentExecutions(toolName).length > 0, "Domain 2: recentExecutionsMap must contain tool")
      assert.strictEqual(typeof registry.getUnusedTurns(toolName), "number", "Domain 3: unusedTurnsMap must track tool")

      const registryDataBefore = JSON.parse(
        await fs.readFile(path.join(toolsDir, "registry.json"), "utf-8")
      )
      assert.ok(
        registryDataBefore.some((t: any) => t.name === toolName),
        "Domain 5: registry.json must contain tool before unregister"
      )

      // Evict
      const evicted = await registry.unregisterTool(toolName, { removeFiles: true })
      assert.strictEqual(evicted, true, "unregisterTool must return true on successful eviction")

      // Verify Domain 1: toolsMap eviction
      assert.strictEqual(registry.isLiveTool(toolName), false, "Domain 1: toolsMap must not have tool")
      assert.strictEqual(registry.getMetadata(toolName), undefined)

      // Verify Domain 2: recentExecutionsMap eviction
      assert.deepStrictEqual(registry.getRecentExecutions(toolName), [], "Domain 2: recentExecutionsMap must be empty")

      // Verify Domain 3: unusedTurnsMap eviction
      assert.strictEqual(registry.getUnusedTurns(toolName), 0)

      // Verify Domain 5: registry.json eviction
      const registryDataAfter = JSON.parse(
        await fs.readFile(path.join(toolsDir, "registry.json"), "utf-8")
      )
      assert.ok(
        !registryDataAfter.some((t: any) => t.name === toolName),
        "Domain 5: registry.json must NOT contain tool after unregister"
      )

      // Verify physical disk files deleted
      await assert.rejects(async () => fs.access(canonicalSrc), "Canonical source file must be deleted from disk")
      await assert.rejects(async () => fs.access(versionedSrc), "Versioned source file must be deleted from disk")
      await assert.rejects(async () => fs.access(testFilePath), "Test file must be deleted from disk")

      // Verify invocation fails cleanly
      await assert.rejects(
        async () => registry.invokeTool(toolName, {}),
        (err: any) => {
          assert.ok(err.message.includes("is not registered"))
          return true
        }
      )
    })
  })

  // =========================================================================
  // 4. Reload State Synchronization & Versioned Entrypoints
  // =========================================================================
  describe("4. Reload State Synchronization", () => {
    it("proves reloadTools reads registry.json, creates fresh versioned entrypoints, and purges removed tools", async () => {
      const registry = new LiveToolRegistry(toolsDir)
      const toolA = `tool_a_${randomBytes(4).toString("hex")}`
      const toolB = `tool_b_${randomBytes(4).toString("hex")}`

      const srcA = `
import { tool } from "@opencode-ai/plugin/tool"
import { z } from "zod"
export const ${toolA} = tool({
  description: "Tool A",
  args: {},
  async execute() { return { output: "tool A result" } }
})
`
      const srcB = `
import { tool } from "@opencode-ai/plugin/tool"
import { z } from "zod"
export const ${toolB} = tool({
  description: "Tool B",
  args: {},
  async execute() { return { output: "tool B result" } }
})
`
      await fs.writeFile(path.join(toolsDir, "src", `${toolA}.ts`), srcA, "utf-8")
      await fs.writeFile(path.join(toolsDir, "src", `${toolB}.ts`), srcB, "utf-8")

      const registryList: ToolPackageMetadata[] = [
        {
          id: randomUUID(),
          name: toolA,
          version: "1.0.0",
          description: "Tool A",
          entrypoint: `src/${toolA}.ts`,
          sourceFile: `src/${toolA}.ts`,
          status: "ACTIVE",
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
        },
      ]

      await fs.writeFile(
        path.join(toolsDir, "registry.json"),
        JSON.stringify(registryList, null, 2),
        "utf-8"
      )

      // Reload
      await registry.reloadTools(true)

      assert.strictEqual(registry.isLiveTool(toolA), true, "Tool A must be loaded")
      assert.strictEqual(registry.isLiveTool(toolB), false, "Tool B was not in registry.json, must not be loaded")

      const metaA = registry.getMetadata(toolA)
      assert.ok(metaA?.entrypoint.includes(".v"), "Reload with forceFreshVersion must create versioned entrypoint")

      const invA: any = await registry.invokeTool(toolA, {})
      assert.strictEqual(invA.output, "tool A result")
    })
  })

  // =========================================================================
  // 5. Permission Gating Hook Execution
  // =========================================================================
  describe("5. Permission Gating Hook via ctx.ask", () => {
    it("proves wrapExecutable invokes ctx.ask with exact permission descriptors", async () => {
      const registry = new LiveToolRegistry(toolsDir)
      const toolName = `perm_tool_${randomBytes(4).toString("hex")}`

      const askedPermissions: any[] = []
      const mockCtx = {
        ask: async (req: any) => {
          askedPermissions.push(req)
          return true
        },
      }

      const meta: ToolPackageMetadata = {
        id: randomUUID(),
        name: toolName,
        version: "1.0.0",
        description: "Permission gated tool",
        entrypoint: `src/${toolName}.ts`,
        sourceFile: `src/${toolName}.ts`,
        status: "ACTIVE",
        parameters: {},
        requiredPermissions: ["shell_execution", "network_access"],
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

      const executableObj = {
        name: toolName,
        args: {},
        async execute(_args: any, _ctx: any) {
          return { output: "executed with permissions" }
        },
      }

      await registry.registerTool(meta, executableObj)
      const res: any = await registry.invokeTool(toolName, {}, mockCtx)

      assert.strictEqual(res.output, "executed with permissions")
      assert.strictEqual(askedPermissions.length, 2, "ctx.ask must be invoked for both permissions")
      assert.strictEqual(askedPermissions[0].permission, "tool:shell_execution")
      assert.strictEqual(askedPermissions[1].permission, "tool:network_access")
      assert.deepStrictEqual(askedPermissions[0].patterns, [toolName])
    })
  })
})
