/**
 * Project DNA — E2E Test Suite: LiveTools Pillar (Tiers 1-4)
 * Covers: LATM Tool Synthesis, AST Validation, Sandbox Execution,
 * Telemetry, Degradation & Archival, Output Normalization, and Schemas.
 */

import { describe, it, before, after } from "node:test"
import assert from "node:assert"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { randomUUID } from "node:crypto"

import { ASTValidator } from "../../src/tools/ast-validator.js"
import { LiveToolRegistry } from "../../src/tools/tool-registry.js"
import { LiveToolMaker } from "../../src/tools/tool-maker.js"
import { TelemetryCalculator } from "../../src/core/telemetry.js"
import { ProjectDNAPlugin } from "../../src/index.js"

describe("E2E: LiveTools Engine (LATM Paradigm)", () => {
  const testWorkspace = path.resolve(`./test-e2e-tmp-tools-${randomUUID().slice(0, 8)}`)
  const toolsDir = path.join(testWorkspace, ".opencode", "dna", "tools")

  const mockClient: any = {
    tui: { showToast: async () => true },
    config: {
      get: async () => ({
        data: {
          model: { providerID: "test-provider", modelID: "test-model" },
          small_model: { providerID: "test-provider", modelID: "test-small-model" },
        },
      }),
    },
    session: {
      create: async () => ({ data: { id: "mock-tools-session" } }),
      prompt: async () => ({
        data: {
          parts: [{ type: "text", text: JSON.stringify({ passed: true, score: 0.95 }) }],
        },
      }),
      delete: async () => ({}),
    },
  }

  const mockInput: any = {
    client: mockClient,
    directory: testWorkspace,
    worktree: testWorkspace,
    project: { id: "test-project-tools" },
    serverUrl: new URL("http://localhost:3000"),
    $: {} as any,
  }

  before(async () => {
    await fs.mkdir(toolsDir, { recursive: true })
  })

  after(async () => {
    await fs.rm(testWorkspace, { recursive: true, force: true }).catch(() => {})
  })

  // ==========================================
  // TIER 1: Feature Coverage (Happy Paths)
  // ==========================================

  it("[Tier 1] [LT-01] Direct registration, AST validation, and hot-loading into registry", async () => {
    const registry = new LiveToolRegistry(toolsDir)
    await registry.loadActiveTools()

    const toolMaker = new LiveToolMaker({} as any, testWorkspace, toolsDir)

    const sourceCode = `
import { tool } from "@opencode-ai/plugin/tool"
import { z } from "zod"

export const calculator_add = tool({
  description: "Adds two integers",
  args: {
    x: z.number().describe("First operand"),
    y: z.number().describe("Second operand"),
  },
  async execute(args) {
    return { title: "Add Result", output: String(args.x + args.y) }
  }
})
`

    const testCode = `
import { describe, it } from "node:test"
import assert from "node:assert"
import { calculator_add } from "../src/calculator_add.js"

describe("calculator_add verification", () => {
  it("should add numbers correctly", async () => {
    const res = await calculator_add.execute({ x: 15, y: 27 }, { directory: process.cwd() })
    assert.strictEqual(res.output, "42")
  })
})
`

    const regResult = await toolMaker.registerDirect({
      toolName: "calculator_add",
      description: "Adds two integers",
      sourceCode,
      testCode,
    })

    assert.strictEqual(regResult.toolName, "calculator_add")
    assert.ok(regResult.sourceCode.includes("calculator_add"))

    // Verify written source on disk
    const written = await fs.readFile(path.join(toolsDir, "src", "calculator_add.ts"), "utf-8")
    assert.strictEqual(written, sourceCode)

    // Hot-load into registry
    const metadata = {
      id: randomUUID(),
      name: "calculator_add",
      version: "1.0.0",
      description: "Adds two integers",
      entrypoint: "src/calculator_add.ts",
      testFile: "tests/calculator_add.test.ts",
      status: "ACTIVE" as const,
      parameters: { x: "number", y: "number" },
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

    const executable = await registry.registerAndLoad(metadata)
    assert.ok(executable, "Executable should be loaded into memory")
    assert.ok(registry.getToolMap()["calculator_add"], "Tool must be available in getToolMap()")
  })

  it("[Tier 1] [LT-02] Tool execution via invokeTool preserves KV cache and returns normalized output", async () => {
    const registry = new LiveToolRegistry(toolsDir)
    await registry.loadActiveTools()

    const rawResult = await registry.invokeTool("calculator_add", { x: 50, y: 50 })
    const normalized = LiveToolRegistry.normalizeToolResult("calculator_add", rawResult)

    assert.strictEqual(typeof normalized.output, "string")
    assert.strictEqual(normalized.output, "100")
    assert.ok(normalized.title?.includes("Run #1"), "Title should reflect invocation count")

    // Check telemetry increment
    const meta = registry.getMetadata("calculator_add")
    assert.ok(meta)
    assert.strictEqual(meta?.telemetry.totalInvocations, 1)
    assert.strictEqual(meta?.telemetry.successCount, 1)
    assert.strictEqual(meta?.telemetry.failureCount, 0)
  })

  it("[Tier 1] [LT-03] Catalog discovery via listTools exposes parameters and health status", async () => {
    const registry = new LiveToolRegistry(toolsDir)
    await registry.loadActiveTools()

    const tools = registry.listTools()
    assert.ok(tools.length >= 1)
    const calc = tools.find((t) => t.name === "calculator_add")
    assert.ok(calc)
    assert.strictEqual(calc.status, "ACTIVE")
    assert.strictEqual(calc.healthScore, 1.0)
    assert.ok(calc.parameters)
  })

  // ==========================================
  // TIER 2: Boundary & Corner Cases
  // ==========================================

  it("[Tier 2] [LT-AST-01] AST validator rejects eval and new Function in code body", async () => {
    const evalCode = `
import { tool } from "@opencode-ai/plugin/tool"
import { z } from "zod"
export const evil = tool({
  description: "evil",
  args: {},
  async execute() {
    eval("console.log('pwned')")
    return { output: "done" }
  }
})`
    const report1 = ASTValidator.validate(evalCode)
    assert.strictEqual(report1.valid, false)
    assert.ok(report1.violations.some((v) => v.toLowerCase().includes("eval")))

    const funcCode = `
import { tool } from "@opencode-ai/plugin/tool"
import { z } from "zod"
export const evil = tool({
  description: "evil",
  args: {},
  async execute() {
    const fn = new Function("return 1")
    return { output: String(fn()) }
  }
})`
    const report2 = ASTValidator.validate(funcCode)
    assert.strictEqual(report2.valid, false)
    assert.ok(report2.violations.some((v) => v.toLowerCase().includes("function")))
  })

  it("[Tier 2] [LT-AST-02] AST validator rejects process.exit, process.kill, and execSync", async () => {
    const exitCode = `
import { tool } from "@opencode-ai/plugin/tool"
import { z } from "zod"
export const killer = tool({
  description: "kills process",
  args: {},
  async execute() {
    process.exit(1)
    return { output: "done" }
  }
})`
    const report1 = ASTValidator.validate(exitCode)
    assert.strictEqual(report1.valid, false)
    assert.ok(report1.violations.some((v) => v.toLowerCase().includes("exit")))

    const killCode = `
import { tool } from "@opencode-ai/plugin/tool"
import { z } from "zod"
export const killer = tool({
  description: "kills process",
  args: {},
  async execute() {
    process.kill(1234)
    return { output: "done" }
  }
})`
    const report2 = ASTValidator.validate(killCode)
    assert.strictEqual(report2.valid, false)
    assert.ok(report2.violations.some((v) => v.toLowerCase().includes("kill")))
  })

  it("[Tier 2] [LT-AST-03] AST validator passes comments and string literals containing forbidden keywords (TS Compiler AST)", async () => {
    const benignCode = `
import { tool } from "@opencode-ai/plugin/tool"
import { z } from "zod"

// Security notice: eval() is strictly forbidden in this codebase.
// process.exit() should never be used here.
export const benign_tool = tool({
  description: "Explains why eval() is bad",
  args: {},
  async execute() {
    const msg = "eval() should not be used in runtime"
    return { output: msg }
  }
})
`
    const report = ASTValidator.validate(benignCode)
    assert.strictEqual(
      report.valid,
      true,
      `Harmless comments and string literals containing keywords must pass AST analysis without false positives. Violations: ${report.violations.join(", ")}`
    )
  })

  it("[Tier 2] [LT-AST-04] AST validator rejects prototype pollution attempts", async () => {
    const protoCode = `
import { tool } from "@opencode-ai/plugin/tool"
import { z } from "zod"
export const polluter = tool({
  description: "polluter",
  args: {},
  async execute() {
    const obj = {}
    obj.__proto__.polluted = true
    return { output: "done" }
  }
})`
    const report = ASTValidator.validate(protoCode)
    assert.strictEqual(report.valid, false)
    assert.ok(report.violations.some((v) => v.toLowerCase().includes("proto")))
  })

  it("[Tier 2] [LT-REP-01] LiveToolMaker self-repair retry loop repairs broken tool and captures status transitions", async () => {
    let attempts = 0
    const mockBridge: any = {
      promptJson: async () => {
        attempts++
        if (attempts === 1) {
          // Attempt 1: buggy test assertion causes sandbox failure
          return {
            toolName: "e2e_repaired_tool",
            sourceCode: `
import { tool } from "@opencode-ai/plugin/tool"
import { z } from "zod"
export const e2e_repaired_tool = tool({
  description: "Repaired tool",
  args: { num: z.number() },
  async execute(args) { return { output: String(args.num * 2) } }
})`,
            testCode: `
import { describe, it } from "node:test"
import assert from "node:assert"
import { e2e_repaired_tool } from "../src/e2e_repaired_tool.js"
describe("e2e_repaired_tool", () => {
  it("computes double", async () => {
    const res = await e2e_repaired_tool.execute({ num: 5 }, { directory: process.cwd() })
    assert.strictEqual(res.output, "11") // Fails: 10 !== 11
  })
})`,
            zodSchemaDefinition: "",
          }
        } else {
          // Attempt 2 (Retry 1): repaired test passes
          return {
            toolName: "e2e_repaired_tool",
            sourceCode: `
import { tool } from "@opencode-ai/plugin/tool"
import { z } from "zod"
export const e2e_repaired_tool = tool({
  description: "Repaired tool",
  args: { num: z.number() },
  async execute(args) { return { output: String(args.num * 2) } }
})`,
            testCode: `
import { describe, it } from "node:test"
import assert from "node:assert"
import { e2e_repaired_tool } from "../src/e2e_repaired_tool.js"
describe("e2e_repaired_tool", () => {
  it("computes double", async () => {
    const res = await e2e_repaired_tool.execute({ num: 5 }, { directory: process.cwd() })
    assert.strictEqual(res.output, "10") // Passes!
  })
})`,
            zodSchemaDefinition: "",
          }
        }
      },
    }

    const toolMaker = new LiveToolMaker(mockBridge, testWorkspace, toolsDir)
    const res = await toolMaker.synthesize({
      toolName: "e2e_repaired_tool",
      intent: "Doubles input number",
      sampleInputs: [{ num: 5 }],
      expectedOutputs: [{ output: "10" }],
    })

    assert.strictEqual(res.toolName, "e2e_repaired_tool")
    assert.strictEqual(res.attempts, 2)
    assert.strictEqual(res.status, "ACTIVE")
    assert.deepStrictEqual(res.transitions, [
      "GENERATING",
      "VALIDATING_AST",
      "TESTING_SANDBOX",
      "GENERATING",
      "VALIDATING_AST",
      "TESTING_SANDBOX",
      "ACTIVE",
    ])
  })

  it("[Tier 2] [LT-REP-02] LiveToolMaker exhausts 2 retries (3 total sandbox attempts) and rejects persistent test failure", async () => {
    let attempts = 0
    const mockBridge: any = {
      promptJson: async () => {
        attempts++
        return {
          toolName: "e2e_hopeless_tool",
          sourceCode: `
import { tool } from "@opencode-ai/plugin/tool"
import { z } from "zod"
export const e2e_hopeless_tool = tool({
  description: "Hopeless",
  args: {},
  async execute() { return { output: "err" } }
})`,
          testCode: `
import { describe, it } from "node:test"
import assert from "node:assert"
describe("hopeless", () => {
  it("fails", () => { assert.fail("Intentional sandbox failure") })
})`,
          zodSchemaDefinition: "",
        }
      },
    }

    const toolMaker = new LiveToolMaker(mockBridge, testWorkspace, toolsDir)
    await assert.rejects(
      async () => {
        await toolMaker.synthesize({
          toolName: "e2e_hopeless_tool",
          intent: "Always fails",
        })
      },
      (err: any) => {
        assert.ok(err.message.includes("after 3 attempts (2 retries exhausted)"))
        return true
      }
    )
    assert.strictEqual(attempts, 3)
    assert.strictEqual(toolMaker.lastAttemptCount, 3)
    assert.ok(toolMaker.lastTransitions.includes("REJECTED"))
  })

  it("[Tier 2] [LT-OUT-01] LiveToolRegistry normalizes raw object, primitive, and null outputs", () => {
    // 1. Raw object without output property (e.g. system info object)
    const rawObj = { os: "darwin", arch: "arm64", uptime: 12345 }
    const normObj = LiveToolRegistry.normalizeToolResult("sys_info", rawObj)
    assert.strictEqual(typeof normObj.output, "string")
    assert.ok(normObj.output.includes('"os": "darwin"'))
    assert.doesNotThrow(() => normObj.output.split("\n"))

    // 2. Raw number primitive
    const rawNum = 42
    const normNum = LiveToolRegistry.normalizeToolResult("calc", rawNum)
    assert.strictEqual(normNum.output, "42")

    // 3. String primitive
    const rawStr = "Simple text output"
    const normStr = LiveToolRegistry.normalizeToolResult("echo", rawStr)
    assert.strictEqual(normStr.output, "Simple text output")

    // 4. Null / undefined
    const normNull = LiveToolRegistry.normalizeToolResult("noop", null)
    assert.strictEqual(typeof normNull.output, "string")
  })

  it("[Tier 2] [LT-TEL-01] TelemetryCalculator implements multiplicative formula: (S/T) * (1 - F_last5/5)", () => {
    // Spec: Health = (Successes / Total) * (1 - FailuresInLast5 / 5)
    // Case 1: 0 invocations returns 1.0
    assert.strictEqual(TelemetryCalculator.computeHealthScore(0, 0, 0), 1.0)

    // Case 2: 4 successes, 1 failure, 1 in last 5: (4/5) * (1 - 1/5) = 0.8 * 0.8 = 0.64
    const score = TelemetryCalculator.computeHealthScore(4, 1, 1)
    assert.strictEqual(score, 0.64, "Multiplicative formula must yield 0.64 for (4/5)*(1 - 1/5)")

    // Case 3: 5 failures in last 5: (0/5) * (1 - 5/5) = 0.0
    const zeroScore = TelemetryCalculator.computeHealthScore(0, 5, 5)
    assert.strictEqual(zeroScore, 0.0)

    // Case 4: 10 successes, 0 failures in last 5: (10/10) * (1 - 0/5) = 1.0
    assert.strictEqual(TelemetryCalculator.computeHealthScore(10, 0, 0), 1.0)
  })

  it("[Tier 2] [LT-TEL-02] TelemetryCalculator handles boundary clamping, negative values, and time decay", () => {
    // 1. Negative recent failures clamped to 0
    assert.strictEqual(TelemetryCalculator.computeHealthScore(4, 1, -3), 0.8)

    // 2. Recent failures > 5 clamped to 5
    assert.strictEqual(TelemetryCalculator.computeHealthScore(4, 1, 10), 0.0)

    // 3. Defensive negative counts
    assert.strictEqual(TelemetryCalculator.computeHealthScore(-10, -5, 0), 1.0)

    // 4. Time decay calculation: 30 days half-life
    const now = Date.now()
    const thirtyDaysAgo = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString()
    const decayed = TelemetryCalculator.applyTimeDecay(1.0, thirtyDaysAgo, 30)
    assert.strictEqual(decayed, 0.5)
  })

  it("[Tier 2] [LT-WIN-01] Sliding window execution telemetry maintains max 5 outcomes and recalculates health", async () => {
    const registry = new LiveToolRegistry(toolsDir)
    await registry.loadActiveTools()

    const windowMeta = {
      id: randomUUID(),
      name: "window_tool",
      version: "1.0.0",
      description: "Window telemetry tool",
      entrypoint: "src/window_tool.ts",
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

    await registry.registerTool(windowMeta, {
      description: "Window telemetry tool",
      args: {},
      execute: async () => ({ output: "ok" }),
    })

    // Execute 4 successes, 1 failure: window = [true, true, true, true, false]
    await registry.recordExecution("window_tool", true, 10)
    await registry.recordExecution("window_tool", true, 10)
    await registry.recordExecution("window_tool", true, 10)
    await registry.recordExecution("window_tool", true, 10)
    await registry.recordExecution("window_tool", false, 10)

    let meta = registry.getMetadata("window_tool")
    assert.strictEqual(meta?.telemetry.totalInvocations, 5)
    // Formula: (4/5) * (1 - 1/5) = 0.64
    assert.strictEqual(meta?.telemetry.healthScore, 0.64)
    assert.deepStrictEqual(registry.getRecentExecutions("window_tool"), [
      true,
      true,
      true,
      true,
      false,
    ])

    // Execute 5 consecutive successes to slide out the failure
    for (let i = 0; i < 5; i++) {
      await registry.recordExecution("window_tool", true, 10)
    }

    meta = registry.getMetadata("window_tool")
    assert.strictEqual(meta?.telemetry.totalInvocations, 10)
    // Formula: (9/10) * (1 - 0/5) = 0.90
    assert.strictEqual(meta?.telemetry.healthScore, 0.9)
    assert.deepStrictEqual(registry.getRecentExecutions("window_tool"), [
      true,
      true,
      true,
      true,
      true,
    ])
  })

  it("[Tier 2] [LT-ARC-01] Degraded tool unused for 100 turns transitions to ARCHIVED", async () => {
    const registry = new LiveToolRegistry(toolsDir)
    await registry.loadActiveTools()

    const degradedMeta = {
      id: randomUUID(),
      name: "flaky_tool",
      version: "1.0.0",
      description: "Flaky tool",
      entrypoint: "src/flaky_tool.ts",
      status: "ACTIVE" as const,
      parameters: {},
      telemetry: {
        totalInvocations: 5,
        successCount: 1,
        failureCount: 4,
        avgDurationMs: 10,
        healthScore: 0.16,
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }

    await registry.registerTool(degradedMeta, {
      description: "Flaky tool",
      args: {},
      execute: async () => ({ output: "ok" }),
    })

    // Evaluate health -> transitions to DEGRADED
    const status1 = await registry.evaluateHealth("flaky_tool")
    assert.strictEqual(status1, "DEGRADED", "Tool with healthScore < 0.6 and total >= 5 must be DEGRADED")

    // Simulate turn recording / unused turns
    if (typeof (registry as any).recordTurn === "function") {
      for (let i = 0; i < 100; i++) {
        await (registry as any).recordTurn()
      }
      const finalStatus = await registry.evaluateHealth("flaky_tool")
      assert.strictEqual(
        finalStatus,
        "ARCHIVED",
        "Degraded tool unused for 100 turns must transition to ARCHIVED"
      )
    }
  })

  it("[Tier 2] [LT-ARC-02] Active healthy tool unused for 100 turns does NOT transition to ARCHIVED and resets turn counter on execution", async () => {
    const registry = new LiveToolRegistry(toolsDir)
    await registry.loadActiveTools()

    const activeMeta = {
      id: randomUUID(),
      name: "healthy_stable_tool",
      version: "1.0.0",
      description: "Healthy stable tool",
      entrypoint: "src/healthy_stable_tool.ts",
      status: "ACTIVE" as const,
      parameters: {},
      telemetry: {
        totalInvocations: 5,
        successCount: 5,
        failureCount: 0,
        avgDurationMs: 10,
        healthScore: 1.0,
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }

    await registry.registerTool(activeMeta, {
      description: "Healthy stable tool",
      args: {},
      execute: async () => ({ output: "stable" }),
    })

    // Advance 100 turns without execution
    for (let i = 0; i < 100; i++) {
      await registry.recordTurn()
    }

    assert.strictEqual(registry.getUnusedTurns("healthy_stable_tool"), 100)
    // Active tool MUST stay ACTIVE even when unused for 100 turns
    const status = await registry.evaluateHealth("healthy_stable_tool")
    assert.strictEqual(status, "ACTIVE")
    assert.strictEqual(registry.getMetadata("healthy_stable_tool")?.status, "ACTIVE")

    // Execution resets unused turns counter to 0
    await registry.recordExecution("healthy_stable_tool", true, 12)
    assert.strictEqual(registry.getUnusedTurns("healthy_stable_tool"), 0)
    assert.strictEqual(registry.getMetadata("healthy_stable_tool")?.telemetry.unusedTurns, 0)
  })

  it("[Tier 1 & 2] [LT-SCH-01] Tool package JSON schema validates all 7 lifecycle statuses", async () => {
    const schemaPath = path.resolve("./specs/schemas/tool-package.schema.json")
    const schemaRaw = await fs.readFile(schemaPath, "utf-8")
    const schema = JSON.parse(schemaRaw)

    const expectedStatuses = [
      "PROPOSED",
      "GENERATING",
      "VALIDATING_AST",
      "TESTING",
      "ACTIVE",
      "DEGRADED",
      "ARCHIVED",
    ]

    const schemaEnum = schema.properties.status.enum
    assert.ok(Array.isArray(schemaEnum), "schema.properties.status.enum must be an array")

    for (const status of expectedStatuses) {
      assert.ok(
        schemaEnum.includes(status),
        `tool-package.schema.json status enum must include '${status}' per R5 specification`
      )
    }
  })

  // ==========================================
  // TIER 3: Cross-Feature Combinations
  // ==========================================

  it("[Tier 3] [LT-X01] Tool registration -> Execution -> Health degradation -> Recovery flow", async () => {
    const registry = new LiveToolRegistry(toolsDir)
    await registry.loadActiveTools()

    const dynamicMeta = {
      id: randomUUID(),
      name: "dynamic_service",
      version: "1.0.0",
      description: "Service tool",
      entrypoint: "src/dynamic_service.ts",
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

    let shouldFail = false
    await registry.registerTool(dynamicMeta, {
      description: "Service tool",
      args: {},
      execute: async () => {
        if (shouldFail) throw new Error("Service unavailable")
        return { output: "healthy" }
      },
    })

    // 1. Initial successful executions
    await registry.recordExecution("dynamic_service", true, 10)
    await registry.recordExecution("dynamic_service", true, 15)

    let meta = registry.getMetadata("dynamic_service")
    assert.strictEqual(meta?.telemetry.successCount, 2)

    // 2. Subsequent failures degrade tool
    shouldFail = true
    await registry.recordExecution("dynamic_service", false, 5)
    await registry.recordExecution("dynamic_service", false, 5)
    await registry.recordExecution("dynamic_service", false, 5)

    const healthStatus = await registry.evaluateHealth("dynamic_service")
    assert.strictEqual(healthStatus, "DEGRADED", "Tool should transition to DEGRADED after repeated failures")

    // 3. Recovery: multiple successes restore health
    shouldFail = false
    for (let i = 0; i < 6; i++) {
      await registry.recordExecution("dynamic_service", true, 8)
    }

    const recoveredStatus = await registry.evaluateHealth("dynamic_service")
    assert.strictEqual(recoveredStatus, "ACTIVE", "Tool should recover to ACTIVE when health rises >= 0.6")
  })

  // ==========================================
  // TIER 4: Real-World Scenario
  // ==========================================

  it("[Tier 4] [LT-SCN-01] End-to-end multi-tool operational workflow via OpenCode plugin hooks", async () => {
    const hooks = await ProjectDNAPlugin(mockInput, {})
    assert.ok(hooks.tool)

    const registerTool = (hooks.tool as any)["register_live_tool"]
    const invokeTool = (hooks.tool as any)["invoke_live_tool"]
    const listTool = (hooks.tool as any)["list_live_tools"]

    // Step 1: Agent registers string_reverser
    const regRes1 = await registerTool.execute({
      toolName: "string_reverser",
      description: "Reverses input string",
      sampleInputs: [{ text: "sample text" }],
      sourceCode: `
import { tool } from "@opencode-ai/plugin/tool"
import { z } from "zod"

export const string_reverser = tool({
  description: "Reverses input string",
  args: { text: z.string() },
  async execute(args) {
    return { output: args.text.split("").reverse().join("") }
  }
})
`,
    })
    assert.ok(regRes1.output.includes("string_reverser"))

    // Step 2: Agent registers word_counter
    const regRes2 = await registerTool.execute({
      toolName: "word_counter",
      description: "Counts words in input string",
      sampleInputs: [{ text: "hello world sample" }],
      sourceCode: `
import { tool } from "@opencode-ai/plugin/tool"
import { z } from "zod"

export const word_counter = tool({
  description: "Counts words in input string",
  args: { text: z.string() },
  async execute(args) {
    const count = args.text.trim().split(/\\s+/).filter(Boolean).length
    return { output: String(count) }
  }
})
`,
    })
    assert.ok(regRes2.output.includes("word_counter"))

    // Step 3: Agent executes string_reverser via invoke_live_tool
    const inv1 = await invokeTool.execute({
      toolName: "string_reverser",
      args: { text: "OpenCode LiveTools" },
    })
    assert.strictEqual(inv1.output, "slooTeviL edoCnepO")

    // Step 4: Agent executes word_counter via invoke_live_tool
    const inv2 = await invokeTool.execute({
      toolName: "word_counter",
      args: { text: "The quick brown fox jumps over the lazy dog" },
    })
    assert.strictEqual(inv2.output, "9")

    // Step 5: Catalog inspection reflects both tools with healthy telemetry
    const catalog = await listTool.execute({})
    assert.ok(catalog.output.includes("string_reverser"))
    assert.ok(catalog.output.includes("word_counter"))

    await hooks.dispose!()
  })
})
