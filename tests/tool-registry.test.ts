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
})
