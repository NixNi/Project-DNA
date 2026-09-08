import { describe, it, before, after } from "node:test"
import assert from "node:assert"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { ProjectDNAPlugin } from "../src/index.js"

describe("ProjectDNAPlugin Integration", () => {
  const testWorkspace = path.resolve("./test-workspace-tmp")

  // Mock OpenCode client
  const mockClient: any = {
    config: {
      get: async () => ({
        data: {
          model: { providerID: "test-provider", modelID: "test-model" },
          small_model: { providerID: "test-provider", modelID: "test-small-model" },
        },
      }),
    },
    session: {
      create: async () => ({ data: { id: "mock-subsession-1" } }),
      prompt: async () => ({
        data: {
          parts: [{ type: "text", text: "[]" }],
        },
      }),
      delete: async () => ({}),
    },
  }

  const mockInput: any = {
    client: mockClient,
    directory: testWorkspace,
    worktree: testWorkspace,
    project: { id: "test-project" },
    serverUrl: new URL("http://localhost:3000"),
    $: {} as any,
  }

  before(async () => {
    await fs.mkdir(testWorkspace, { recursive: true })
  })

  after(async () => {
    await fs.rm(testWorkspace, { recursive: true, force: true }).catch(() => {})
  })

  it("should initialize hooks and storage layout", async () => {
    const hooks = await ProjectDNAPlugin(mockInput, {})
    assert.ok(hooks)
    assert.ok(hooks.tool)
    assert.ok(hooks["chat.message"])
    assert.ok(hooks["experimental.session.compacting"])
    assert.ok(hooks["experimental.chat.system.transform"])
    assert.ok(hooks.event)
    assert.ok(hooks.dispose)

    // Verify directory initialization under .opencode/dna
    const dnaPath = path.join(testWorkspace, ".opencode", "dna")
    const stat = await fs.stat(dnaPath)
    assert.ok(stat.isDirectory())

    // Test system prompt injection
    const sysOutput = { system: [] as string[] }
    await hooks["experimental.chat.system.transform"]!({} as any, sysOutput)
    assert.ok(sysOutput.system.some((s) => s.includes("Project DNA is active")))

    // Test chat.message hook
    const chatInput = { sessionID: "sess-test-1" }
    const chatOutput = {
      message: {} as any,
      parts: [{ type: "text", text: "How do I fix database deadlock?" }] as any[],
    }
    await hooks["chat.message"]!(chatInput as any, chatOutput)
    assert.ok(chatOutput.parts.length >= 1)

    // Test tool.execute.before and after
    await hooks["tool.execute.before"]!({
      tool: "git",
      sessionID: "sess-test-1",
      callID: "call-1",
    } as any, { args: {} } as any)

    await hooks["tool.execute.after"]!(
      {
        tool: "git",
        sessionID: "sess-test-1",
        callID: "call-1",
        args: { cmd: "status" },
      },
      {
        title: "git status",
        output: "clean working tree",
        metadata: {},
      }
    )

    // Test experimental.session.compacting
    const compactOutput = { context: [] as string[] }
    await hooks["experimental.session.compacting"]!(
      { sessionID: "sess-test-1" },
      compactOutput
    )
    // Should execute without throwing
    assert.ok(Array.isArray(compactOutput.context))

    // Dispose cleanly
    await hooks.dispose!()
  })
})
