import * as fs from "node:fs/promises"
import * as path from "node:path"
import type { OpenCodeLLMBridge } from "../core/llm-bridge.js"
import { ASTValidator } from "./ast-validator.js"
import { TestSandbox } from "./test-sandbox.js"
import type {
  ILiveToolMaker,
  ToolSynthesisRequest,
  ToolSynthesisResult,
  ToolVerificationReport,
  DirectToolRegistrationRequest,
} from "../../specs/contracts/live-tools.js"

export class LiveToolMaker implements ILiveToolMaker {
  private sandbox: TestSandbox

  constructor(
    private llmBridge: OpenCodeLLMBridge,
    private workspaceDir: string,
    private toolsDir: string
  ) {
    this.sandbox = new TestSandbox(workspaceDir)
  }

  public async synthesize(request: ToolSynthesisRequest): Promise<ToolSynthesisResult> {
    if (request.sourceCode) {
      return this.registerDirect({
        toolName: request.toolName,
        description: request.intent,
        sourceCode: request.sourceCode,
        testCode: request.testCode,
        sampleInputs: request.sampleInputs,
        expectedOutputs: request.expectedOutputs,
      })
    }

    const prompt = `
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
- Must define arguments schema using Zod with descriptive comments.
- Must export default or named tool instance: export const ${request.toolName} = tool({ description, args, async execute(args, ctx) { ... } })
- Return standard ToolResult: { title?: string, output: string }

Test Implementation Rules:
- Write unit tests using node:test / bun:test and node:assert
- Import the tool and execute it against sample inputs
- Assert the expected outputs

Return a JSON object:
{
  "toolName": "${request.toolName}",
  "sourceCode": "<typescript tool code>",
  "testCode": "<typescript test code>",
  "zodSchemaDefinition": "<json schema or zod description>"
}
`

    let synthesis: ToolSynthesisResult
    try {
      synthesis = await this.llmBridge.promptJson<ToolSynthesisResult>({
        systemPrompt: "You are an expert TypeScript tool architect. Respond only with raw JSON.",
        userPrompt: prompt,
        useSmallModel: false,
      })
    } catch (primaryErr) {
      // Fallback to small_model if primary model fails or times out
      try {
        synthesis = await this.llmBridge.promptJson<ToolSynthesisResult>({
          systemPrompt: "You are an expert TypeScript tool architect. Respond only with raw JSON.",
          userPrompt: prompt,
          useSmallModel: true,
        })
      } catch {
        throw primaryErr
      }
    }

    // 1. Static AST Security Validation
    const astResult = await this.validateAST(synthesis.sourceCode)
    if (!astResult.valid) {
      throw new Error(
        `Tool synthesis failed security AST check: ${astResult.violations.join("; ")}`
      )
    }

    // 2. Write to disk and verify in sandbox
    const srcPath = path.join(this.toolsDir, "src", `${request.toolName}.ts`)
    const testPath = path.join(this.toolsDir, "tests", `${request.toolName}.test.ts`)

    await fs.mkdir(path.dirname(srcPath), { recursive: true })
    await fs.mkdir(path.dirname(testPath), { recursive: true })

    await fs.writeFile(srcPath, synthesis.sourceCode, "utf-8")
    await fs.writeFile(testPath, synthesis.testCode, "utf-8")

    const report = await this.verifyInSandbox(request.toolName, synthesis.testCode)
    if (!report.passed) {
      // Attempt self-repair
      return this.repair(request.toolName, report.errorOutput ?? "Unknown test failure")
    }

    return synthesis
  }

  public async registerDirect(
    request: DirectToolRegistrationRequest
  ): Promise<ToolSynthesisResult> {
    // 1. Static AST Security Validation
    const astResult = await this.validateAST(request.sourceCode)
    if (!astResult.valid) {
      throw new Error(
        `Tool '${request.toolName}' failed security AST check: ${astResult.violations.join("; ")}`
      )
    }

    // 2. Prepare unit test code (use provided or generate automated test)
    const testCode = request.testCode ?? this.generateDeterministicTest(request)

    // 3. Write to disk
    const srcPath = path.join(this.toolsDir, "src", `${request.toolName}.ts`)
    const testPath = path.join(this.toolsDir, "tests", `${request.toolName}.test.ts`)

    await fs.mkdir(path.dirname(srcPath), { recursive: true })
    await fs.mkdir(path.dirname(testPath), { recursive: true })

    await fs.writeFile(srcPath, request.sourceCode, "utf-8")
    await fs.writeFile(testPath, testCode, "utf-8")

    // 4. Verify in sandbox
    const report = await this.verifyInSandbox(request.toolName, testCode)
    if (!report.passed) {
      throw new Error(
        `Direct tool verification failed in sandbox: ${report.errorOutput ?? "Unknown test failure"}`
      )
    }

    return {
      toolName: request.toolName,
      sourceCode: request.sourceCode,
      testCode,
      zodSchemaDefinition: "",
    }
  }

  private generateDeterministicTest(request: DirectToolRegistrationRequest): string {
    const sampleInputs =
      request.sampleInputs && request.sampleInputs.length > 0
        ? request.sampleInputs
        : [{}]

    return `import { describe, it } from "node:test"
import assert from "node:assert"
import * as mod from "../src/${request.toolName}.js"

describe("${request.toolName} direct live tool", () => {
  it("should export an executable tool and run successfully", async () => {
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
    const sampleInput = ${JSON.stringify(sampleInputs[0])}
    const result = await toolInstance.execute(sampleInput, {
      directory: process.cwd(),
    })
    assert.ok(result !== undefined && result !== null, "Tool must return a result object")
  })
})
`
  }

  public async validateAST(sourceCode: string): Promise<{ valid: boolean; violations: string[] }> {
    return ASTValidator.validate(sourceCode)
  }

  public async verifyInSandbox(toolName: string, testCode: string): Promise<ToolVerificationReport> {
    const testPath = path.join(this.toolsDir, "tests", `${toolName}.test.ts`)
    await fs.writeFile(testPath, testCode, "utf-8")
    return this.sandbox.runTestFile(testPath)
  }

  public async repair(toolName: string, errorOutput: string): Promise<ToolSynthesisResult> {
    const srcPath = path.join(this.toolsDir, "src", `${toolName}.ts`)
    const testPath = path.join(this.toolsDir, "tests", `${toolName}.test.ts`)

    const currentSrc = await fs.readFile(srcPath, "utf-8").catch(() => "")
    const currentTest = await fs.readFile(testPath, "utf-8").catch(() => "")

    const prompt = `
The following tool failed verification in the test sandbox.
Tool Name: ${toolName}
Error Output:
${errorOutput}

Current Source:
${currentSrc}

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

    let repaired: ToolSynthesisResult
    try {
      repaired = await this.llmBridge.promptJson<ToolSynthesisResult>({
        systemPrompt: "You are an expert debugger and repair engineer. Respond only with JSON.",
        userPrompt: prompt,
        useSmallModel: false,
      })
    } catch (primaryErr) {
      try {
        repaired = await this.llmBridge.promptJson<ToolSynthesisResult>({
          systemPrompt: "You are an expert debugger and repair engineer. Respond only with JSON.",
          userPrompt: prompt,
          useSmallModel: true,
        })
      } catch {
        throw primaryErr
      }
    }

    const astResult = await this.validateAST(repaired.sourceCode)
    if (!astResult.valid) {
      throw new Error(`Repaired tool failed AST check: ${astResult.violations.join("; ")}`)
    }

    await fs.writeFile(srcPath, repaired.sourceCode, "utf-8")
    await fs.writeFile(testPath, repaired.testCode, "utf-8")

    const report = await this.sandbox.runTestFile(testPath)
    if (!report.passed) {
      throw new Error(`Repaired tool failed verification again: ${report.errorOutput}`)
    }

    return repaired
  }
}
