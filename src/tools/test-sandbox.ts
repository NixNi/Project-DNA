import { spawn } from "node:child_process"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import type { ToolVerificationReport } from "../../specs/contracts/live-tools.js"

export class TestSandbox {
  constructor(private workingDir: string) {}

  /**
   * Runs the generated test suite in an isolated subprocess
   */
  public async runTestFile(
    testFilePath: string,
    timeoutMs = 5000
  ): Promise<ToolVerificationReport> {
    const startTime = Date.now()
    const isBun = typeof (globalThis as any).Bun !== "undefined"
    const runnerCmd = isBun ? "bun" : "node"
    const runnerArgs = isBun ? ["test", testFilePath] : ["--test", testFilePath]

    return new Promise((resolve) => {
      let stdout = ""
      let stderr = ""
      let timedOut = false

      const child = spawn(runnerCmd, runnerArgs, {
        cwd: this.workingDir,
        env: {
          ...process.env,
          NODE_ENV: "test",
        },
      })

      const timer = setTimeout(() => {
        timedOut = true
        child.kill("SIGKILL")
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
        })
      })
    })
  }
}
