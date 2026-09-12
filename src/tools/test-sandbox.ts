import { spawn } from "node:child_process"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { Platform } from "../core/platform.js"
import type { ToolVerificationReport } from "../../specs/contracts/live-tools.js"

export class TestSandbox {
  constructor(private workingDir: string) {}

  private resolveRunner(absTestPath: string): { runnerCmd: string; runnerArgs: string[] } {
    // 1. Prioritize Bun if available (natively runs TypeScript and ESM)
    const candidateBunPaths = Platform.getCandidateBunPaths()
    const foundBun = Platform.resolveBinary(candidateBunPaths, "")

    if (foundBun) {
      return {
        runnerCmd: foundBun,
        runnerArgs: ["test", absTestPath],
      }
    }

    // 2. Fall back to Node. Ensure we never use OpenCode executable
    const candidateNodePaths = Platform.getCandidateNodePaths()
    const foundNode = Platform.resolveBinary(candidateNodePaths, "node")

    return {
      runnerCmd: foundNode,
      runnerArgs: ["--test", absTestPath],
    }
  }

  /**
   * Executes the generated test suite in an isolated subprocess (alias for runTestFile)
   */
  public async execute(
    testFilePath: string,
    timeoutMs = 5000
  ): Promise<ToolVerificationReport> {
    return this.runTestFile(testFilePath, timeoutMs)
  }

  /**
   * Runs the generated test suite in an isolated subprocess
   */
  public async runTestFile(
    testFilePath: string,
    timeoutMs = 5000
  ): Promise<ToolVerificationReport> {
    const startTime = Date.now()
    const absTestPath = path.isAbsolute(testFilePath)
      ? testFilePath
      : path.resolve(this.workingDir, testFilePath)

    const { runnerCmd, runnerArgs } = this.resolveRunner(absTestPath)
    const env = Platform.buildEnrichedEnv(process.env, { NODE_ENV: "test" })

    return new Promise((resolve) => {
      let stdout = ""
      let stderr = ""
      let timedOut = false

      const child = spawn(runnerCmd, runnerArgs, {
        cwd: this.workingDir,
        env,
      })

      const timer = setTimeout(() => {
        timedOut = true
        Platform.safeKill(child)
      }, timeoutMs)

      child.stdout.on("data", (data) => {
        stdout += data.toString()
      })

      child.stderr.on("data", (data) => {
        stderr += data.toString()
      })

      child.on("close", (code) => {
        clearTimeout(timer)
        const duration = Date.now() - startTime
        const toolName = path.basename(testFilePath).replace(/\.test\.(ts|js)$/, "")

        if (timedOut) {
          resolve({
            toolName,
            passed: false,
            testsRun: 0,
            testsFailed: 1,
            durationMs: duration,
            errorOutput: `Test execution timed out after ${timeoutMs}ms`,
            stdout: stdout.trim(),
            stderr: stderr.trim(),
          })
          return
        }

        const passed = code === 0
        resolve({
          toolName,
          passed,
          testsRun: 1,
          testsFailed: passed ? 0 : 1,
          durationMs: duration,
          errorOutput: passed ? undefined : `${stderr}\n${stdout}`.trim(),
          stdout: stdout.trim(),
          stderr: stderr.trim(),
        })
      })

      child.on("error", (err) => {
        clearTimeout(timer)
        resolve({
          toolName: path.basename(testFilePath),
          passed: false,
          testsRun: 0,
          testsFailed: 1,
          durationMs: Date.now() - startTime,
          errorOutput: `Subprocess error: ${err.message}`,
          stdout: "",
          stderr: err.message,
        })
      })
    })
  }
}
