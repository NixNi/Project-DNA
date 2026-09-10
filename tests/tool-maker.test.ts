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
})
