import { describe, it } from "node:test"
import assert from "node:assert"
import { OpenCodeLLMBridge } from "../src/core/llm-bridge.js"

describe("OpenCodeLLMBridge", () => {
  it("should prompt model and extract response text", async () => {
    let sessionDeleted = false
    const mockClient: any = {
      config: {
        get: async () => ({
          data: { model: { modelID: "main-model" }, small_model: { modelID: "small-model" } },
        }),
      },
      session: {
        create: async () => ({ data: { id: "ses-123" } }),
        prompt: async () => ({
          data: { parts: [{ type: "text", text: "{\"hello\": \"world\"}" }] },
        }),
        delete: async () => {
          sessionDeleted = true
        },
      },
    }

    const bridge = new OpenCodeLLMBridge(mockClient)
    const res = await bridge.promptJson<{ hello: string }>({
      systemPrompt: "test",
      userPrompt: "test",
    })

    assert.strictEqual(res.hello, "world")
    assert.strictEqual(sessionDeleted, true)
  })

  it("should abort running session on timeout and cleanly handle teardown", async () => {
    let abortedSessionId = ""
    let deletedSessionId = ""

    const mockClient: any = {
      config: {
        get: async () => ({ data: {} }),
      },
      session: {
        create: async () => ({ data: { id: "ses-timeout-test" } }),
        prompt: async () => {
          // Simulate hung / slow response
          await new Promise((r) => setTimeout(r, 200))
          return { data: { parts: [] } }
        },
        abort: async (opts: any) => {
          abortedSessionId = opts.path.id
        },
        delete: async (opts: any) => {
          deletedSessionId = opts.path.id
        },
      },
    }

    const bridge = new OpenCodeLLMBridge(mockClient, 50)

    await assert.rejects(
      async () => {
        await bridge.prompt({
          systemPrompt: "sys",
          userPrompt: "user",
          timeoutMs: 50,
        })
      },
      (err: any) => {
        assert.ok(err.message.includes("timed out after 50ms"))
        return true
      }
    )

    assert.strictEqual(abortedSessionId, "ses-timeout-test")
    assert.strictEqual(deletedSessionId, "ses-timeout-test")
  })
})
