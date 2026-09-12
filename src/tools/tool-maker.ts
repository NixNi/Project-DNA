/**
 * LLM Tool Maker Engine (LATM Paradigm)
 * Synthesizes reusable TypeScript tools, verifies them with synthetic unit tests
 * in an isolated subprocess, and handles self-repair retry loops.
 */

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
  ASTValidationReport,
} from "../../specs/contracts/live-tools.js"
import {
  buildInitialPrompt,
  buildRepairPrompt,
  buildDirectRepairPrompt,
  generateDeterministicTest,
} from "./tool-prompts.js"

export class LiveToolMaker implements ILiveToolMaker {
  private sandbox: TestSandbox
  public lastAttemptCount: number = 0
  public lastTransitions: string[] = []
  public currentStatus?: string

  constructor(
    private llmBridge: OpenCodeLLMBridge,
    private workspaceDir: string,
    private toolsDir: string
  ) {
    this.sandbox = new TestSandbox(workspaceDir)
  }

  public async synthesize(
    request: ToolSynthesisRequest,
    onTransition?: (status: string, attempt: number) => void
  ): Promise<ToolSynthesisResult> {
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

    const MAX_RETRIES = 2 // 1 initial attempt + 2 retries = 3 total sandbox attempts
    const transitions: string[] = []
    let attempts = 0

    const recordTransition = (status: string) => {
      transitions.push(status)
      this.lastTransitions = [...transitions]
      this.currentStatus = status
      if (onTransition) {
        onTransition(status, attempts)
      }
    }

    const srcPath = path.join(this.toolsDir, "src", `${request.toolName}.ts`)
    const testPath = path.join(this.toolsDir, "tests", `${request.toolName}.test.ts`)
    await fs.mkdir(path.dirname(srcPath), { recursive: true })
    await fs.mkdir(path.dirname(testPath), { recursive: true })

    let currentSourceCode = ""
    let currentTestCode = ""
    let currentZodSchema = ""
    let lastErrorOutput = ""
    let lastStdout = ""
    let lastStderr = ""

    for (let retry = 0; retry <= MAX_RETRIES; retry++) {
      attempts++
      this.lastAttemptCount = attempts

      // 1. GENERATING
      recordTransition("GENERATING")

      let candidate: ToolSynthesisResult
      if (retry === 0) {
        candidate = await this.promptInitialSynthesis(request)
      } else {
        candidate = await this.promptRepairSynthesis(
          request,
          currentSourceCode,
          currentTestCode,
          lastErrorOutput,
          lastStdout,
          lastStderr,
          retry
        )
      }

      currentSourceCode = candidate.sourceCode
      currentTestCode = this.normalizeTestCodeImports(request.toolName, candidate.testCode)
      currentZodSchema = candidate.zodSchemaDefinition

      // 2. VALIDATING_AST
      recordTransition("VALIDATING_AST")
      const astResult = await this.validateAST(currentSourceCode)
      if (!astResult.valid) {
        const violationMsg = `Tool synthesis failed security AST check: ${astResult.violations.join("; ")}`
        recordTransition("REJECTED")
        throw new Error(violationMsg)
      }

      // Write code to disk (both canonical and versioned for guaranteed ESM hot-reload)
      const timestamp = Date.now()
      const versionedFileName = `${request.toolName}.v${timestamp}.ts`
      const versionedSrcPath = path.join(this.toolsDir, "src", versionedFileName)

      await fs.writeFile(srcPath, currentSourceCode, "utf-8")
      await fs.writeFile(versionedSrcPath, currentSourceCode, "utf-8")
      await fs.writeFile(testPath, currentTestCode, "utf-8")

      // 3. TESTING_SANDBOX
      recordTransition("TESTING_SANDBOX")
      const report = await this.sandbox.execute(testPath)

      if (report.passed) {
        recordTransition("ACTIVE")
        return {
          toolName: request.toolName,
          sourceCode: currentSourceCode,
          testCode: currentTestCode,
          zodSchemaDefinition: currentZodSchema,
          entrypoint: `src/${versionedFileName}`,
          sourceFile: `src/${request.toolName}.ts`,
          requiredPermissions: astResult.requiredPermissions,
          attempts,
          status: "ACTIVE",
          transitions,
        }
      }

      // Record sandbox diagnostic details for next self-repair retry
      lastErrorOutput = report.errorOutput ?? "Unknown test failure"
      lastStdout = report.stdout ?? ""
      lastStderr = report.stderr ?? ""
    }

    // Retries exhausted after 3 total attempts
    recordTransition("REJECTED")
    throw new Error(
      `Tool synthesis for '${request.toolName}' failed sandbox verification after ${attempts} attempts (2 retries exhausted). Error:\n${lastErrorOutput}`
    )
  }

  private async promptInitialSynthesis(
    request: ToolSynthesisRequest
  ): Promise<ToolSynthesisResult> {
    const prompt = buildInitialPrompt(request)

    try {
      return await this.llmBridge.promptJson<ToolSynthesisResult>({
        systemPrompt: "You are an expert TypeScript tool architect. Respond only with raw JSON.",
        userPrompt: prompt,
        useSmallModel: false,
      })
    } catch (primaryErr) {
      // Fallback to small_model if primary model fails or times out
      try {
        return await this.llmBridge.promptJson<ToolSynthesisResult>({
          systemPrompt: "You are an expert TypeScript tool architect. Respond only with raw JSON.",
          userPrompt: prompt,
          useSmallModel: true,
        })
      } catch {
        throw primaryErr
      }
    }
  }

  private async promptRepairSynthesis(
    request: ToolSynthesisRequest,
    currentSource: string,
    currentTest: string,
    errorOutput: string,
    stdout: string,
    stderr: string,
    retryIndex: number
  ): Promise<ToolSynthesisResult> {
    const prompt = buildRepairPrompt(
      request,
      currentSource,
      currentTest,
      errorOutput,
      stdout,
      stderr,
      retryIndex
    )

    try {
      return await this.llmBridge.promptJson<ToolSynthesisResult>({
        systemPrompt: "You are an expert TypeScript debugger and repair engineer. Respond only with raw JSON.",
        userPrompt: prompt,
        useSmallModel: false,
      })
    } catch (primaryErr) {
      try {
        return await this.llmBridge.promptJson<ToolSynthesisResult>({
          systemPrompt: "You are an expert TypeScript debugger and repair engineer. Respond only with raw JSON.",
          userPrompt: prompt,
          useSmallModel: true,
        })
      } catch {
        throw primaryErr
      }
    }
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

    // 2. Prepare and normalize unit test code
    const rawTestCode = request.testCode ?? generateDeterministicTest(request)
    const testCode = this.normalizeTestCodeImports(request.toolName, rawTestCode)

    // 3. Write to disk (both canonical and versioned for guaranteed ESM hot-reload)
    const timestamp = Date.now()
    const versionedFileName = `${request.toolName}.v${timestamp}.ts`
    const versionedSrcPath = path.join(this.toolsDir, "src", versionedFileName)

    const srcPath = path.join(this.toolsDir, "src", `${request.toolName}.ts`)
    const testPath = path.join(this.toolsDir, "tests", `${request.toolName}.test.ts`)

    await fs.mkdir(path.dirname(srcPath), { recursive: true })
    await fs.mkdir(path.dirname(testPath), { recursive: true })

    await fs.writeFile(srcPath, request.sourceCode, "utf-8")
    await fs.writeFile(versionedSrcPath, request.sourceCode, "utf-8")
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
      entrypoint: `src/${versionedFileName}`,
      sourceFile: `src/${request.toolName}.ts`,
      requiredPermissions: astResult.requiredPermissions,
      attempts: 1,
      status: "ACTIVE",
      transitions: ["VALIDATING_AST", "TESTING_SANDBOX", "ACTIVE"],
    }
  }

  public async validateAST(
    sourceCode: string,
    options?: { strict?: boolean }
  ): Promise<ASTValidationReport> {
    return ASTValidator.validate(sourceCode, options)
  }

  public async verifyInSandbox(toolName: string, testCode: string): Promise<ToolVerificationReport> {
    const testPath = path.join(this.toolsDir, "tests", `${toolName}.test.ts`)
    await fs.writeFile(testPath, testCode, "utf-8")
    return this.sandbox.execute(testPath)
  }

  public async repair(
    toolName: string,
    errorOutput: string,
    stdout = "",
    stderr = ""
  ): Promise<ToolSynthesisResult> {
    const srcPath = path.join(this.toolsDir, "src", `${toolName}.ts`)
    const testPath = path.join(this.toolsDir, "tests", `${toolName}.test.ts`)

    const currentSrc = await fs.readFile(srcPath, "utf-8").catch(() => "")
    const currentTest = await fs.readFile(testPath, "utf-8").catch(() => "")

    const prompt = buildDirectRepairPrompt(
      toolName,
      currentSrc,
      currentTest,
      errorOutput,
      stdout,
      stderr
    )

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

    const repairedTestCode = this.normalizeTestCodeImports(toolName, repaired.testCode)
    await fs.writeFile(srcPath, repaired.sourceCode, "utf-8")
    await fs.writeFile(testPath, repairedTestCode, "utf-8")

    const report = await this.sandbox.execute(testPath)
    if (!report.passed) {
      throw new Error(`Repaired tool failed verification again: ${report.errorOutput}`)
    }

    return {
      ...repaired,
      testCode: repairedTestCode,
    }
  }

  public static normalizeTestCodeImports(toolName: string, testCode: string): string {
    const regex = new RegExp(
      `from\\s+["'](?:\\.{1,2}\\/)*(?:src\\/)?${toolName}(?:\\.[jt]s)?["']`,
      "g"
    )
    return testCode.replace(regex, `from "../src/${toolName}.js"`)
  }

  public normalizeTestCodeImports(toolName: string, testCode: string): string {
    return LiveToolMaker.normalizeTestCodeImports(toolName, testCode)
  }
}
