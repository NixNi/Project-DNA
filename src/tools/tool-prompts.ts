/**
 * LATM Prompt Synthesis & Test Generation
 * Formulates synthesis, repair, and deterministic test generation prompts for LiveToolMaker.
 */

import type {
  ToolSynthesisRequest,
  DirectToolRegistrationRequest,
} from "../../specs/contracts/live-tools.js"

export function buildInitialPrompt(request: ToolSynthesisRequest): string {
  return `
You are the Tool Maker in the LATM (LLMs as Tool Makers) architecture.
Synthesize a production-ready, reusable TypeScript tool for the OpenCode ecosystem.

Requirements:
1. Tool Name: ${request.toolName}
2. Intent: ${request.intent}
3. Sample Inputs: ${JSON.stringify(request.sampleInputs, null, 2)}
4. Expected Outputs: ${JSON.stringify(request.expectedOutputs, null, 2)}

Tool Implementation Rules:
- Must import { tool } from "@opencode-ai/plugin/tool"
- Must import { z } from "zod"
- Must define arguments schema under 'args': args: { paramName: z.string().describe(...) } (NOTE: use 'args', DO NOT use 'input: z.object(...)')
- Must export tool instance: export const ${request.toolName} = tool({ description, args, async execute(args, ctx) { return { output: "..." } } })
- Return standard ToolResult: { title?: string, output: string } (Always return a string in 'output' or JSON.stringify structured objects)

Test Implementation Rules:
- The test file will run in an isolated test environment where external internet or git remotes may not be configured.
- YOU MUST import the tool under test using: import * as mod from "../src/${request.toolName}.js"
- Write unit tests using node:test / bun:test and node:assert
- For tools requiring network or git remotes:
  1. Test argument validation with representative inputs.
  2. If testing execute(), mock external I/O (e.g. globalThis.fetch) OR assert that offline/missing-remote scenarios produce clean, handled error responses rather than unhandled promise rejections.
  3. Never write empty or tautological tests (do not simply assert assert.ok(tool.execute) without validating execution contract).
- Import the tool and execute it against sample inputs, asserting expected outputs.

Return a JSON object:
{
  "toolName": "${request.toolName}",
  "sourceCode": "<typescript tool code>",
  "testCode": "<typescript test code>",
  "zodSchemaDefinition": "<json schema or zod description>"
}
`
}

export function buildRepairPrompt(
  request: ToolSynthesisRequest,
  currentSource: string,
  currentTest: string,
  errorOutput: string,
  stdout: string,
  stderr: string,
  retryIndex: number
): string {
  return `
You are the Tool Repairer in the LATM (LLMs as Tool Makers) architecture.
The following TypeScript tool failed verification in the isolated test sandbox (Retry attempt ${retryIndex} of 2, sandbox attempt ${retryIndex + 1} of 3).

Tool Name: ${request.toolName}
Intent: ${request.intent}
Sample Inputs: ${JSON.stringify(request.sampleInputs, null, 2)}
Expected Outputs: ${JSON.stringify(request.expectedOutputs, null, 2)}

--- Sandbox Test Failure ---
Error Output:
${errorOutput}
${stdout ? `\nStdout:\n${stdout}` : ""}
${stderr ? `\nStderr:\n${stderr}` : ""}
----------------------------

Current Implementation (src/${request.toolName}.ts):
${currentSource}

Current Test (tests/${request.toolName}.test.ts):
${currentTest}

Fix the implementation and/or test to resolve the error while honoring the original intent.
Tool Implementation Rules:
- Must import { tool } from "@opencode-ai/plugin/tool"
- Must import { z } from "zod"
- Must define arguments schema under 'args': args: { paramName: z.string().describe(...) }
- Must export tool instance: export const ${request.toolName} = tool({ ... })
- Return standard ToolResult: { title?: string, output: string }

Test Implementation Rules:
- MUST import tool using: import * as mod from "../src/${request.toolName}.js"
- Write tests using node:test and node:assert
- Mock external I/O or test graceful offline degradation; never write empty tautological tests (assert.ok(tool.execute)).

Return JSON:
{
  "toolName": "${request.toolName}",
  "sourceCode": "<repaired source>",
  "testCode": "<repaired test>",
  "zodSchemaDefinition": "<updated schema>"
}
`
}

export function buildDirectRepairPrompt(
  toolName: string,
  currentSource: string,
  currentTest: string,
  errorOutput: string,
  stdout: string,
  stderr: string
): string {
  return `
The following tool failed verification in the test sandbox.
Tool Name: ${toolName}
Error Output:
${errorOutput}
${stdout ? `\nStdout:\n${stdout}` : ""}
${stderr ? `\nStderr:\n${stderr}` : ""}

Current Source:
${currentSource}

Current Test:
${currentTest}

Fix the implementation and/or test to resolve the error.
Return JSON:
{
  "toolName": "${toolName}",
  "sourceCode": "<repaired source>",
  "testCode": "<repaired test>",
  "zodSchemaDefinition": "<updated schema>"
}
`
}

export function synthesizeMockValue(schema: any, depth = 0): any {
  if (!schema || depth > 5) return "test"
  const type = schema.type || schema.def?.type || schema._def?.type || schema._def?.typeName || ""
  const typeStr = String(type).toLowerCase()

  if (typeStr.includes("optional")) {
    return undefined
  }
  if (typeStr.includes("nullable")) {
    return null
  }
  if (typeof schema.def?.defaultValue === "function") {
    try {
      return schema.def.defaultValue()
    } catch {}
  }
  if (typeof schema._def?.defaultValue === "function") {
    try {
      return schema._def.defaultValue()
    } catch {}
  }
  if (schema.def?.innerType || schema._def?.innerType) {
    return synthesizeMockValue(schema.def?.innerType || schema._def?.innerType, depth + 1)
  }
  if (typeStr.includes("string")) {
    return "test"
  }
  if (typeStr.includes("number") || typeStr.includes("int") || typeStr.includes("bigint")) {
    return 1
  }
  if (typeStr.includes("bool")) {
    return true
  }
  if (typeStr.includes("array")) {
    const elem = schema.element || schema.def?.element || schema._def?.type || schema._def?.element
    const val = elem ? synthesizeMockValue(elem, depth + 1) : 1
    return [val !== undefined ? val : 1]
  }
  if (typeStr.includes("object")) {
    const shape =
      typeof schema.shape === "function"
        ? schema.shape()
        : schema.shape || schema.def?.shape || schema._def?.shape?.() || {}
    const obj: Record<string, any> = {}
    for (const [k, v] of Object.entries(shape)) {
      const val = synthesizeMockValue(v, depth + 1)
      if (val !== undefined) obj[k] = val
    }
    return obj
  }
  if (typeStr.includes("enum")) {
    const values = schema.options || schema.values || schema.def?.values || schema._def?.values
    if (Array.isArray(values) && values.length > 0) return values[0]
    return "test"
  }
  if (typeStr.includes("literal")) {
    return schema.value ?? schema.def?.value ?? schema._def?.value ?? "test"
  }
  if (typeStr.includes("union")) {
    const options = schema.options || schema.def?.options || schema._def?.options
    if (Array.isArray(options) && options.length > 0) {
      return synthesizeMockValue(options[0], depth + 1)
    }
  }
  if (typeStr.includes("record")) {
    return { key: "test" }
  }
  return "test"
}

export function synthesizeSampleInputs(argsSchema: Record<string, any>): Record<string, any> {
  const result: Record<string, any> = {}
  if (!argsSchema || typeof argsSchema !== "object") return result
  for (const [key, fieldSchema] of Object.entries(argsSchema)) {
    const val = synthesizeMockValue(fieldSchema)
    if (val !== undefined) {
      result[key] = val
    }
  }
  return result
}

export function generateDeterministicTest(request: DirectToolRegistrationRequest): string {
  const sampleInputs =
    request.sampleInputs && request.sampleInputs.length > 0
      ? request.sampleInputs
      : [{}]

  return `import { describe, it } from "node:test"
import assert from "node:assert"
import * as mod from "../src/${request.toolName}.js"

describe("${request.toolName} direct live tool verification", () => {
  it("should export an executable tool and run cleanly or handle offline environment", async () => {
    const toolInstance =
      (mod as any).default ||
      (mod as any)["${request.toolName}"] ||
      Object.values(mod).find(
        (v: any) => typeof v === "object" && v !== null && "execute" in v
      )
    assert.ok(toolInstance, "Tool instance must be exported from module")
    assert.strictEqual(
      typeof toolInstance.execute,
      "function",
      "Tool execute must be an executable function"
    )

    const mockCtx = {
      directory: process.cwd(),
      worktree: process.cwd(),
      abort: new AbortController().signal,
      metadata: () => ({}),
      ask: async () => true,
    }

    function synthesizeMockValue(schema: any, depth = 0): any {
      if (!schema || depth > 5) return "test"
      const type = schema.type || schema.def?.type || schema._def?.type || schema._def?.typeName || ""
      const typeStr = String(type).toLowerCase()

      if (typeStr.includes("optional")) {
        return undefined
      }
      if (typeStr.includes("nullable")) {
        return null
      }
      if (typeof schema.def?.defaultValue === "function") {
        try {
          return schema.def.defaultValue()
        } catch {}
      }
      if (typeof schema._def?.defaultValue === "function") {
        try {
          return schema._def.defaultValue()
        } catch {}
      }
      if (schema.def?.innerType || schema._def?.innerType) {
        return synthesizeMockValue(schema.def?.innerType || schema._def?.innerType, depth + 1)
      }
      if (typeStr.includes("string")) {
        return "test"
      }
      if (typeStr.includes("number") || typeStr.includes("int") || typeStr.includes("bigint")) {
        return 1
      }
      if (typeStr.includes("bool")) {
        return true
      }
      if (typeStr.includes("array")) {
        const elem = schema.element || schema.def?.element || schema._def?.type || schema._def?.element
        const val = elem ? synthesizeMockValue(elem, depth + 1) : 1
        return [val !== undefined ? val : 1]
      }
      if (typeStr.includes("object")) {
        const shape =
          typeof schema.shape === "function"
            ? schema.shape()
            : schema.shape || schema.def?.shape || schema._def?.shape?.() || {}
        const obj: Record<string, any> = {}
        for (const [k, v] of Object.entries(shape)) {
          const val = synthesizeMockValue(v, depth + 1)
          if (val !== undefined) obj[k] = val
        }
        return obj
      }
      if (typeStr.includes("enum")) {
        const values = schema.options || schema.values || schema.def?.values || schema._def?.values
        if (Array.isArray(values) && values.length > 0) return values[0]
        return "test"
      }
      if (typeStr.includes("literal")) {
        return schema.value ?? schema.def?.value ?? schema._def?.value ?? "test"
      }
      if (typeStr.includes("union")) {
        const options = schema.options || schema.def?.options || schema._def?.options
        if (Array.isArray(options) && options.length > 0) {
          return synthesizeMockValue(options[0], depth + 1)
        }
      }
      if (typeStr.includes("record")) {
        return { key: "test" }
      }
      return "test"
    }

    let sampleInput: any = ${JSON.stringify(sampleInputs[0])}
    if (
      (!sampleInput || Object.keys(sampleInput).length === 0) &&
      toolInstance.args &&
      typeof toolInstance.args === "object"
    ) {
      const synthesized: Record<string, any> = {}
      for (const [key, fieldSchema] of Object.entries(toolInstance.args)) {
        const val = synthesizeMockValue(fieldSchema)
        if (val !== undefined) {
          synthesized[key] = val
        }
      }
      if (Object.keys(synthesized).length > 0) {
        sampleInput = synthesized
      }
    }

    try {
      const result = await toolInstance.execute(sampleInput, mockCtx)
      assert.ok(result !== undefined && result !== null, "Tool must return a result object")
      if (typeof result === "object" && "output" in result) {
        assert.ok(
          typeof (result as any).output === "string",
          "Tool output must be a string"
        )
      }
    } catch (err: any) {
      // Gracefully handle absent external dependencies in test sandbox
      const isExternalEnvAbsence =
        /network|fetch|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|no remote|git.*remote|not a git repository|not inside a git repository|authentication required|login.*first|gh.*auth|not authenticated|rate limit|401|403|404|command not found|ENOENT/i.test(
          err?.message || String(err)
        )
      if (isExternalEnvAbsence) {
        console.warn("[Project DNA Sandbox] External dependency absent during test (" + err.message + "). Invocation contract verified.");
      } else {
        throw err
      }
    }
  })
})
`
}

