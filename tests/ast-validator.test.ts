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

  it("should reject tools using indirect eval (0, eval)()", () => {
    const code = `
      import { tool } from "@opencode-ai/plugin/tool"
      import { z } from "zod"
      export const indirectEval = tool({
        description: "indirect eval",
        args: {},
        async execute() {
          (0, eval)("malicious()")
          return { output: "done" }
        }
      })
    `
    const res = ASTValidator.validate(code)
    assert.strictEqual(res.valid, false)
    assert.ok(res.violations.some((v) => v.includes("eval()")))
  })

  it("should reject tools using globalThis.eval() or globalThis['eval']()", () => {
    const code = `
      import { tool } from "@opencode-ai/plugin/tool"
      import { z } from "zod"
      export const globalEval = tool({
        description: "global eval",
        args: {},
        async execute() {
          globalThis.eval("malicious()")
          return { output: "done" }
        }
      })
    `
    const res = ASTValidator.validate(code)
    assert.strictEqual(res.valid, false)
    assert.ok(res.violations.some((v) => v.includes("eval()")))
  })

  it("should reject tools using Function() without new", () => {
    const code = `
      import { tool } from "@opencode-ai/plugin/tool"
      import { z } from "zod"
      export const dynamicFn = tool({
        description: "Function constructor",
        args: {},
        async execute() {
          const fn = Function("return 42")
          return { output: String(fn()) }
        }
      })
    `
    const res = ASTValidator.validate(code)
    assert.strictEqual(res.valid, false)
    assert.ok(res.violations.some((v) => v.includes("new Function()")))
  })

  it("should reject tools using process.exit() and process['exit']()", () => {
    const code = `
      import { tool } from "@opencode-ai/plugin/tool"
      import { z } from "zod"
      export const exitTool = tool({
        description: "bad",
        args: {},
        async execute() {
          process["exit"](1)
        }
      })
    `
    const res = ASTValidator.validate(code)
    assert.strictEqual(res.valid, false)
    assert.ok(res.violations.some((v) => v.includes("process.exit()")))
  })

  it("should reject tools using process.kill()", () => {
    const code = `
      import { tool } from "@opencode-ai/plugin/tool"
      import { z } from "zod"
      export const killTool = tool({
        description: "kill",
        args: {},
        async execute() {
          process.kill(1234)
          return { output: "killed" }
        }
      })
    `
    const res = ASTValidator.validate(code)
    assert.strictEqual(res.valid, false)
    assert.ok(res.violations.some((v) => v.includes("process.kill()")))
  })

  it("should reject tools modifying prototype via Object.setPrototypeOf", () => {
    const code = `
      import { tool } from "@opencode-ai/plugin/tool"
      import { z } from "zod"
      export const protoTool = tool({
        description: "proto",
        args: {},
        async execute() {
          Object.setPrototypeOf({}, null)
          return { output: "done" }
        }
      })
    `
    const res = ASTValidator.validate(code)
    assert.strictEqual(res.valid, false)
    assert.ok(res.violations.some((v) => v.toLowerCase().includes("prototype")))
  })

  it("should classify child_process as shell_execution capability in default mode and reject in strict mode", () => {
    const code = `
      import { tool } from "@opencode-ai/plugin/tool"
      import { z } from "zod"
      import * as cp from "node:child_process"
      export const shellTool = tool({
        description: "shell",
        args: {},
        async execute() {
          return { output: "done" }
        }
      })
    `
    const res = ASTValidator.validate(code)
    assert.strictEqual(res.valid, true)
    assert.ok(res.detectedCapabilities.includes("shell_execution"))
    assert.ok(res.requiredPermissions.includes("shell_execution"))
    assert.ok(res.diagnostics?.some((d) => d.rule === "capability-shell_execution"))

    const strictRes = ASTValidator.validate(code, { strict: true })
    assert.strictEqual(strictRes.valid, false)
    assert.ok(strictRes.violations.some((v) => v.includes("shell_execution")))
    assert.ok(strictRes.diagnostics?.some((d) => d.rule === "permission-shell_execution"))
  })

  it("should classify raw network modules and fetch as network capabilities", () => {
    const codeNet = `
      import { tool } from "@opencode-ai/plugin/tool"
      import { z } from "zod"
      import net from "net"
      export const netTool = tool({
        description: "net",
        args: {},
        async execute() {
          return { output: "done" }
        }
      })
    `
    const resNet = ASTValidator.validate(codeNet)
    assert.strictEqual(resNet.valid, true)
    assert.ok(resNet.detectedCapabilities.includes("raw_socket_access"))

    const codeFetch = `
      import { tool } from "@opencode-ai/plugin/tool"
      import { z } from "zod"
      export const fetchTool = tool({
        description: "fetch",
        args: {},
        async execute() {
          const res = await fetch("https://api.github.com")
          return { output: "fetched" }
        }
      })
    `
    const resFetch = ASTValidator.validate(codeFetch)
    assert.strictEqual(resFetch.valid, true)
    assert.ok(resFetch.detectedCapabilities.includes("network_access"))
  })

  it("should classify fs write operations as filesystem_write capability", () => {
    const code = `
      import { tool } from "@opencode-ai/plugin/tool"
      import { z } from "zod"
      import * as fs from "node:fs/promises"
      export const writeTool = tool({
        description: "write",
        args: {},
        async execute() {
          await fs.writeFile("file.txt", "content")
          return { output: "done" }
        }
      })
    `
    const res = ASTValidator.validate(code)
    assert.strictEqual(res.valid, true)
    assert.ok(res.detectedCapabilities.includes("filesystem_write"))
  })

  it("should reject dynamic imports with non-literal specifiers", () => {
    const code = `
      import { tool } from "@opencode-ai/plugin/tool"
      import { z } from "zod"
      export const dynTool = tool({
        description: "dynamic",
        args: {},
        async execute() {
          const mod = "fs"
          await import(mod)
          return { output: "done" }
        }
      })
    `
    const res = ASTValidator.validate(code)
    assert.strictEqual(res.valid, false)
    assert.ok(res.violations.some((v) => v.includes("non-literal specifier")))
  })

  it("should allow comments and string literals containing forbidden keywords", () => {
    const code = `
      import { tool } from "@opencode-ai/plugin/tool"
      import { z } from "zod"
      // Security warning: never use eval() or process.exit() or obj.__proto__!
      /* Multi-line warning:
         execSync is dangerous.
      */
      export const docTool = tool({
        description: "Explains why eval() is bad",
        args: {},
        async execute() {
          const message = "Avoid eval() and process.exit() in production"
          return { output: message }
        }
      })
    `
    const res = ASTValidator.validate(code)
    assert.strictEqual(res.valid, true, `Expected valid but got: ${res.violations.join(", ")}`)
    assert.strictEqual(res.violations.length, 0)
  })

  it("should reject tools missing required tool import or zod import", () => {
    const codeWithoutZod = `
      import { tool } from "@opencode-ai/plugin/tool"
      export const noZod = tool({
        description: "no zod",
        args: {},
        async execute() { return { output: "done" } }
      })
    `
    const res = ASTValidator.validate(codeWithoutZod)
    assert.strictEqual(res.valid, false)
    assert.ok(res.violations.some((v) => v.includes("zod")))
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

  it("should reject direct access to process.binding and process.dlopen", () => {
    const bindingCode = `
      import { tool } from "@opencode-ai/plugin/tool"
      import { z } from "zod"
      export const bindingTool = tool({
        description: "binding",
        args: {},
        async execute() {
          ;(process as any).binding("spawn_sync")
          return { output: "done" }
        }
      })
    `
    const rBinding = ASTValidator.validate(bindingCode)
    assert.strictEqual(rBinding.valid, false)
    assert.ok(rBinding.diagnostics?.some((d) => d.rule === "no-process-binding"))

    const dlopenCode = `
      import { tool } from "@opencode-ai/plugin/tool"
      import { z } from "zod"
      export const dlopenTool = tool({
        description: "dlopen",
        args: {},
        async execute() {
          ;(process as any).dlopen({}, "addon.node")
          return { output: "done" }
        }
      })
    `
    const rDlopen = ASTValidator.validate(dlopenCode)
    assert.strictEqual(rDlopen.valid, false)
    assert.ok(rDlopen.diagnostics?.some((d) => d.rule === "no-process-dlopen"))
  })

  it("should reject prototype tampering via Object.defineProperties, Reflect.defineProperty, and Reflect.set", () => {
    const codeDefineProperties = `
      import { tool } from "@opencode-ai/plugin/tool"
      import { z } from "zod"
      export const protoTool = tool({
        description: "defineProperties",
        args: {},
        async execute() {
          Object.defineProperties(Object.prototype, { polluted: { value: true } })
          return { output: "done" }
        }
      })
    `
    const rProps = ASTValidator.validate(codeDefineProperties)
    assert.strictEqual(rProps.valid, false)
    assert.ok(rProps.diagnostics?.some((d) => d.rule === "no-prototype-pollution"))

    const codeReflectSet = `
      import { tool } from "@opencode-ai/plugin/tool"
      import { z } from "zod"
      export const protoTool2 = tool({
        description: "reflect set",
        args: {},
        async execute() {
          Reflect.set(Array.prototype, "polluted", true)
          return { output: "done" }
        }
      })
    `
    const rReflectSet = ASTValidator.validate(codeReflectSet)
    assert.strictEqual(rReflectSet.valid, false)
    assert.ok(rReflectSet.diagnostics?.some((d) => d.rule === "no-prototype-pollution"))
  })

  it("should detect filesystem_write capability for destructured require('fs') and direct require('fs')", () => {
    const directCode = `
      import { tool } from "@opencode-ai/plugin/tool"
      import { z } from "zod"
      export const fsTool = tool({
        description: "direct require fs",
        args: {},
        async execute() {
          require("fs").writeFileSync("output.txt", "hello")
          return { output: "done" }
        }
      })
    `
    const rDirect = ASTValidator.validate(directCode)
    assert.strictEqual(rDirect.valid, true)
    assert.ok(rDirect.detectedCapabilities.includes("filesystem_write"))

    const destructCode = `
      import { tool } from "@opencode-ai/plugin/tool"
      import { z } from "zod"
      export const fsTool2 = tool({
        description: "destructured require fs",
        args: {},
        async execute() {
          const { writeFile } = require("fs")
          await writeFile("output.txt", "hello")
          return { output: "done" }
        }
      })
    `
    const rDestruct = ASTValidator.validate(destructCode)
    assert.strictEqual(rDestruct.valid, true)
    assert.ok(rDestruct.detectedCapabilities.includes("filesystem_write"))
  })
})

