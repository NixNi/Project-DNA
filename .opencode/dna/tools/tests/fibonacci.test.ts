import { describe, it } from "node:test"
import assert from "node:assert"
import * as mod from "../src/fibonacci.js"

describe("fibonacci direct live tool", () => {
  it("should export an executable tool and run successfully", async () => {
    const toolInstance =
      (mod as any).default ||
      (mod as any)["fibonacci"] ||
      Object.values(mod).find(
        (v: any) => typeof v === "object" && v !== null && "execute" in v
      )
    assert.ok(toolInstance, "Tool instance must be exported from module")
    assert.strictEqual(
      typeof toolInstance.execute,
      "function",
      "Tool execute must be an executable function"
    )
    const sampleInput = {"n":0}
    const result = await toolInstance.execute(sampleInput, {
      directory: process.cwd(),
    })
    assert.ok(result !== undefined && result !== null, "Tool must return a result object")
  })
})
