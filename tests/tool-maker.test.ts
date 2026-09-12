import { describe, it, before, after } from "node:test"
import assert from "node:assert"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { LiveToolMaker } from "../src/tools/tool-maker.js"

describe("LiveToolMaker Direct Registration", () => {
  const testWorkspace = path.resolve("./test-tool-maker-tmp")
  const toolsDir = path.join(testWorkspace, ".opencode", "dna", "tools")

  before(async () => {
    await fs.mkdir(toolsDir, { recursive: true })
  })

  after(async () => {
    await fs.rm(testWorkspace, { recursive: true, force: true }).catch(() => {})
  })

  it("should directly register, AST-validate, and sandbox-test a model-authored tool", async () => {
    let llmCalled = false
    const mockBridge: any = {
      promptJson: async () => {
        llmCalled = true
        throw new Error("LLM should not be called for direct registration")
      },
    }

    const toolMaker = new LiveToolMaker(mockBridge, testWorkspace, toolsDir)

    const sourceCode = `
import { tool } from "@opencode-ai/plugin/tool"
import { z } from "zod"

export const add_numbers = tool({
  description: "Adds two numbers together",
  args: {
    a: z.number().describe("First number"),
    b: z.number().describe("Second number"),
  },
  async execute(args) {
    return {
      title: "Sum",
      output: String(args.a + args.b),
    }
  }
})
`

    const testCode = `
import { describe, it } from "node:test"
import assert from "node:assert"
import { add_numbers } from "../src/add_numbers.js"

describe("add_numbers unit test", () => {
  it("should correctly compute sum", async () => {
    const res = await add_numbers.execute({ a: 10, b: 32 }, { directory: process.cwd() })
    assert.strictEqual(res.output, "42")
  })
})
`

    const res = await toolMaker.registerDirect({
      toolName: "add_numbers",
      description: "Adds two numbers together",
      sourceCode,
      testCode,
    })

    assert.strictEqual(llmCalled, false)
    assert.strictEqual(res.toolName, "add_numbers")
    assert.strictEqual(res.sourceCode, sourceCode)

    // Verify files on disk
    const writtenSrc = await fs.readFile(path.join(toolsDir, "src", "add_numbers.ts"), "utf-8")
    assert.strictEqual(writtenSrc, sourceCode)
  })

  it("should reject direct tool with AST violations without running sandbox", async () => {
    const mockBridge: any = {}
    const toolMaker = new LiveToolMaker(mockBridge, testWorkspace, toolsDir)

    const maliciousCode = `
import { tool } from "@opencode-ai/plugin/tool"
import { z } from "zod"

export const bad_tool = tool({
  description: "Bad",
  args: {},
  async execute() {
    eval("malicious()")
    return { output: "done" }
  }
})
`

    await assert.rejects(
      async () => {
        await toolMaker.registerDirect({
          toolName: "bad_tool",
          description: "Malicious tool",
          sourceCode: maliciousCode,
        })
      },
      (err: any) => {
        assert.ok(err.message.includes("failed security AST check"))
        return true
      }
    )
  })

  it("should route synthesize() to direct registration if sourceCode is provided", async () => {
    let llmCalled = false
    const mockBridge: any = {
      promptJson: async () => {
        llmCalled = true
        throw new Error("LLM should not be called")
      },
    }

    const toolMaker = new LiveToolMaker(mockBridge, testWorkspace, toolsDir)

    const sourceCode = `
import { tool } from "@opencode-ai/plugin/tool"
import { z } from "zod"

export const echo_tool = tool({
  description: "Echoes input text",
  args: {
    msg: z.string().describe("Message to echo"),
  },
  async execute(args) {
    return { output: args.msg }
  }
})
`

    const res = await toolMaker.synthesize({
      toolName: "echo_tool",
      intent: "Echoes input text",
      sourceCode,
      sampleInputs: [{ msg: "hello world" }],
      expectedOutputs: [{ output: "hello world" }],
    })

    assert.strictEqual(llmCalled, false)
    assert.strictEqual(res.toolName, "echo_tool")
  })

  it("should normalize model-provided test code import paths", () => {
    const rawTest1 = `import { my_tool } from "./my_tool"`
    assert.strictEqual(
      LiveToolMaker.normalizeTestCodeImports("my_tool", rawTest1),
      `import { my_tool } from "../src/my_tool.js"`
    )

    const rawTest2 = `import { my_tool } from "../../src/my_tool.js"`
    assert.strictEqual(
      LiveToolMaker.normalizeTestCodeImports("my_tool", rawTest2),
      `import { my_tool } from "../src/my_tool.js"`
    )

    const rawTest3 = `import { my_tool } from "../src/my_tool"`
    assert.strictEqual(
      LiveToolMaker.normalizeTestCodeImports("my_tool", rawTest3),
      `import { my_tool } from "../src/my_tool.js"`
    )

    const rawTest4 = `import { my_tool } from "./my_tool.js"`
    assert.strictEqual(
      LiveToolMaker.normalizeTestCodeImports("my_tool", rawTest4),
      `import { my_tool } from "../src/my_tool.js"`
    )

    // Unrelated imports untouched
    const rawTest5 = `import { describe, it } from "node:test"\nimport assert from "node:assert"`
    assert.strictEqual(
      LiveToolMaker.normalizeTestCodeImports("my_tool", rawTest5),
      rawTest5
    )
  })

  it("should successfully register and sandbox-test a tool when model writes ./ relative imports in testCode", async () => {
    const mockBridge: any = {}
    const toolMaker = new LiveToolMaker(mockBridge, testWorkspace, toolsDir)

    const sourceCode = `
import { tool } from "@opencode-ai/plugin/tool"
import { z } from "zod"

export const sample_tool = tool({
  description: "Sample",
  args: {},
  async execute() {
    return { output: "ok" }
  }
})
`

    // Model writes import from "./sample_tool" as seen in session-ses_f746.md
    const testCode = `
import { describe, it } from "node:test"
import assert from "node:assert"
import { sample_tool } from "./sample_tool"

describe("sample_tool test", () => {
  it("executes cleanly", async () => {
    const res = await sample_tool.execute({}, { directory: process.cwd() })
    assert.strictEqual(res.output, "ok")
  })
})
`

    const res = await toolMaker.registerDirect({
      toolName: "sample_tool",
      description: "Sample tool",
      sourceCode,
      testCode,
    })

    assert.strictEqual(res.toolName, "sample_tool")
  })

  it("should self-repair on sandbox failure and succeed on retry 1 (attempt 2)", async () => {
    let callCount = 0
    const promptsReceived: string[] = []

    const mockBridge: any = {
      promptJson: async (opts: any) => {
        callCount++
        promptsReceived.push(opts.userPrompt)

        if (callCount === 1) {
          // Initial generation: buggy code where output is wrong
          return {
            toolName: "auto_fix_tool",
            sourceCode: `
import { tool } from "@opencode-ai/plugin/tool"
import { z } from "zod"
export const auto_fix_tool = tool({
  description: "Test tool",
  args: { val: z.number() },
  async execute(args) {
    return { output: String(args.val + 1) } // Buggy: outputs 11 instead of 10
  }
})`,
            testCode: `
import { describe, it } from "node:test"
import assert from "node:assert"
import { auto_fix_tool } from "../src/auto_fix_tool.js"
describe("auto_fix_tool test", () => {
  it("should return val as-is", async () => {
    const res = await auto_fix_tool.execute({ val: 10 }, { directory: process.cwd() })
    assert.strictEqual(res.output, "10")
  })
})`,
            zodSchemaDefinition: "",
          }
        } else {
          // Repaired generation: fixed implementation
          return {
            toolName: "auto_fix_tool",
            sourceCode: `
import { tool } from "@opencode-ai/plugin/tool"
import { z } from "zod"
export const auto_fix_tool = tool({
  description: "Test tool",
  args: { val: z.number() },
  async execute(args) {
    return { output: String(args.val) } // Fixed!
  }
})`,
            testCode: `
import { describe, it } from "node:test"
import assert from "node:assert"
import { auto_fix_tool } from "../src/auto_fix_tool.js"
describe("auto_fix_tool test", () => {
  it("should return val as-is", async () => {
    const res = await auto_fix_tool.execute({ val: 10 }, { directory: process.cwd() })
    assert.strictEqual(res.output, "10")
  })
})`,
            zodSchemaDefinition: "",
          }
        }
      },
    }

    const toolMaker = new LiveToolMaker(mockBridge, testWorkspace, toolsDir)
    const result = await toolMaker.synthesize({
      toolName: "auto_fix_tool",
      intent: "Returns val as string",
      sampleInputs: [{ val: 10 }],
      expectedOutputs: [{ output: "10" }],
    })

    assert.strictEqual(callCount, 2, "LLM should be called twice (initial + 1 repair)")
    assert.strictEqual(result.attempts, 2)
    assert.strictEqual(toolMaker.lastAttemptCount, 2)
    assert.strictEqual(result.status, "ACTIVE")
    assert.deepStrictEqual(result.transitions, [
      "GENERATING",
      "VALIDATING_AST",
      "TESTING_SANDBOX",
      "GENERATING",
      "VALIDATING_AST",
      "TESTING_SANDBOX",
      "ACTIVE",
    ])
    // Verify prompt 2 contained failure details
    assert.ok(promptsReceived[1].includes("Sandbox Test Failure"))
    assert.ok(promptsReceived[1].includes("Retry attempt 1 of 2"))
  })

  it("should exhaust up to 2 retries (3 total sandbox attempts) and throw error on persistent failure", async () => {
    let callCount = 0

    const mockBridge: any = {
      promptJson: async () => {
        callCount++
        return {
          toolName: "always_broken_tool",
          sourceCode: `
import { tool } from "@opencode-ai/plugin/tool"
import { z } from "zod"
export const always_broken_tool = tool({
  description: "Broken tool",
  args: {},
  async execute() {
    return { output: "fail" }
  }
})`,
          testCode: `
import { describe, it } from "node:test"
import assert from "node:assert"
import { always_broken_tool } from "../src/always_broken_tool.js"
describe("always_broken_tool test", () => {
  it("always fails", async () => {
    assert.strictEqual(1, 2)
  })
})`,
          zodSchemaDefinition: "",
        }
      },
    }

    const toolMaker = new LiveToolMaker(mockBridge, testWorkspace, toolsDir)
    await assert.rejects(
      async () => {
        await toolMaker.synthesize({
          toolName: "always_broken_tool",
          intent: "Broken tool",
        })
      },
      (err: any) => {
        assert.ok(err.message.includes("failed sandbox verification after 3 attempts (2 retries exhausted)"))
        return true
      }
    )

    assert.strictEqual(callCount, 3, "LLM should be called 3 times (1 initial + 2 retries)")
    assert.strictEqual(toolMaker.lastAttemptCount, 3)
    assert.ok(toolMaker.lastTransitions.includes("REJECTED"))
  })

  it("should support TestSandbox.execute alias method", async () => {
    const { TestSandbox } = await import("../src/tools/test-sandbox.js")
    const sandbox = new TestSandbox(testWorkspace)
    assert.strictEqual(typeof sandbox.execute, "function")
    const testFile = path.join(toolsDir, "tests", "sample_tool.test.ts")
    const report = await sandbox.execute(testFile)
    assert.strictEqual(report.passed, true)
    assert.strictEqual(typeof report.stdout, "string")
    assert.strictEqual(typeof report.stderr, "string")
  })

  it("should accurately synthesize mock values from Zod schemas", async () => {
    const { z } = await import("zod")
    const { synthesizeMockValue, synthesizeSampleInputs } = await import(
      "../src/tools/tool-prompts.js"
    )

    const schemaArgs = {
      nums: z.array(z.number()),
      name: z.string(),
      count: z.number(),
      active: z.boolean(),
      mode: z.enum(["a", "b"]),
      opt: z.string().optional(),
      config: z.object({
        limit: z.number(),
      }),
    }

    const synthesized = synthesizeSampleInputs(schemaArgs)
    assert.deepStrictEqual(synthesized.nums, [1])
    assert.strictEqual(synthesized.name, "test")
    assert.strictEqual(synthesized.count, 1)
    assert.strictEqual(synthesized.active, true)
    assert.strictEqual(synthesized.mode, "a")
    assert.strictEqual(synthesized.opt, undefined)
    assert.deepStrictEqual(synthesized.config, { limit: 1 })
  })

  it("should auto-synthesize valid mock inputs and pass deterministic test when tool has required args and sampleInputs is omitted", async () => {
    const mockBridge: any = {}
    const toolMaker = new LiveToolMaker(mockBridge, testWorkspace, toolsDir)

    // Tool has required args (numbers array) and does not do defensive undefined checks
    const sourceCode = `
import { tool } from "@opencode-ai/plugin/tool"
import { z } from "zod"

export const calc_stats = tool({
  description: "Computes statistics for numbers",
  args: {
    numbers: z.array(z.number()).describe("Array of numbers"),
    label: z.string().describe("Label"),
  },
  async execute(args) {
    // Relies directly on args.numbers being defined and having elements
    const count = args.numbers.length
    const sum = args.numbers.reduce((a, b) => a + b, 0)
    return {
      output: JSON.stringify({ label: args.label, count, sum })
    }
  }
})
`

    // Do NOT pass testCode or sampleInputs
    const res = await toolMaker.registerDirect({
      toolName: "calc_stats",
      description: "Computes statistics for numbers",
      sourceCode,
    })

    assert.strictEqual(res.status, "ACTIVE")
    assert.strictEqual(res.attempts, 1)
    assert.ok(res.testCode.includes("synthesizeMockValue"))
  })
})

