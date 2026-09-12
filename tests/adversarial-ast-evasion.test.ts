/**
 * Comprehensive Empirical Challenger Test Suite — Milestone 2.1
 * AST Security Analysis, Evasion Detection, and Capability Routing Stress Suite
 *
 * Challenger: teamwork_preview_challenger_m21_1
 * Roles: critic, specialist
 */

import { describe, it } from "node:test"
import assert from "node:assert"
import { ASTValidator } from "../src/tools/ast-validator.js"

describe("Empirical Challenger M2.1: AST Security, Evasion & Capability Stress Suite", () => {
  const wrapCode = (
    body: string,
    imports = `import { tool } from "@opencode-ai/plugin/tool"\nimport { z } from "zod"`
  ) => `
${imports}

export const challengeTool = tool({
  description: "Adversarial evaluation tool",
  args: {},
  async execute() {
    ${body}
    return { output: "done" }
  }
})
`

  // =========================================================================
  // CATEGORY 1: Regression Verification of Confirmed Defenses
  // =========================================================================
  describe("Category 1: Confirmed Baseline Defenses (Regression Verification)", () => {
    it("verifies direct eval() is blocked with rule 'no-eval'", () => {
      const code = wrapCode("eval('1+1')")
      const report = ASTValidator.validate(code)
      assert.strictEqual(report.valid, false)
      assert.ok(report.diagnostics?.some((d) => d.rule === "no-eval"))
    })

    it("verifies indirect (0, eval)() is blocked with rule 'no-eval'", () => {
      const code = wrapCode("(0, eval)('1+1')")
      const report = ASTValidator.validate(code)
      assert.strictEqual(report.valid, false)
      assert.ok(report.diagnostics?.some((d) => d.rule === "no-eval"))
    })

    it("verifies eval['call'] and eval['apply'] via string literals are blocked", () => {
      const codeCall = wrapCode("eval['call'](null, '1+1')")
      const reportCall = ASTValidator.validate(codeCall)
      assert.strictEqual(reportCall.valid, false)
      assert.ok(reportCall.diagnostics?.some((d) => d.rule === "no-eval"))

      const codeApply = wrapCode("eval['apply'](null, ['1+1'])")
      const reportApply = ASTValidator.validate(codeApply)
      assert.strictEqual(reportApply.valid, false)
      assert.ok(reportApply.diagnostics?.some((d) => d.rule === "no-eval"))
    })

    it("verifies globalThis.eval and globalThis['eval'] via string literal are blocked", () => {
      const codeDot = wrapCode("globalThis.eval('1+1')")
      const reportDot = ASTValidator.validate(codeDot)
      assert.strictEqual(reportDot.valid, false)
      assert.ok(reportDot.diagnostics?.some((d) => d.rule === "no-eval"))

      const codeBracket = wrapCode("globalThis['eval']('1+1')")
      const reportBracket = ASTValidator.validate(codeBracket)
      assert.strictEqual(reportBracket.valid, false)
      assert.ok(reportBracket.diagnostics?.some((d) => d.rule === "no-eval"))
    })

    it("verifies Function constructor without and with new are blocked with rule 'no-function-constructor'", () => {
      const codeNoNew = wrapCode("Function('return 42')()")
      const reportNoNew = ASTValidator.validate(codeNoNew)
      assert.strictEqual(reportNoNew.valid, false)
      assert.ok(reportNoNew.diagnostics?.some((d) => d.rule === "no-function-constructor"))

      const codeNew = wrapCode("new Function('return 42')()")
      const reportNew = ASTValidator.validate(codeNew)
      assert.strictEqual(reportNew.valid, false)
      assert.ok(reportNew.diagnostics?.some((d) => d.rule === "no-function-constructor"))
    })

    it("verifies globalThis['Function'] via string literal is blocked", () => {
      const code = wrapCode("globalThis['Function']('return 42')()")
      const report = ASTValidator.validate(code)
      assert.strictEqual(report.valid, false)
      assert.ok(report.diagnostics?.some((d) => d.rule === "no-function-constructor"))
    })

    it("verifies process.exit and process.kill direct and string bracket access are blocked", () => {
      const cases = [
        { code: "process.exit(1)", rule: "no-process-exit" },
        { code: "process['exit'](1)", rule: "no-process-exit" },
        { code: "process.kill(100)", rule: "no-process-kill" },
        { code: "process['kill'](100)", rule: "no-process-kill" },
        { code: "globalThis.process.exit(1)", rule: "no-process-exit" },
        { code: "globalThis.process.kill(100)", rule: "no-process-kill" },
      ]
      for (const { code, rule } of cases) {
        const report = ASTValidator.validate(wrapCode(code))
        assert.strictEqual(report.valid, false, `Failed to block ${code}`)
        assert.ok(report.diagnostics?.some((d) => d.rule === rule), `Missing rule ${rule} for ${code}`)
      }
    })

    it("verifies type-asserted (process as any).exit() and .kill() are blocked", () => {
      const reportExit = ASTValidator.validate(wrapCode("(process as any).exit(1)"))
      assert.strictEqual(reportExit.valid, false)
      assert.ok(reportExit.diagnostics?.some((d) => d.rule === "no-process-exit"))

      const reportKill = ASTValidator.validate(wrapCode("(process as any).kill(1)"))
      assert.strictEqual(reportKill.valid, false)
      assert.ok(reportKill.diagnostics?.some((d) => d.rule === "no-process-kill"))
    })

    it("verifies Object.setPrototypeOf and string bracket Object['setPrototypeOf'] are blocked with rule 'no-prototype-pollution'", () => {
      const report1 = ASTValidator.validate(wrapCode("Object.setPrototypeOf({}, null)"))
      assert.strictEqual(report1.valid, false)
      assert.ok(report1.diagnostics?.some((d) => d.rule === "no-prototype-pollution"))

      const report2 = ASTValidator.validate(wrapCode("Object['setPrototypeOf']({}, null)"))
      assert.strictEqual(report2.valid, false)
      assert.ok(report2.diagnostics?.some((d) => d.rule === "no-prototype-pollution"))
    })

    it("verifies prototype pollution via string literal computed property { ['__proto__']: null } is blocked", () => {
      const report = ASTValidator.validate(wrapCode("const x = { ['__proto__']: null }"))
      assert.strictEqual(report.valid, false)
      assert.ok(report.diagnostics?.some((d) => d.rule === "no-prototype-pollution"))
    })

    it("verifies strictly forbidden modules (cluster, worker_threads, v8, vm) are blocked", () => {
      const modules = ["cluster", "worker_threads", "v8", "vm", "node:cluster", "node:worker_threads"]
      for (const mod of modules) {
        const imports = `import { tool } from "@opencode-ai/plugin/tool"\nimport { z } from "zod"\nimport * as fb from "${mod}"`
        const report = ASTValidator.validate(wrapCode("return { output: 'ok' }", imports))
        assert.strictEqual(report.valid, false, `Failed to block static import ${mod}`)
        assert.ok(report.diagnostics?.some((d) => d.rule === "no-forbidden-module"))
      }
    })

    it("verifies dynamic import with non-literal specifier is blocked with rule 'no-dynamic-import'", () => {
      const report = ASTValidator.validate(wrapCode("const mod = 'cluster'; await import(mod)"))
      assert.strictEqual(report.valid, false)
      assert.ok(report.diagnostics?.some((d) => d.rule === "no-dynamic-import"))
    })

    it("verifies syntax errors are rejected with rule 'syntax-error'", () => {
      const report = ASTValidator.validate("export const broken = { if (true }")
      assert.strictEqual(report.valid, false)
      assert.ok(report.diagnostics?.some((d) => d.rule === "syntax-error"))
    })

    it("verifies missing tool() and zod imports are flagged", () => {
      const noZod = `
        import { tool } from "@opencode-ai/plugin/tool"
        export const t = tool({ description: "d", args: {}, async execute() { return {} } })
      `
      const reportNoZod = ASTValidator.validate(noZod)
      assert.strictEqual(reportNoZod.valid, false)
      assert.ok(reportNoZod.diagnostics?.some((d) => d.rule === "missing-zod-import"))

      const noTool = `
        import { z } from "zod"
        export const t = { description: "d", args: {}, async execute() { return {} } }
      `
      const reportNoTool = ASTValidator.validate(noTool)
      assert.strictEqual(reportNoTool.valid, false)
      assert.ok(reportNoTool.diagnostics?.some((d) => d.rule === "missing-tool-import"))
    })
  })

  // =========================================================================
  // CATEGORY 2: Confirmed Developer Capabilities & False-Positive Testing
  // =========================================================================
  describe("Category 2: Developer Capabilities Routing & False-Positive Immunity", () => {
    it("routes child_process to capability 'shell_execution' (valid: true) in default mode", () => {
      const imports = `import { tool } from "@opencode-ai/plugin/tool"\nimport { z } from "zod"\nimport * as cp from "node:child_process"`
      const report = ASTValidator.validate(wrapCode("return { output: 'ok' }", imports))
      assert.strictEqual(report.valid, true)
      assert.deepStrictEqual(report.detectedCapabilities, ["shell_execution"])
      assert.deepStrictEqual(report.requiredPermissions, ["shell_execution"])
      assert.ok(report.diagnostics?.some((d) => d.rule === "capability-shell_execution"))
    })

    it("blocks child_process in strict mode with rule 'permission-shell_execution'", () => {
      const imports = `import { tool } from "@opencode-ai/plugin/tool"\nimport { z } from "zod"\nimport * as cp from "node:child_process"`
      const report = ASTValidator.validate(wrapCode("return { output: 'ok' }", imports), { strict: true })
      assert.strictEqual(report.valid, false)
      assert.ok(report.diagnostics?.some((d) => d.rule === "permission-shell_execution"))
    })

    it("routes network modules (fetch, http, https, axios, undici) to 'network_access'", () => {
      const fetchReport = ASTValidator.validate(wrapCode("await fetch('https://api.github.com')"))
      assert.strictEqual(fetchReport.valid, true)
      assert.ok(fetchReport.detectedCapabilities.includes("network_access"))

      const globalFetchReport = ASTValidator.validate(wrapCode("await globalThis.fetch('https://api.github.com')"))
      assert.strictEqual(globalFetchReport.valid, true)
      assert.ok(globalFetchReport.detectedCapabilities.includes("network_access"))

      const httpImports = `import { tool } from "@opencode-ai/plugin/tool"\nimport { z } from "zod"\nimport http from "http"`
      const httpReport = ASTValidator.validate(wrapCode("return { output: 'ok' }", httpImports))
      assert.strictEqual(httpReport.valid, true)
      assert.ok(httpReport.detectedCapabilities.includes("network_access"))
    })

    it("routes socket modules (net, dgram, tls) to 'raw_socket_access'", () => {
      const netImports = `import { tool } from "@opencode-ai/plugin/tool"\nimport { z } from "zod"\nimport net from "net"`
      const netReport = ASTValidator.validate(wrapCode("return { output: 'ok' }", netImports))
      assert.strictEqual(netReport.valid, true)
      assert.ok(netReport.detectedCapabilities.includes("raw_socket_access"))
    })

    it("routes Bun.$ calls and tagged templates to 'shell_execution'", () => {
      const callReport = ASTValidator.validate(wrapCode("await Bun.$('ls')"))
      assert.strictEqual(callReport.valid, true)
      assert.ok(callReport.detectedCapabilities.includes("shell_execution"))

      const taggedReport = ASTValidator.validate(wrapCode("await Bun.$`ls`"))
      assert.strictEqual(taggedReport.valid, true)
      assert.ok(taggedReport.detectedCapabilities.includes("shell_execution"))
    })

    it("routes fs mutation methods (named and namespace imports) to 'filesystem_write'", () => {
      const namedImports = `import { tool } from "@opencode-ai/plugin/tool"\nimport { z } from "zod"\nimport { writeFile } from "node:fs/promises"`
      const namedReport = ASTValidator.validate(wrapCode("await writeFile('a.txt', 'x')", namedImports))
      assert.strictEqual(namedReport.valid, true)
      assert.ok(namedReport.detectedCapabilities.includes("filesystem_write"))

      const nsImports = `import { tool } from "@opencode-ai/plugin/tool"\nimport { z } from "zod"\nimport * as fs from "fs"`
      const nsReport = ASTValidator.validate(wrapCode("fs.writeFileSync('a.txt', 'x')", nsImports))
      assert.strictEqual(nsReport.valid, true)
      assert.ok(nsReport.detectedCapabilities.includes("filesystem_write"))
    })

    it("passes harmless tools with comments and strings mentioning dangerous keywords without false positives", () => {
      const harmless = `
        import { tool } from "@opencode-ai/plugin/tool"
        import { z } from "zod"
        // eval() and process.exit() are dangerous!
        /* child_process.execSync should not be used carelessly */
        export const t = tool({
          description: "Safe tool with docstrings about eval() and cluster",
          args: { input: z.string() },
          async execute(args) {
            const cwd = process.cwd()
            const platform = process.platform
            const msg = "eval() in string literal is safe"
            return { output: msg + cwd + platform }
          }
        })
      `
      const report = ASTValidator.validate(harmless)
      assert.strictEqual(report.valid, true)
      assert.strictEqual(report.violations.length, 0)
    })
  })

  // =========================================================================
  // CATEGORY 3: Adversarial Evasion Vulnerability Demonstrations (Defect Mining)
  // =========================================================================
  describe("Category 3: Adversarial Evasion Flaws (Empirical Vulnerability Evidence)", () => {
    // -----------------------------------------------------------------------
    // DEFECT GROUP A: NoSubstitutionTemplateLiteral Bracket Access Bypass
    // -----------------------------------------------------------------------
    it("[DEFECT-TMPL-01] globalThis[`eval`]() bypasses AST eval check due to ts.isStringLiteral restriction", () => {
      const code = wrapCode("globalThis[`eval`]('console.log(\"pwned\")')")
      const report = ASTValidator.validate(code)
      // SECURITY ORACLE: This is an eval execution and MUST be rejected (valid === false)
      // Empirical Finding: ASTValidator allows it because ts.isStringLiteral(`eval`) is false.
      assert.strictEqual(
        report.valid,
        false,
        "CRITICAL DEFECT: globalThis[`eval`]() bypassed ASTValidator! Report was valid: true."
      )
    })

    it("[DEFECT-TMPL-02] process[`exit`]() and process[`kill`]() bypass lifecycle checks via template literals", () => {
      const codeExit = wrapCode("process[`exit`](1)")
      const reportExit = ASTValidator.validate(codeExit)
      assert.strictEqual(
        reportExit.valid,
        false,
        "CRITICAL DEFECT: process[`exit`]() bypassed ASTValidator! Report was valid: true."
      )

      const codeKill = wrapCode("process[`kill`](100)")
      const reportKill = ASTValidator.validate(codeKill)
      assert.strictEqual(
        reportKill.valid,
        false,
        "CRITICAL DEFECT: process[`kill`]() bypassed ASTValidator! Report was valid: true."
      )
    })

    it("[DEFECT-TMPL-03] globalThis[`process`].exit(1) and globalThis[`process`][`exit`](1) bypass process object detection", () => {
      const code1 = wrapCode("globalThis[`process`].exit(1)")
      const report1 = ASTValidator.validate(code1)
      assert.strictEqual(
        report1.valid,
        false,
        "CRITICAL DEFECT: globalThis[`process`].exit(1) bypassed ASTValidator! Report was valid: true."
      )

      const code2 = wrapCode("globalThis[`process`][`exit`](1)")
      const report2 = ASTValidator.validate(code2)
      assert.strictEqual(
        report2.valid,
        false,
        "CRITICAL DEFECT: globalThis[`process`][`exit`](1) bypassed ASTValidator! Report was valid: true."
      )
    })

    it("[DEFECT-TMPL-04] globalThis[`Function`]() constructor bypasses Function check via template literal", () => {
      const code = wrapCode("globalThis[`Function`]('return 42')()")
      const report = ASTValidator.validate(code)
      assert.strictEqual(
        report.valid,
        false,
        "CRITICAL DEFECT: globalThis[`Function`]() bypassed ASTValidator! Report was valid: true."
      )
    })

    it("[DEFECT-TMPL-05] Object[`setPrototypeOf`]() bypasses prototype check via template literal", () => {
      const code = wrapCode("Object[`setPrototypeOf`]({}, null)")
      const report = ASTValidator.validate(code)
      assert.strictEqual(
        report.valid,
        false,
        "CRITICAL DEFECT: Object[`setPrototypeOf`]() bypassed ASTValidator! Report was valid: true."
      )
    })

    it("[DEFECT-TMPL-06] { [`__proto__`]: null } and x[`__proto__`] = null bypass prototype pollution check", () => {
      const codeObj = wrapCode("const x = { [`__proto__`]: null }")
      const reportObj = ASTValidator.validate(codeObj)
      assert.strictEqual(
        reportObj.valid,
        false,
        "CRITICAL DEFECT: { [`__proto__`]: null } bypassed ASTValidator! Report was valid: true."
      )

      const codeAssign = wrapCode("const x = {}; (x as any)[`__proto__`] = null")
      const reportAssign = ASTValidator.validate(codeAssign)
      assert.strictEqual(
        reportAssign.valid,
        false,
        "CRITICAL DEFECT: x[`__proto__`] = null bypassed ASTValidator! Report was valid: true."
      )
    })

    // -----------------------------------------------------------------------
    // DEFECT GROUP B: Tagged Template Literal Invocations
    // -----------------------------------------------------------------------
    it("[DEFECT-TAGGED-01] Tagged template eval`console.log('pwned')` bypasses AST check because only Bun.$ is checked in TaggedTemplateExpression", () => {
      const code = wrapCode("eval`console.log('pwned')`")
      const report = ASTValidator.validate(code)
      assert.strictEqual(
        report.valid,
        false,
        "CRITICAL DEFECT: eval`...` tagged template bypassed ASTValidator! Report was valid: true."
      )
    })

    it("[DEFECT-TAGGED-02] Indirect tagged template (0, eval)`console.log('pwned')` bypasses AST check", () => {
      const code = wrapCode("(0, eval)`console.log('pwned')`")
      const report = ASTValidator.validate(code)
      assert.strictEqual(
        report.valid,
        false,
        "CRITICAL DEFECT: (0, eval)`...` tagged template bypassed ASTValidator! Report was valid: true."
      )
    })

    // -----------------------------------------------------------------------
    // DEFECT GROUP C: Direct Property Access Prototype Pollution & Object Methods
    // -----------------------------------------------------------------------
    it("[DEFECT-PROTO-01] Object.prototype.polluted = true bypasses AST check because only ElementAccess was checked for .prototype", () => {
      const code = wrapCode("(Object.prototype as any).polluted = true")
      const report = ASTValidator.validate(code)
      assert.strictEqual(
        report.valid,
        false,
        "CRITICAL DEFECT: Object.prototype.polluted = true bypassed ASTValidator! Report was valid: true."
      )
    })

    it("[DEFECT-PROTO-02] Array.prototype.polluted = true bypasses AST check", () => {
      const code = wrapCode("(Array.prototype as any).polluted = true")
      const report = ASTValidator.validate(code)
      assert.strictEqual(
        report.valid,
        false,
        "CRITICAL DEFECT: Array.prototype.polluted = true bypassed ASTValidator! Report was valid: true."
      )
    })

    it("[DEFECT-PROTO-03] Object.defineProperty(Object.prototype, ...) bypasses AST check", () => {
      const code = wrapCode("Object.defineProperty(Object.prototype, 'polluted', { value: 1 })")
      const report = ASTValidator.validate(code)
      assert.strictEqual(
        report.valid,
        false,
        "CRITICAL DEFECT: Object.defineProperty(Object.prototype, ...) bypassed ASTValidator! Report was valid: true."
      )
    })

    it("[DEFECT-PROTO-04] Object.assign(Object.prototype, ...) bypasses AST check", () => {
      const code = wrapCode("Object.assign(Object.prototype, { polluted: true })")
      const report = ASTValidator.validate(code)
      assert.strictEqual(
        report.valid,
        false,
        "CRITICAL DEFECT: Object.assign(Object.prototype, ...) bypassed ASTValidator! Report was valid: true."
      )
    })

    // -----------------------------------------------------------------------
    // DEFECT GROUP D: Constructor Traversal to Function
    // -----------------------------------------------------------------------
    it("[DEFECT-FN-01] Function constructor via arrow function constructor traversal (() => {}).constructor(...)() bypasses AST check", () => {
      const code = wrapCode("const fn = (() => {}).constructor('return process')(); fn()")
      const report = ASTValidator.validate(code)
      assert.strictEqual(
        report.valid,
        false,
        "CRITICAL DEFECT: (() => {}).constructor(...)() bypassed ASTValidator! Report was valid: true."
      )
    })

    it("[DEFECT-FN-02] Function constructor via String constructor traversal ''.constructor.constructor(...)() bypasses AST check", () => {
      const code = wrapCode("const fn = ''.constructor.constructor('return process')(); fn()")
      const report = ASTValidator.validate(code)
      assert.strictEqual(
        report.valid,
        false,
        "CRITICAL DEFECT: ''.constructor.constructor(...)() bypassed ASTValidator! Report was valid: true."
      )
    })

    // -----------------------------------------------------------------------
    // DEFECT GROUP E: String Concatenation Evasions
    // -----------------------------------------------------------------------
    it("[DEFECT-STR-01] String concatenation globalThis['ev' + 'al']() bypasses AST eval check", () => {
      const code = wrapCode("globalThis['ev' + 'al']('console.log(1)')")
      const report = ASTValidator.validate(code)
      assert.strictEqual(
        report.valid,
        false,
        "HIGH DEFECT: globalThis['ev' + 'al']() bypassed ASTValidator! Report was valid: true."
      )
    })

    it("[DEFECT-STR-02] String concatenation process['ex' + 'it'](1) bypasses AST process check", () => {
      const code = wrapCode("process['ex' + 'it'](1)")
      const report = ASTValidator.validate(code)
      assert.strictEqual(
        report.valid,
        false,
        "HIGH DEFECT: process['ex' + 'it'](1) bypassed ASTValidator! Report was valid: true."
      )
    })

    // -----------------------------------------------------------------------
    // DEFECT GROUP F: Forbidden Modules via CommonJS require & process.mainModule
    // -----------------------------------------------------------------------
    it("[DEFECT-REQ-01] require(`cluster`) with template literal bypasses forbidden module check", () => {
      const code = wrapCode("const c = require(`cluster`)")
      const report = ASTValidator.validate(code)
      assert.strictEqual(
        report.valid,
        false,
        "CRITICAL DEFECT: require(`cluster`) bypassed ASTValidator! Report was valid: true."
      )
    })

    it("[DEFECT-REQ-02] require('clus' + 'ter') with string concatenation bypasses forbidden module check", () => {
      const code = wrapCode("const c = require('clus' + 'ter')")
      const report = ASTValidator.validate(code)
      assert.strictEqual(
        report.valid,
        false,
        "CRITICAL DEFECT: require('clus' + 'ter') bypassed ASTValidator! Report was valid: true."
      )
    })

    it("[DEFECT-REQ-03] process.mainModule.require('cluster') bypasses forbidden module check", () => {
      const code = wrapCode("(process as any).mainModule.require('cluster')")
      const report = ASTValidator.validate(code)
      assert.strictEqual(
        report.valid,
        false,
        "CRITICAL DEFECT: process.mainModule.require('cluster') bypassed ASTValidator! Report was valid: true."
      )
    })

    // -----------------------------------------------------------------------
    // DEFECT GROUP G: Capability Detection Blind Spots
    // -----------------------------------------------------------------------
    it("[DEFECT-CAP-01] fs.promises.writeFile with default fs import fails to detect 'filesystem_write' capability", () => {
      const imports = `import { tool } from "@opencode-ai/plugin/tool"\nimport { z } from "zod"\nimport fs from "fs"`
      const code = wrapCode("await fs.promises.writeFile('test.txt', 'data')", imports)
      const report = ASTValidator.validate(code)
      assert.ok(
        report.detectedCapabilities.includes("filesystem_write"),
        "HIGH DEFECT: fs.promises.writeFile with default fs import was NOT detected as filesystem_write!"
      )
    })

    it("[DEFECT-CAP-02] const fs = require('fs'); fs.writeFileSync() fails to detect 'filesystem_write' capability", () => {
      const code = wrapCode("const fs = require('fs'); fs.writeFileSync('test.txt', 'data')")
      const report = ASTValidator.validate(code)
      assert.ok(
        report.detectedCapabilities.includes("filesystem_write"),
        "HIGH DEFECT: require('fs').writeFileSync was NOT detected as filesystem_write!"
      )
    })
  })
})
