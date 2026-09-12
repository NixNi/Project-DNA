import { describe, it, before, after } from "node:test"
import assert from "node:assert"
import { ASTValidator } from "../src/tools/ast-validator.js"
import { LiveToolMaker } from "../src/tools/tool-maker.js"
import * as path from "node:path"
import * as fs from "node:fs/promises"
import { randomUUID } from "node:crypto"

describe("Adversarial Stress Test: ASTValidator Evasion Vectors", () => {
  const wrapCode = (body: string, imports = `import { tool } from "@opencode-ai/plugin/tool"\nimport { z } from "zod"`) => `
${imports}

export const testTool = tool({
  description: "Test tool for adversarial validation",
  args: {},
  async execute() {
    ${body}
    return { output: "done" }
  }
})
`

  // -------------------------------------------------------------
  // Test 1: Baseline blocks that must continue to be blocked
  // -------------------------------------------------------------
  it("stress: eval direct, comma operator, and property access variations are blocked", () => {
    const cases = [
      `eval("1+1")`,
      `(eval)("1+1")`,
      `(((eval)))("1+1")`,
      `(0, eval)("1+1")`,
      `(1, 2, eval)("1+1")`,
      `window.eval("1+1")`,
      `globalThis.eval("1+1")`,
      `global.eval("1+1")`,
      `eval.call(null, "1+1")`,
      `eval.apply(null, ["1+1"])`,
      `globalThis["eval"]("1+1")`,
      `window["eval"]("1+1")`,
      `global["eval"]("1+1")`,
      `this["eval"]("1+1")`,
    ]

    for (const code of cases) {
      const report = ASTValidator.validate(wrapCode(code))
      assert.strictEqual(
        report.valid,
        false,
        `Expected violation for eval evasion: '${code}', but passed!`
      )
    }
  })

  it("stress: Function constructor identifier and property access variations are blocked", () => {
    const cases = [
      `Function("return 42")()`,
      `new Function("return 42")()`,
      `globalThis.Function("return 42")()`,
      `new globalThis.Function("return 42")()`,
      `global.Function("return 42")()`,
      `new global.Function("return 42")()`,
      `window.Function("return 42")()`,
      `new window.Function("return 42")()`,
    ]

    for (const code of cases) {
      const report = ASTValidator.validate(wrapCode(code))
      assert.strictEqual(
        report.valid,
        false,
        `Expected violation for Function constructor: '${code}', but passed!`
      )
    }
  })

  it("stress: process.exit and process.kill direct and property/bracket access are blocked", () => {
    const cases = [
      `process.exit(1)`,
      `process.kill(100)`,
      `process["exit"](1)`,
      `process["kill"](100)`,
      `globalThis.process.exit(1)`,
      `globalThis.process.kill(100)`,
      `globalThis["process"]["exit"](1)`,
      `globalThis["process"]["kill"](100)`,
      `global.process.exit(1)`,
      `global.process.kill(100)`,
      `global["process"]["exit"](1)`,
      `global["process"]["kill"](100)`,
      `window.process.exit(1)`,
      `window["process"]["exit"](1)`,
    ]

    for (const code of cases) {
      const report = ASTValidator.validate(wrapCode(code))
      assert.strictEqual(
        report.valid,
        false,
        `Expected violation for process lifecycle: '${code}', but passed!`
      )
    }
  })

  it("stress: Object.setPrototypeOf and basic prototype property tampering are blocked", () => {
    const cases = [
      `Object.setPrototypeOf({}, null)`,
      `Reflect.setPrototypeOf({}, null)`,
      `const x = {}; x.__proto__ = null`,
      `const x = {}; x["__proto__"] = null`,
      `const x = { __proto__: null }`,
      `Object.prototype["polluted"] = true`,
      `Array.prototype["polluted"] = true`,
    ]

    for (const code of cases) {
      const report = ASTValidator.validate(wrapCode(code))
      assert.strictEqual(
        report.valid,
        false,
        `Expected violation for prototype tampering: '${code}', but passed!`
      )
    }
  })

  it("stress: dynamic imports of forbidden modules and non-literal expressions are blocked", () => {
    const forbidden = [
      `await import("cluster")`,
      `await import("node:cluster")`,
      `await import("worker_threads")`,
      `await import("node:worker_threads")`,
      `await import("v8")`,
      `await import("node:v8")`,
      `await import("vm")`,
      `await import("node:vm")`,
      `const m = "child_process"; await import(m)`,
      `await import("child" + "_process")`,
    ]

    for (const code of forbidden) {
      const report = ASTValidator.validate(wrapCode(code))
      assert.strictEqual(
        report.valid,
        false,
        `Expected violation for dynamic import '${code}', but passed!`
      )
    }
  })

  it("stress: static imports of strictly forbidden modules are blocked", () => {
    const modules = [
      "cluster",
      "node:cluster",
      "worker_threads",
      "node:worker_threads",
      "v8",
      "node:v8",
      "vm",
      "node:vm",
    ]

    for (const mod of modules) {
      const imports = `import { tool } from "@opencode-ai/plugin/tool"\nimport { z } from "zod"\nimport * as forbidden from "${mod}"`
      const report = ASTValidator.validate(wrapCode(`return { output: "ok" }`, imports))
      assert.strictEqual(
        report.valid,
        false,
        `Expected violation for static import '${mod}', but passed!`
      )
    }
  })

  it("stress: developer capability modules (child_process, net) route to permissions in default mode and block in strict mode", () => {
    const capabilityModules = [
      { mod: "child_process", perm: "shell_execution" },
      { mod: "node:child_process", perm: "shell_execution" },
      { mod: "net", perm: "raw_socket_access" },
      { mod: "node:net", perm: "raw_socket_access" },
    ]

    for (const { mod, perm } of capabilityModules) {
      const imports = `import { tool } from "@opencode-ai/plugin/tool"\nimport { z } from "zod"\nimport * as cap from "${mod}"`
      const code = wrapCode(`return { output: "ok" }`, imports)

      // Default mode: permission gated (valid: true)
      const reportDefault = ASTValidator.validate(code)
      assert.strictEqual(
        reportDefault.valid,
        true,
        `Expected valid: true for capability module '${mod}', but got violations: ${reportDefault.violations.join(", ")}`
      )
      assert.ok(
        reportDefault.detectedCapabilities.includes(perm as any),
        `Expected capability '${perm}' for '${mod}'`
      )

      // Strict mode: blocked (valid: false)
      const reportStrict = ASTValidator.validate(code, { strict: true })
      assert.strictEqual(
        reportStrict.valid,
        false,
        `Expected valid: false in strict mode for '${mod}'`
      )
      assert.ok(
        reportStrict.violations.some((v) => v.includes(perm)),
        `Expected violation mentioning '${perm}' in strict mode`
      )
    }
  })

  it("stress: harmless code with comments, string literals, and safe process properties must PASS", () => {
    const harmlessCode = `
import { tool } from "@opencode-ai/plugin/tool"
import { z } from "zod"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import crypto from "node:crypto"

// Note: eval() is dynamic code execution.
// Warning: never call process.exit() or process.kill() or execSync().
// Do not modify __proto__ or call Object.setPrototypeOf().
/*
 * Block comment mentioning:
 * child_process, cluster, dgram, net, tls, worker_threads
 * import("child_process")
 */

export const harmlessTool = tool({
  description: "A tool that explains why eval() and process.exit() are dangerous",
  args: {
    query: z.string().describe("Query string"),
    options: z.object({
      enabled: z.boolean().default(true),
    }).optional(),
  },
  async execute(args, ctx) {
    const doc = "Here we discuss eval() and new Function() and child_process.execSync"
    const regex = /eval\\s*\\(|process\\.exit/g
    const cwd = process.cwd()
    const platform = process.platform
    const arch = process.arch
    const uptime = process.uptime()
    const envVar = process.env.NODE_ENV || "production"
    
    const obj = {
      evaluationScore: 0.95,
      evaluatedAt: new Date().toISOString(),
      metadata: {
        prototypeName: "standard-card",
      }
    }

    return {
      title: "Harmless Evaluation",
      output: JSON.stringify({ cwd, platform, arch, uptime, envVar, obj, doc })
    }
  }
})
`
    const report = ASTValidator.validate(harmlessCode)
    assert.strictEqual(
      report.valid,
      true,
      `Harmless code must pass AST validation without false positives! Violations: ${report.violations.join(", ")}`
    )
    assert.strictEqual(report.violations.length, 0)
  })

  it("stress: syntax errors in tool implementation must be flagged as violations", () => {
    const malformedCode = `
import { tool } from "@opencode-ai/plugin/tool"
import { z } from "zod"

export const broken = tool({
  description: "Broken syntax",
  args: {},
  async execute() {
    if (true {
      return { output: "broken" }
    }
  }
})
`
    const report = ASTValidator.validate(malformedCode)
    assert.strictEqual(report.valid, false)
    assert.ok(
      report.violations.some((v) => v.toLowerCase().includes("syntax error")),
      "Syntax errors must be reported as violations"
    )
  })

  // -------------------------------------------------------------
  // Test 2: Confirmed AST Evasion Flaws Challenged
  // -------------------------------------------------------------
  it("adversarial challenge: eval method invocation via bracket access eval['call'] and eval['apply']", () => {
    // Attack scenario: Attacker bypasses eval check by invoking method via bracket notation
    const codeCall = wrapCode(`eval["call"](null, "console.log('malicious')")`)
    const reportCall = ASTValidator.validate(codeCall)

    const codeApply = wrapCode(`eval["apply"](null, ["console.log('malicious')"])`)
    const reportApply = ASTValidator.validate(codeApply)

    assert.strictEqual(
      reportCall.valid,
      false,
      "VULNERABILITY: eval['call']() bypassed ASTValidator.validate! Expected violation but valid was true."
    )
    assert.strictEqual(
      reportApply.valid,
      false,
      "VULNERABILITY: eval['apply']() bypassed ASTValidator.validate! Expected violation but valid was true."
    )
  })

  it("adversarial challenge: Function constructor via bracket access globalThis['Function']", () => {
    // Attack scenario: Attacker accesses Function constructor via global bracket notation
    const code1 = wrapCode(`globalThis["Function"]("return 42")()`)
    const report1 = ASTValidator.validate(code1)

    const code2 = wrapCode(`new globalThis["Function"]("return 42")()`)
    const report2 = ASTValidator.validate(code2)

    assert.strictEqual(
      report1.valid,
      false,
      "VULNERABILITY: globalThis['Function']() bypassed ASTValidator.validate! Expected violation but valid was true."
    )
    assert.strictEqual(
      report2.valid,
      false,
      "VULNERABILITY: new globalThis['Function']() bypassed ASTValidator.validate! Expected violation but valid was true."
    )
  })

  it("adversarial challenge: process termination via TypeScript type assertions (process as any).exit()", () => {
    // Attack scenario: Attacker casts process to any to evade identifier check
    const codeExit = wrapCode(`(process as any).exit(1)`)
    const reportExit = ASTValidator.validate(codeExit)

    const codeKill = wrapCode(`(process as any).kill(1234)`)
    const reportKill = ASTValidator.validate(codeKill)

    assert.strictEqual(
      reportExit.valid,
      false,
      "VULNERABILITY: (process as any).exit() bypassed ASTValidator.validate! Expected violation but valid was true."
    )
    assert.strictEqual(
      reportKill.valid,
      false,
      "VULNERABILITY: (process as any).kill() bypassed ASTValidator.validate! Expected violation but valid was true."
    )
  })

  it("adversarial challenge: prototype tampering via bracket access Object['setPrototypeOf']", () => {
    // Attack scenario: Attacker mutates prototype via bracket access
    const codeObj = wrapCode(`Object["setPrototypeOf"]({}, null)`)
    const reportObj = ASTValidator.validate(codeObj)

    const codeReflect = wrapCode(`Reflect["setPrototypeOf"]({}, null)`)
    const reportReflect = ASTValidator.validate(codeReflect)

    assert.strictEqual(
      reportObj.valid,
      false,
      "VULNERABILITY: Object['setPrototypeOf']() bypassed ASTValidator.validate! Expected violation but valid was true."
    )
    assert.strictEqual(
      reportReflect.valid,
      false,
      "VULNERABILITY: Reflect['setPrototypeOf']() bypassed ASTValidator.validate! Expected violation but valid was true."
    )
  })

  it("adversarial challenge: prototype pollution via computed property object literal { ['__proto__']: null }", () => {
    // Attack scenario: Attacker pollutes prototype using computed property name
    const code = wrapCode(`const x = { ["__proto__"]: null }`)
    const report = ASTValidator.validate(code)

    assert.strictEqual(
      report.valid,
      false,
      "VULNERABILITY: { ['__proto__']: null } bypassed ASTValidator.validate! Expected violation but valid was true."
    )
  })
})

describe("Adversarial Stress Test: LiveToolMaker Self-Repair Retry Loop", () => {
  const testWorkspace = path.resolve(`./test-adversarial-maker-tmp-${randomUUID().slice(0, 8)}`)
  const toolsDir = path.join(testWorkspace, ".opencode", "dna", "tools")

  before(async () => {
    await fs.mkdir(toolsDir, { recursive: true })
  })

  after(async () => {
    await fs.rm(testWorkspace, { recursive: true, force: true }).catch(() => {})
  })

  it("stress: exact 3 attempts on persistent sandbox failure (1 initial + 2 retries = 3 attempts)", async () => {
    let callCount = 0

    const mockBridge: any = {
      promptJson: async () => {
        callCount++
        return {
          toolName: "stress_persistent_fail",
          sourceCode: `
import { tool } from "@opencode-ai/plugin/tool"
import { z } from "zod"
export const stress_persistent_fail = tool({
  description: "Always fails",
  args: {},
  async execute() { return { output: "err" } }
})`,
          testCode: `
import { describe, it } from "node:test"
import assert from "node:assert"
describe("stress_persistent_fail", () => {
  it("fails every time", () => {
    assert.fail("Assertion error attempt ${callCount}")
  })
})`,
          zodSchemaDefinition: "",
        }
      },
    }

    const toolMaker = new LiveToolMaker(mockBridge, testWorkspace, toolsDir)
    const transitionsObserved: Array<{ status: string; attempt: number }> = []

    await assert.rejects(
      async () => {
        await toolMaker.synthesize(
          {
            toolName: "stress_persistent_fail",
            intent: "Always fails sandbox",
          },
          (status, attempt) => {
            transitionsObserved.push({ status, attempt })
          }
        )
      },
      (err: any) => {
        assert.ok(err.message.includes("failed sandbox verification after 3 attempts (2 retries exhausted)"))
        return true
      }
    )

    assert.strictEqual(callCount, 3, "LLM must be called exactly 3 times (1 initial + 2 retries)")
    assert.strictEqual(toolMaker.lastAttemptCount, 3)
    assert.strictEqual(toolMaker.currentStatus, "REJECTED")
    assert.deepStrictEqual(toolMaker.lastTransitions, [
      "GENERATING",
      "VALIDATING_AST",
      "TESTING_SANDBOX",
      "GENERATING",
      "VALIDATING_AST",
      "TESTING_SANDBOX",
      "GENERATING",
      "VALIDATING_AST",
      "TESTING_SANDBOX",
      "REJECTED",
    ])

    // Verify onTransition was called for all 10 transitions
    assert.strictEqual(transitionsObserved.length, 10)
    assert.strictEqual(transitionsObserved[0].status, "GENERATING")
    assert.strictEqual(transitionsObserved[0].attempt, 1)
    assert.strictEqual(transitionsObserved[3].status, "GENERATING")
    assert.strictEqual(transitionsObserved[3].attempt, 2)
    assert.strictEqual(transitionsObserved[6].status, "GENERATING")
    assert.strictEqual(transitionsObserved[6].attempt, 3)
    assert.strictEqual(transitionsObserved[9].status, "REJECTED")
    assert.strictEqual(transitionsObserved[9].attempt, 3)
  })

  it("stress: success on final retry (attempt 3 of 3) produces ACTIVE status and 3 attempts", async () => {
    let callCount = 0

    const mockBridge: any = {
      promptJson: async () => {
        callCount++
        if (callCount < 3) {
          // Attempt 1 & 2 fail sandbox
          return {
            toolName: "retry3_tool",
            sourceCode: `
import { tool } from "@opencode-ai/plugin/tool"
import { z } from "zod"
export const retry3_tool = tool({
  description: "Fails until retry 2",
  args: {},
  async execute() { return { output: "bad" } }
})`,
            testCode: `
import { describe, it } from "node:test"
import assert from "node:assert"
import { retry3_tool } from "../src/retry3_tool.js"
describe("retry3_tool", () => {
  it("fails", async () => {
    const res = await retry3_tool.execute({}, { directory: process.cwd() })
    assert.strictEqual(res.output, "good")
  })
})`,
            zodSchemaDefinition: "",
          }
        } else {
          // Attempt 3 passes sandbox
          return {
            toolName: "retry3_tool",
            sourceCode: `
import { tool } from "@opencode-ai/plugin/tool"
import { z } from "zod"
export const retry3_tool = tool({
  description: "Fails until retry 2",
  args: {},
  async execute() { return { output: "good" } }
})`,
            testCode: `
import { describe, it } from "node:test"
import assert from "node:assert"
import { retry3_tool } from "../src/retry3_tool.js"
describe("retry3_tool", () => {
  it("passes on attempt 3", async () => {
    const res = await retry3_tool.execute({}, { directory: process.cwd() })
    assert.strictEqual(res.output, "good")
  })
})`,
            zodSchemaDefinition: "",
          }
        }
      },
    }

    const toolMaker = new LiveToolMaker(mockBridge, testWorkspace, toolsDir)
    const result = await toolMaker.synthesize({
      toolName: "retry3_tool",
      intent: "Succeeds on attempt 3",
    })

    assert.strictEqual(callCount, 3)
    assert.strictEqual(result.attempts, 3)
    assert.strictEqual(result.status, "ACTIVE")
    assert.deepStrictEqual(result.transitions, [
      "GENERATING",
      "VALIDATING_AST",
      "TESTING_SANDBOX",
      "GENERATING",
      "VALIDATING_AST",
      "TESTING_SANDBOX",
      "GENERATING",
      "VALIDATING_AST",
      "TESTING_SANDBOX",
      "ACTIVE",
    ])
  })

  it("stress: AST security check fails immediately on attempt 1 without executing sandbox", async () => {
    const mockBridge: any = {
      promptJson: async () => ({
        toolName: "ast_fail_tool",
        sourceCode: `
import { tool } from "@opencode-ai/plugin/tool"
import { z } from "zod"
export const ast_fail_tool = tool({
  description: "Bad",
  args: {},
  async execute() {
    eval("malicious()")
    return { output: "done" }
  }
})`,
        testCode: `
import { describe, it } from "node:test"
describe("ast_fail_tool", () => {
  it("should not run", () => {
    throw new Error("Sandbox should never run for AST invalid code")
  })
})`,
        zodSchemaDefinition: "",
      }),
    }

    const toolMaker = new LiveToolMaker(mockBridge, testWorkspace, toolsDir)
    await assert.rejects(
      async () => {
        await toolMaker.synthesize({
          toolName: "ast_fail_tool",
          intent: "Generates eval()",
        })
      },
      (err: any) => {
        assert.ok(err.message.includes("failed security AST check"))
        assert.ok(err.message.includes("eval()"))
        return true
      }
    )

    assert.strictEqual(toolMaker.lastAttemptCount, 1)
    assert.strictEqual(toolMaker.currentStatus, "REJECTED")
    assert.deepStrictEqual(toolMaker.lastTransitions, [
      "GENERATING",
      "VALIDATING_AST",
      "REJECTED",
    ])
  })

  it("stress: error output and stdout/stderr capture during self-repair prompts", async () => {
    const receivedPrompts: string[] = []
    let callCount = 0

    const mockBridge: any = {
      promptJson: async (opts: any) => {
        callCount++
        receivedPrompts.push(opts.userPrompt)
        if (callCount === 1) {
          return {
            toolName: "diagnostic_capture_tool",
            sourceCode: `
import { tool } from "@opencode-ai/plugin/tool"
import { z } from "zod"
export const diagnostic_capture_tool = tool({
  description: "Diagnostic test",
  args: {},
  async execute() { return { output: "buggy" } }
})`,
            testCode: `
import { describe, it } from "node:test"
import assert from "node:assert"
describe("diagnostic_capture_tool", () => {
  it("fails with special diagnostic messages", () => {
    console.log("DIAGNOSTIC_STDOUT_MARKER_12345")
    console.error("DIAGNOSTIC_STDERR_MARKER_67890")
    assert.strictEqual("buggy", "repaired", "ASSERTION_FAILURE_MARKER_abcde")
  })
})`,
            zodSchemaDefinition: "",
          }
        } else {
          return {
            toolName: "diagnostic_capture_tool",
            sourceCode: `
import { tool } from "@opencode-ai/plugin/tool"
import { z } from "zod"
export const diagnostic_capture_tool = tool({
  description: "Diagnostic test",
  args: {},
  async execute() { return { output: "repaired" } }
})`,
            testCode: `
import { describe, it } from "node:test"
import assert from "node:assert"
describe("diagnostic_capture_tool", () => {
  it("passes", () => {
    assert.strictEqual("repaired", "repaired")
  })
})`,
            zodSchemaDefinition: "",
          }
        }
      },
    }

    const toolMaker = new LiveToolMaker(mockBridge, testWorkspace, toolsDir)
    const result = await toolMaker.synthesize({
      toolName: "diagnostic_capture_tool",
      intent: "Verify diagnostic capture",
    })

    assert.strictEqual(result.status, "ACTIVE")
    assert.strictEqual(receivedPrompts.length, 2)
    const repairPrompt = receivedPrompts[1]

    assert.ok(repairPrompt.includes("Retry attempt 1 of 2, sandbox attempt 2 of 3"))
    assert.ok(repairPrompt.includes("ASSERTION_FAILURE_MARKER_abcde"))
    assert.ok(
      repairPrompt.includes("DIAGNOSTIC_STDOUT_MARKER_12345") ||
      repairPrompt.includes("DIAGNOSTIC_STDERR_MARKER_67890")
    )
  })
})
