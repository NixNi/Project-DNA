import { describe, it, before, after } from "node:test"
import assert from "node:assert"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { LiveToolRegistry } from "../src/tools/tool-registry.js"

describe("LiveToolRegistry", () => {
  const testWorkspace = path.resolve("./test-tool-registry-tmp")
  const toolsDir = path.join(testWorkspace, ".opencode", "dna", "tools")

  before(async () => {
    await fs.mkdir(toolsDir, { recursive: true })
  })

  after(async () => {
    await fs.rm(testWorkspace, { recursive: true, force: true }).catch(() => {})
  })

  describe("normalizeToolResult", () => {
    it("should keep { output: string } intact if already compliant", () => {
      const res = LiveToolRegistry.normalizeToolResult("test_tool", {
        title: "Test",
        output: "All good",
        metadata: { foo: "bar" },
      })
      assert.strictEqual(res.title, "Test")
      assert.strictEqual(res.output, "All good")
      assert.deepStrictEqual(res.metadata, { foo: "bar" })
    })

    it("should serialize raw object return without output field (preventing c.split crash)", () => {
      // Replicates the exact bug in session-ses_f746.md: { platform: "darwin", arch: "arm64" }
      const raw = { platform: "darwin", arch: "arm64" }
      const res = LiveToolRegistry.normalizeToolResult("get_os_info", raw)

      assert.strictEqual(typeof res.output, "string")
      assert.ok(res.output.includes('"platform": "darwin"'))
      assert.ok(res.output.includes('"arch": "arm64"'))
      // Verify OpenCode c.split("\n") would succeed
      assert.doesNotThrow(() => {
        res.output.split("\n")
      })
      assert.deepStrictEqual(res.metadata, raw)
    })

    it("should serialize raw object with message (e.g. { message: 'Hello, World!' })", () => {
      const raw = { message: "Hello, World!" }
      const res = LiveToolRegistry.normalizeToolResult("hello_world", raw)

      assert.strictEqual(typeof res.output, "string")
      assert.ok(res.output.includes('"message": "Hello, World!"'))
      assert.doesNotThrow(() => {
        res.output.split("\n")
      })
    })

    it("should wrap raw string output", () => {
      const res = LiveToolRegistry.normalizeToolResult("echo", "just a string")
      assert.strictEqual(res.output, "just a string")
    })

    it("should wrap numbers or primitive returns", () => {
      const resNum = LiveToolRegistry.normalizeToolResult("calc", 42)
      assert.strictEqual(resNum.output, "42")

      const resNull = LiveToolRegistry.normalizeToolResult("calc", null)
      assert.strictEqual(resNull.output, "")

      const resUndef = LiveToolRegistry.normalizeToolResult("calc", undefined)
      assert.strictEqual(resUndef.output, "")
    })
  })

  describe("invokeTool and executable wrapping", () => {
    it("should wrap tool output so invokeTool always yields { output: string }", async () => {
      const registry = new LiveToolRegistry(toolsDir)

      // Register a mock tool that returns raw object without output
      await registry.registerTool(
        {
          name: "get_os_info",
          version: "1.0.0",
          description: "Returns OS info",
          author: "AGENT",
          createdTimestamp: Date.now(),
          lastUpdatedTimestamp: Date.now(),
          entrypoint: "src/get_os_info.js",
          status: "ACTIVE",
          totalInvocations: 0,
          failedInvocations: 0,
          averageDurationMs: 0,
          parameters: {
            detailed: { type: "boolean", description: "Whether to return detailed info" },
          },
        },
        {
          execute: async () => {
            return { platform: "darwin", arch: "arm64" }
          },
        }
      )

      const result = (await registry.invokeTool("get_os_info", {})) as any
      assert.strictEqual(typeof result.output, "string")
      assert.ok(result.output.includes('"platform": "darwin"'))
      assert.doesNotThrow(() => result.output.split("\n"))

      // Check listTools parameter reporting
      const list = registry.listTools()
      const toolEntry = list.find((t) => t.name === "get_os_info")
      assert.ok(toolEntry)
      assert.ok(toolEntry.parameters)
      assert.ok("detailed" in toolEntry.parameters)
    })

    it("should track execution statistics and update description when invoked directly as a normal tool", async () => {
      const registry = new LiveToolRegistry(toolsDir)

      await registry.registerTool(
        {
          name: "math_calc",
          version: "1.0.0",
          description: "Calculates numbers",
          author: "AGENT",
          createdTimestamp: Date.now(),
          lastUpdatedTimestamp: Date.now(),
          entrypoint: "src/math_calc.js",
          status: "ACTIVE",
          totalInvocations: 0,
          failedInvocations: 0,
          averageDurationMs: 0,
          parameters: {},
        },
        {
          execute: async (args: any) => {
            return { output: String(args.x * 2) }
          },
        }
      )

      const toolMap = registry.getToolMap()
      const normalTool = toolMap["math_calc"] as any
      assert.ok(normalTool)
      // Tool description must remain stable and immutable to preserve KV cache
      assert.strictEqual(normalTool.description, "Calculates numbers")

      // Direct execution like a normal OpenCode tool
      const res1 = await normalTool.execute({ x: 21 })
      assert.strictEqual(res1.output, "42")
      assert.ok(res1.title.includes("Run #1"))
      assert.strictEqual(res1.metadata.telemetry.totalInvocations, 1)

      const meta1 = registry.getMetadata("math_calc")
      assert.strictEqual(meta1?.telemetry.totalInvocations, 1)
      assert.strictEqual(meta1?.telemetry.successCount, 1)
      assert.strictEqual(meta1?.telemetry.healthScore, 1.0)
      // Crucial KV cache check: description MUST NOT mutate during session
      assert.strictEqual(normalTool.description, "Calculates numbers")

      // Second direct execution
      const res2 = await normalTool.execute({ x: 50 })
      assert.ok(res2.title.includes("Run #2"))
      assert.strictEqual(res2.metadata.telemetry.totalInvocations, 2)
      const meta2 = registry.getMetadata("math_calc")
      assert.strictEqual(meta2?.telemetry.totalInvocations, 2)
      assert.strictEqual(normalTool.description, "Calculates numbers")

      // Invoking through invokeTool should increment exactly once (no double-counting)
      await registry.invokeTool("math_calc", { x: 5 })
      const meta3 = registry.getMetadata("math_calc")
      assert.strictEqual(meta3?.telemetry.totalInvocations, 3)
      assert.strictEqual(normalTool.description, "Calculates numbers")
    })

    it("should normalize input: z.object into args for model-authored tools", async () => {
      const registry = new LiveToolRegistry(toolsDir)
      const { z } = await import("zod")

      await registry.registerTool(
        {
          name: "query_runner",
          version: "1.0.0",
          description: "Runs a search query",
          author: "AGENT",
          createdTimestamp: Date.now(),
          lastUpdatedTimestamp: Date.now(),
          entrypoint: "src/query_runner.js",
          status: "ACTIVE",
          totalInvocations: 0,
          failedInvocations: 0,
          averageDurationMs: 0,
          parameters: {},
        },
        {
          // Model authored using input: z.object(...) instead of args: { ... }
          input: z.object({
            query: z.string().describe("Search query term"),
            limit: z.number().optional().describe("Max items to return"),
          }),
          execute: async (args: any) => {
            return { output: `results for ${args.query}` }
          },
        }
      )

      const toolMap = registry.getToolMap()
      const tool = toolMap["query_runner"] as any
      assert.ok(tool.args)
      assert.ok(tool.args.query)
      assert.strictEqual(tool.args.query.description, "Search query term")
      assert.ok(tool.args.limit)

      // Execute directly
      const res = await tool.execute({ query: "agent architecture" })
      assert.strictEqual(res.output, "results for agent architecture")
    })

    it("should format description with stats cleanly without duplicating suffixes", () => {
      const base = "Performs deep computation"
      const desc0 = LiveToolRegistry.formatDescriptionWithStats(base, undefined)
      assert.strictEqual(desc0, "Performs deep computation [Stats: 0 calls]")

      const desc1 = LiveToolRegistry.formatDescriptionWithStats(desc0, {
        totalInvocations: 5,
        successCount: 4,
        failureCount: 1,
        avgDurationMs: 12.4,
        healthScore: 0.8,
      })
      assert.strictEqual(desc1, "Performs deep computation [Stats: 5 calls, 80% health, 12.4ms avg]")

      // Cleanly replaces previous suffix without stacking
      const desc2 = LiveToolRegistry.formatDescriptionWithStats(desc1, {
        totalInvocations: 6,
        successCount: 5,
        failureCount: 1,
        avgDurationMs: 11.2,
        healthScore: 0.83,
      })
      assert.strictEqual(desc2, "Performs deep computation [Stats: 6 calls, 83% health, 11.2ms avg]")
    })
  })

  describe("Sliding window execution telemetry", () => {
    it("should maintain max 5 execution outcomes and calculate multiplicative health score", async () => {
      const registry = new LiveToolRegistry(toolsDir)

      await registry.registerTool(
        {
          name: "sliding_tool",
          version: "1.0.0",
          description: "Sliding window tool",
          author: "AGENT",
          createdTimestamp: Date.now(),
          lastUpdatedTimestamp: Date.now(),
          entrypoint: "src/sliding_tool.js",
          status: "ACTIVE",
          totalInvocations: 0,
          failedInvocations: 0,
          averageDurationMs: 0,
          parameters: {},
        },
        {
          execute: async () => ({ output: "ok" }),
        }
      )

      // 4 successes, 1 failure -> window = [true, true, true, true, false]
      await registry.recordExecution("sliding_tool", true, 10)
      await registry.recordExecution("sliding_tool", true, 10)
      await registry.recordExecution("sliding_tool", true, 10)
      await registry.recordExecution("sliding_tool", true, 10)
      await registry.recordExecution("sliding_tool", false, 10)

      assert.deepStrictEqual(registry.getRecentExecutions("sliding_tool"), [
        true,
        true,
        true,
        true,
        false,
      ])
      let meta = registry.getMetadata("sliding_tool")
      // (4/5) * (1 - 1/5) = 0.8 * 0.8 = 0.64
      assert.strictEqual(meta?.telemetry.healthScore, 0.64)

      // Execute 5 successes -> failure should slide out completely
      for (let i = 0; i < 5; i++) {
        await registry.recordExecution("sliding_tool", true, 10)
      }

      assert.deepStrictEqual(registry.getRecentExecutions("sliding_tool"), [
        true,
        true,
        true,
        true,
        true,
      ])
      meta = registry.getMetadata("sliding_tool")
      // 9 successes, 1 failure, 0 in last 5: (9/10) * (1 - 0) = 0.90
      assert.strictEqual(meta?.telemetry.healthScore, 0.9)
    })
  })

  describe("Turn tracking and archival in recordTurn()", () => {
    it("should increment unused turns for inactive tools and reset on execution", async () => {
      const registry = new LiveToolRegistry(toolsDir)

      await registry.registerTool(
        {
          name: "turn_tool_a",
          version: "1.0.0",
          description: "Tool A",
          author: "AGENT",
          createdTimestamp: Date.now(),
          lastUpdatedTimestamp: Date.now(),
          entrypoint: "src/turn_tool_a.js",
          status: "ACTIVE",
          totalInvocations: 0,
          failedInvocations: 0,
          averageDurationMs: 0,
          parameters: {},
        },
        { execute: async () => ({ output: "a" }) }
      )

      await registry.registerTool(
        {
          name: "turn_tool_b",
          version: "1.0.0",
          description: "Tool B",
          author: "AGENT",
          createdTimestamp: Date.now(),
          lastUpdatedTimestamp: Date.now(),
          entrypoint: "src/turn_tool_b.js",
          status: "ACTIVE",
          totalInvocations: 0,
          failedInvocations: 0,
          averageDurationMs: 0,
          parameters: {},
        },
        { execute: async () => ({ output: "b" }) }
      )

      // 5 turns elapse where only tool_a is executed
      for (let i = 0; i < 5; i++) {
        await registry.recordExecution("turn_tool_a", true, 5)
        await registry.recordTurn()
      }

      assert.strictEqual(registry.getUnusedTurns("turn_tool_a"), 0)
      assert.strictEqual(registry.getUnusedTurns("turn_tool_b"), 5)

      // Now execute tool_b
      await registry.recordExecution("turn_tool_b", true, 5)
      assert.strictEqual(registry.getUnusedTurns("turn_tool_b"), 0)
    })

    it("should archive DEGRADED tool after 100 unused turns, but retain ACTIVE tools", async () => {
      const registry = new LiveToolRegistry(toolsDir)

      await registry.registerTool(
        {
          name: "degraded_turn_tool",
          version: "1.0.0",
          description: "Degraded tool",
          author: "AGENT",
          createdTimestamp: Date.now(),
          lastUpdatedTimestamp: Date.now(),
          entrypoint: "src/degraded_turn_tool.js",
          status: "ACTIVE",
          totalInvocations: 0,
          failedInvocations: 0,
          averageDurationMs: 0,
          parameters: {},
        },
        { execute: async () => ({ output: "fail" }) }
      )

      await registry.registerTool(
        {
          name: "healthy_turn_tool",
          version: "1.0.0",
          description: "Healthy tool",
          author: "AGENT",
          createdTimestamp: Date.now(),
          lastUpdatedTimestamp: Date.now(),
          entrypoint: "src/healthy_turn_tool.js",
          status: "ACTIVE",
          totalInvocations: 0,
          failedInvocations: 0,
          averageDurationMs: 0,
          parameters: {},
        },
        { execute: async () => ({ output: "ok" }) }
      )

      // Degrade degraded_turn_tool: 5 failures
      for (let i = 0; i < 5; i++) {
        await registry.recordExecution("degraded_turn_tool", false, 5)
      }
      assert.strictEqual(await registry.evaluateHealth("degraded_turn_tool"), "DEGRADED")

      // healthy_turn_tool has 5 successes
      for (let i = 0; i < 5; i++) {
        await registry.recordExecution("healthy_turn_tool", true, 5)
      }
      assert.strictEqual(await registry.evaluateHealth("healthy_turn_tool"), "ACTIVE")

      // Complete the active execution turn
      await registry.recordTurn()

      // Advance 100 consecutive turns without executing either tool
      for (let i = 0; i < 100; i++) {
        await registry.recordTurn()
      }

      // Degraded tool must transition to ARCHIVED
      assert.strictEqual(await registry.evaluateHealth("degraded_turn_tool"), "ARCHIVED")
      assert.strictEqual(registry.getMetadata("degraded_turn_tool")?.status, "ARCHIVED")

      // Healthy ACTIVE tool must remain ACTIVE even after 100 unused turns
      assert.strictEqual(await registry.evaluateHealth("healthy_turn_tool"), "ACTIVE")
      assert.strictEqual(registry.getMetadata("healthy_turn_tool")?.status, "ACTIVE")
    })
  })

  describe("unregisterTool & reloadTools lifecycle", () => {
    it("should evict across all 5 domains and remove physical files on disk", async () => {
      const registry = new LiveToolRegistry(toolsDir)
      const toolName = "to_be_unregistered"

      const srcDir = path.join(toolsDir, "src")
      const testDir = path.join(toolsDir, "tests")
      await fs.mkdir(srcDir, { recursive: true })
      await fs.mkdir(testDir, { recursive: true })

      const canonicalSrc = path.join(srcDir, `${toolName}.ts`)
      const versionedSrc = path.join(srcDir, `${toolName}.v1710000000000.ts`)
      const testFile = path.join(testDir, `${toolName}.test.ts`)

      await fs.writeFile(canonicalSrc, "export default { execute: async () => ({ output: 'ok' }) }")
      await fs.writeFile(versionedSrc, "export default { execute: async () => ({ output: 'ok' }) }")
      await fs.writeFile(testFile, "test code")

      const metadata: any = {
        name: toolName,
        version: "1.0.0",
        description: "Tool to unregister",
        author: "AGENT",
        createdTimestamp: Date.now(),
        lastUpdatedTimestamp: Date.now(),
        entrypoint: `src/${toolName}.ts`,
        sourceFile: `src/${toolName}.ts`,
        testFile: `tests/${toolName}.test.ts`,
        status: "ACTIVE",
        totalInvocations: 0,
        failedInvocations: 0,
        averageDurationMs: 0,
        parameters: {},
      }

      await registry.registerTool(metadata, { execute: async () => ({ output: "ok" }) })
      await registry.recordExecution(toolName, true, 10)
      assert.strictEqual(registry.getMetadata(toolName)?.status, "ACTIVE")
      assert.strictEqual(registry.getUnusedTurns(toolName), 0)

      // Unregister
      const removed = await registry.unregisterTool(toolName, { removeFiles: true })
      assert.strictEqual(removed, true)

      // 1. toolsMap eviction
      assert.strictEqual(registry.getMetadata(toolName), undefined)
      assert.strictEqual(registry.getToolMap()[toolName], undefined)

      // 2. unusedTurns eviction
      assert.strictEqual(registry.getUnusedTurns(toolName), 0)

      // 3. registry.json eviction
      const regJson = JSON.parse(await fs.readFile(path.join(toolsDir, "registry.json"), "utf-8"))
      assert.ok(Array.isArray(regJson))
      assert.strictEqual(
        regJson.find((t: any) => t.name === toolName),
        undefined
      )

      // 4. Physical file removal
      await assert.rejects(async () => fs.stat(canonicalSrc))
      await assert.rejects(async () => fs.stat(versionedSrc))
      await assert.rejects(async () => fs.stat(testFile))

      // Unregistering non-existent tool returns false
      assert.strictEqual(await registry.unregisterTool("non_existent_tool"), false)
    })

    it("should reloadTools and maintain active tool definitions", async () => {
      const registry = new LiveToolRegistry(toolsDir)
      const toolName = "reload_candidate"

      const srcDir = path.join(toolsDir, "src")
      await fs.mkdir(srcDir, { recursive: true })
      const srcPath = path.join(srcDir, `${toolName}.ts`)
      await fs.writeFile(
        srcPath,
        "export const reload_candidate = { execute: async () => ({ output: 'reloaded' }) }"
      )

      const metadata: any = {
        name: toolName,
        version: "1.0.0",
        description: "Reload candidate",
        author: "AGENT",
        createdTimestamp: Date.now(),
        lastUpdatedTimestamp: Date.now(),
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
      }

      await registry.registerAndLoad(metadata)
      assert.ok(registry.getToolMap()[toolName])

      // Execute reload
      await registry.reloadTools(true)
      assert.ok(registry.getToolMap()[toolName])

      const result = (await registry.invokeTool(toolName, {})) as any
      assert.strictEqual(result.output, "reloaded")
    })

    it("should isolate telemetry across multiple LiveToolRegistry instances", async () => {
      const registry1 = new LiveToolRegistry(toolsDir)
      const registry2 = new LiveToolRegistry(toolsDir)

      const toolName = "shared_tool"
      const metadata: any = {
        name: toolName,
        version: "1.0.0",
        description: "Shared tool instance test",
        author: "AGENT",
        createdTimestamp: Date.now(),
        lastUpdatedTimestamp: Date.now(),
        entrypoint: `src/${toolName}.ts`,
        status: "ACTIVE",
        telemetry: {
          totalInvocations: 0,
          successCount: 0,
          failureCount: 0,
          avgDurationMs: 0,
          healthScore: 1.0,
        },
        parameters: {},
      }

      const rawTool = {
        execute: async () => ({ output: "shared_output" }),
      }

      await registry1.registerTool(metadata, rawTool)
      await registry2.registerTool(
        { ...metadata, telemetry: { ...metadata.telemetry } },
        rawTool
      )

      // Invoke on registry1
      await registry1.invokeTool(toolName, {})
      assert.strictEqual(registry1.getMetadata(toolName)?.telemetry.totalInvocations, 1)
      assert.strictEqual(registry2.getMetadata(toolName)?.telemetry.totalInvocations, 0)

      // Invoke on registry2
      await registry2.invokeTool(toolName, {})
      assert.strictEqual(registry2.getMetadata(toolName)?.telemetry.totalInvocations, 1)
    })
  })

  describe("TelemetryCalculator", () => {
    it("should compute multiplicative health score accurately", async () => {
      const { TelemetryCalculator } = await import("../src/core/telemetry.js")
      assert.strictEqual(TelemetryCalculator.computeHealthScore(0, 0, 0), 1.0)
      assert.strictEqual(TelemetryCalculator.computeHealthScore(4, 1, 1), 0.64)
      assert.strictEqual(TelemetryCalculator.computeHealthScore(10, 0, 0), 1.0)
      assert.strictEqual(TelemetryCalculator.computeHealthScore(0, 5, 5), 0.0)
      assert.strictEqual(TelemetryCalculator.computeHealthScore(5, 5, 5), 0.0)
      assert.strictEqual(TelemetryCalculator.computeHealthScore(8, 2, 0), 0.8)
      // Clamping test
      assert.strictEqual(TelemetryCalculator.computeHealthScore(4, 1, -1), 0.8)
      assert.strictEqual(TelemetryCalculator.computeHealthScore(4, 1, 10), 0.0)
    })
  })
})
