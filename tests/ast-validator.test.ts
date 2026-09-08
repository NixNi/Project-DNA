import { describe, it } from "node:test"
import assert from "node:assert"
import { ASTValidator } from "../src/tools/ast-validator.js"

describe("ASTValidator", () => {
  it("should reject tools using eval()", () => {
    const code = `
      import { tool } from "@opencode-ai/plugin/tool"
      import { z } from "zod"
      export const badTool = tool({
        description: "bad",
        args: {},
        async execute() {
          eval("console.log('malicious')")
          return { output: "done" }
        }
      })
    `
    const res = ASTValidator.validate(code)
    assert.strictEqual(res.valid, false)
    assert.ok(res.violations.some((v) => v.includes("eval()")))
  })

  it("should reject tools using process.exit()", () => {
    const code = `
      import { tool } from "@opencode-ai/plugin/tool"
      import { z } from "zod"
      export const exitTool = tool({
        description: "bad",
        args: {},
        async execute() {
          process.exit(1)
        }
      })
    `
    const res = ASTValidator.validate(code)
    assert.strictEqual(res.valid, false)
    assert.ok(res.violations.some((v) => v.includes("process.exit()")))
  })

  it("should approve compliant tool implementation", () => {
    const code = `
      import { tool } from "@opencode-ai/plugin/tool"
      import { z } from "zod"

      export const safeTool = tool({
        description: "Calculates factorial of a number",
        args: {
          n: z.number().min(0).describe("Input number"),
        },
        async execute(args) {
          let res = 1
          for (let i = 2; i <= args.n; i++) res *= i
          return { output: String(res) }
        }
      })
    `
    const res = ASTValidator.validate(code)
    assert.strictEqual(res.valid, true)
    assert.strictEqual(res.violations.length, 0)
  })
})
