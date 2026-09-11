import { describe, it } from "node:test"
import assert from "node:assert"
import * as mod from "../src/system_info.js"

describe("system_info direct live tool", () => {
  it("should export an executable tool and run successfully", async () => {
    const toolInstance =
      (mod as any).default ||
      (mod as any)["system_info"] ||
      Object.values(mod).find(
        (v: any) => typeof v === "object" && v !== null && "execute" in v
      )
    assert.ok(toolInstance, "Tool instance must be exported from module")
    assert.strictEqual(
      typeof toolInstance.execute,
      "function",
      "Tool execute must be an executable function"
    )
    const sampleInput = {}
    const result = await toolInstance.execute(sampleInput, {
      directory: process.cwd(),
    })
    assert.ok(result !== undefined && result !== null, "Tool must return a result object")
  })
})
