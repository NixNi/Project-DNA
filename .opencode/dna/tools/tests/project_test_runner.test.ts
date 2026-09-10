import { describe, it } from "node:test"
import assert from "node:assert"

describe("project_test_runner", () => {
  it("should run with file filter and return output", async () => {
    const mod = await import("../src/project_test_runner.js")
    const result = await mod.project_test_runner.execute(
      { filePattern: "platform", verbose: false },
      { directory: process.cwd() }
    )
    assert.ok(result, "should return a result")
    assert.ok(typeof result.output === "string", "output should be a string")
    assert.ok(result.output.includes("Status:"), "output should contain Status line")
  }, 15000)

  it("should support bail option", async () => {
    const mod = await import("../src/project_test_runner.js")
    const result = await mod.project_test_runner.execute(
      { bail: true },
      { directory: process.cwd() }
    )
    assert.ok(result, "should return a result")
    assert.ok(result.output.includes("Bail: enabled"), "should indicate bail is enabled")
  }, 15000)
})
