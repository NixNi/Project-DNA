import { describe, it, before, after } from "node:test"
import assert from "node:assert"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { ProjectDNAPlugin } from "../src/index.js"

describe("ProjectDNAPlugin Integration", () => {
  const testWorkspace = path.resolve("./test-workspace-tmp")

  const toasts: any[] = []

  // Mock OpenCode client
  const mockClient: any = {
    tui: {
      showToast: async (opts: any) => {
        toasts.push(opts)
        return true
      },
    },
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
      prompt: async (opts: any) => {
        const text = opts?.body?.parts?.[0]?.text ?? ""
        const sys = opts?.body?.system ?? ""

        if (sys.includes("reviewer") || text.includes("Adversarial Skill Verifier")) {
          return {
            data: {
              parts: [
                {
                  type: "text",
                  text: JSON.stringify({
                    passed: true,
                    score: 0.95,
                    feedback: "Safe, deterministic, and verified.",
                  }),
                },
              ],
            },
          }
        }

        return {
          data: {
            parts: [
              {
                type: "text",
                text: JSON.stringify({
                  name: "git-commit-and-push",
                  description: "Automated git commit and push procedure",
                  triggers: ["commit and push", "deploy branch"],
                  tags: ["git", "workflow"],
                  skillMarkdownContent: `---
name: git-commit-and-push
description: Automated git commit and push procedure
version: 1.0.0
triggers:
  - "commit and push"
tags:
  - "git"
confidence_score: 0.9
---

# Automated git commit and push procedure
Follow standard git commit procedure.
`,
                }),
              },
            ],
          },
        }
      },
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
    assert.ok((hooks.tool as any)["synthesize_live_tool"])
    assert.ok((hooks.tool as any)["register_live_tool"])
    assert.ok((hooks.tool as any)["invoke_live_tool"])
    assert.ok((hooks.tool as any)["list_live_tools"])
    assert.ok(hooks["chat.message"])
    assert.ok(hooks["command.execute.before"])
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
    assert.ok(sysOutput.system.some((s) => s.includes("invoke_live_tool")))

    // Test chat.message hook with user goal recording
    const chatInput = { sessionID: "sess-test-1" }
    const chatOutput = {
      message: {} as any,
      parts: [{ type: "text", text: "How do I fix database deadlock?" }] as any[],
    }
    await hooks["chat.message"]!(chatInput as any, chatOutput)
    assert.ok(chatOutput.parts.length >= 1)

    // Test register_live_tool direct model execution
    const registerTool = (hooks.tool as any)["register_live_tool"]
    assert.ok(registerTool)
    const regResult = await registerTool.execute({
      toolName: "ping_service",
      description: "Pings a service",
      sourceCode: `
import { tool } from "@opencode-ai/plugin/tool"
import { z } from "zod"

export const ping_service = tool({
  description: "Pings a service",
  args: { host: z.string() },
  async execute(args) {
    return { output: "pong: " + args.host }
  }
})
`,
    })
    assert.ok(regResult.output.includes("Tool 'ping_service' was directly registered"))
    assert.ok((hooks.tool as any)["ping_service"])

    // Verify toast notification was dispatched
    assert.ok(toasts.some((t) => t.body.title.includes("LiveTool Registered")))

    // Test invoke_live_tool dispatcher (KV cache preservation pattern)
    const invokeTool = (hooks.tool as any)["invoke_live_tool"]
    assert.ok(invokeTool)
    const invokeResult = await invokeTool.execute({
      toolName: "ping_service",
      args: { host: "127.0.0.1" },
    })
    assert.strictEqual(invokeResult.output, "pong: 127.0.0.1")
    assert.ok(invokeResult.metadata?.telemetry)
    assert.ok(invokeResult.title?.includes("Run #"))

    // Test list_live_tools catalog inspection
    const listTool = (hooks.tool as any)["list_live_tools"]
    assert.ok(listTool)
    const listResult = await listTool.execute({})
    assert.ok(listResult.output.includes("ping_service"))
    assert.ok(listResult.output.includes("parameters"))
    assert.ok(listResult.output.includes("host"))

    // Test registering a tool returning raw object without output (like session-ses_f746.md)
    const regOsTool = await registerTool.execute({
      toolName: "get_os_info",
      description: "Gets OS information",
      sourceCode: `
import { tool } from "@opencode-ai/plugin/tool"
import { z } from "zod"

export const get_os_info = tool({
  description: "Gets OS information",
  args: {},
  async execute() {
    return { platform: "darwin", arch: "arm64" }
  }
})
`,
    })
    assert.ok(regOsTool.output.includes("Tool 'get_os_info' was directly registered"))

    // Invoking get_os_info via invoke_live_tool must return { output: string } without c.split crash
    const invokeOsResult = await invokeTool.execute({
      toolName: "get_os_info",
      args: {},
    })
    assert.strictEqual(typeof invokeOsResult.output, "string")
    assert.ok(invokeOsResult.output.includes('"platform": "darwin"'))
    assert.doesNotThrow(() => invokeOsResult.output.split("\n"))

    // Invoking directly via hooks.tool also must return { output: string } and update stats
    const directExecResult = await (hooks.tool as any)["get_os_info"].execute({})
    assert.strictEqual(typeof directExecResult.output, "string")
    assert.doesNotThrow(() => directExecResult.output.split("\n"))
    assert.ok(directExecResult.title.includes("Run #"))
    assert.ok(directExecResult.metadata?.telemetry)

    // Verify tool description and tool.definition hook maintain stable descriptions (KV cache preservation)
    assert.strictEqual((hooks.tool as any)["get_os_info"].description, "Gets OS information")
    const toolDefOut: any = {}
    await hooks["tool.definition"]!({ toolID: "get_os_info" } as any, toolDefOut)
    assert.strictEqual(toolDefOut.description, "Gets OS information")

    // Test tool.execute.before and tool.execute.after step output capture
    const harvestSess = "sess-harvest-1"
    await hooks["chat.message"]!(
      { sessionID: harvestSess } as any,
      { parts: [{ type: "text", text: "Commit changes and deploy branch" }] } as any
    )

    await hooks["tool.execute.before"]!(
      { tool: "git", sessionID: harvestSess, callID: "c1" } as any,
      { args: { cmd: "status" } } as any
    )
    await hooks["tool.execute.after"]!(
      { tool: "git", sessionID: harvestSess, callID: "c1", args: { cmd: "status" } },
      { title: "git status", output: "modified: app.ts", metadata: {} }
    )

    await hooks["tool.execute.before"]!(
      { tool: "git", sessionID: harvestSess, callID: "c2" } as any,
      { args: { cmd: "commit" } } as any
    )
    await hooks["tool.execute.after"]!(
      { tool: "git", sessionID: harvestSess, callID: "c2", args: { cmd: "commit" } },
      { title: "git commit", output: "[main 1234abc] fix: app.ts", metadata: {} }
    )

    // Trigger OpenCode session.idle event (verifying Bug 1 & 2 fix)
    await hooks.event!({
      event: {
        type: "session.idle",
        properties: { sessionID: harvestSess },
      } as any,
    })

    // Verify skill was harvested, saved, and notified
    const activeSkillDir = path.join(testWorkspace, ".opencode", "dna", "skills", "active")
    const skillMd = await fs.readFile(
      path.join(activeSkillDir, "git-commit-and-push", "SKILL.md"),
      "utf-8"
    )
    assert.ok(skillMd.includes("git-commit-and-push"))
    // Test unregister_live_tool meta-tool
    const unregisterTool = (hooks.tool as any)["unregister_live_tool"]
    assert.ok(unregisterTool, "unregister_live_tool meta-tool must be exposed")

    // Unregistering non-existent tool returns diagnostic with available tools
    const failUnreg = await unregisterTool.execute({ toolName: "non_existent_tool" })
    assert.ok(failUnreg.output.includes("Cannot unregister tool 'non_existent_tool'"))
    assert.ok(failUnreg.output.includes("Available tools:"))

    // Successfully unregister get_os_info
    const unregResult = await unregisterTool.execute({ toolName: "get_os_info" })
    assert.strictEqual(unregResult.title, "Unregistered LiveTool: get_os_info")
    assert.strictEqual((hooks.tool as any)["get_os_info"], undefined)

    // Verify reload_live_tools meta-tool
    const reloadTools = (hooks.tool as any)["reload_live_tools"]
    assert.ok(reloadTools, "reload_live_tools meta-tool must be exposed")
    const reloadResult = await reloadTools.execute({})
    assert.ok(reloadResult.title.includes("Reloaded LiveTools"))
    assert.ok(reloadTools.execute)
    assert.ok((hooks.tool as any)["synthesize_live_tool"])
    assert.ok((hooks.tool as any)["invoke_live_tool"])
    assert.ok((hooks.tool as any)["unregister_live_tool"])
    assert.ok((hooks.tool as any)["reload_live_tools"])

    // Verify system transform includes meta-tool announcements
    if (hooks["experimental.chat.system.transform"]) {
      const transformOut = { system: [] as string[] }
      await hooks["experimental.chat.system.transform"]({} as any, transformOut)
      assert.ok(transformOut.system.some((s) => s.includes("unregister_live_tool")))
    }

    // Dispose cleanly
    await hooks.dispose!()
  })

})
