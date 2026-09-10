import { tool } from "@opencode-ai/plugin/tool"
import { z } from "zod"
import { spawn } from "node:child_process"
import * as path from "node:path"

export const project_test_runner = tool({
  description:
    "Runs the Project DNA test suite using bun test. Supports filtering by file pattern, test name, bail-on-first-failure, and custom timeout. Returns structured pass/fail results with duration and error details.",
  args: {
    filePattern: z
      .string()
      .optional()
      .describe(
        "Glob pattern to match test files (e.g. 'memory-store'). If omitted, runs all tests."
      ),
    testName: z
      .string()
      .optional()
      .describe(
        "Substring to filter test names (passed as --test-name-pattern)."
      ),
    bail: z
      .boolean()
      .optional()
      .describe("If true, stop on first test failure."),
    timeout: z
      .number()
      .optional()
      .describe("Timeout in milliseconds (default: 60000)."),
    verbose: z
      .boolean()
      .optional()
      .describe("If true, pass --verbose to show individual test results."),
  },
  async execute(args) {
    const startTime = Date.now()
    const timeoutMs = typeof args.timeout === "number" ? args.timeout : 60000
    const testsDir = path.resolve(process.cwd(), "tests")

    const bunArgs: string[] = ["test"]

    if (args.filePattern) {
      bunArgs.push(args.filePattern)
    }

    if (args.testName) {
      bunArgs.push("--test-name-pattern", args.testName)
    }

    if (args.bail) {
      bunArgs.push("--bail")
    }

    if (args.verbose) {
      bunArgs.push("--verbose")
    }

    let stdout = ""
    let stderr = ""
    let timedOut = false

    const result = await new Promise<{
      exitCode: number | null
      timedOut: boolean
      stdout: string
      stderr: string
    }>((resolve) => {
      const child = spawn("bun", bunArgs, {
        cwd: testsDir,
        env: { ...process.env, NODE_ENV: "test" },
        stdio: ["ignore", "pipe", "pipe"],
      })

      const timer = setTimeout(() => {
        timedOut = true
        try {
          child.kill("SIGKILL")
        } catch {
          /* already dead */
        }
      }, timeoutMs)

      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString()
      })

      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString()
      })

      child.on("close", (code) => {
        clearTimeout(timer)
        resolve({ exitCode: code, timedOut, stdout, stderr })
      })

      child.on("error", (err) => {
        clearTimeout(timer)
        resolve({
          exitCode: 1,
          timedOut: false,
          stdout: "",
          stderr: `Subprocess error: ${err.message}`,
        })
      })
    })

    const durationMs = Date.now() - startTime
    const passed = result.exitCode === 0 && !result.timedOut
    const combinedOutput = `${result.stdout}\n${result.stderr}`.trim()

    const summary: string[] = []
    summary.push(`Status: ${result.timedOut ? "TIMED_OUT" : passed ? "PASSED" : "FAILED"}`)
    summary.push(`Duration: ${durationMs}ms`)
    summary.push(`Exit Code: ${result.exitCode}`)

    if (args.filePattern) summary.push(`File Filter: ${args.filePattern}`)
    if (args.testName) summary.push(`Test Filter: ${args.testName}`)
    if (args.bail) summary.push("Bail: enabled")

    if (!passed) {
      summary.push("")
      summary.push("--- Output ---")
      summary.push(combinedOutput || "(no output)")
    }

    return {
      title: passed ? "Tests Passed" : "Tests Failed",
      output: summary.join("\n"),
    }
  },
})
