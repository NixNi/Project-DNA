import { describe, it } from "node:test"
import assert from "node:assert"
import { PluginNotifier } from "../src/core/notifier.js"

describe("PluginNotifier", () => {
  it("should dispatch toast when client.tui.showToast is available", async () => {
    const toasts: any[] = []
    const mockClient = {
      tui: {
        showToast: async (opts: any) => {
          toasts.push(opts)
          return true
        },
      },
    }

    const notifier = new PluginNotifier(mockClient)
    await notifier.notifyToolCreated("csv_parser", "synthesized")
    await notifier.notifySkillHarvested("docker-deploy", 0.92)

    assert.strictEqual(toasts.length, 2)
    assert.strictEqual(toasts[0].body.title, "[Project DNA] LiveTool Synthesized")
    assert.ok(toasts[0].body.message.includes("csv_parser"))
    assert.strictEqual(toasts[0].body.variant, "success")

    assert.strictEqual(toasts[1].body.title, "[Project DNA] LiveSkill Harvested")
    assert.ok(toasts[1].body.message.includes("docker-deploy"))
    assert.ok(toasts[1].body.message.includes("92%"))
  })

  it("should fall back gracefully to console when client.tui is not provided or throws", async () => {
    const errorClient = {
      tui: {
        showToast: async () => {
          throw new Error("TUI not connected")
        },
      },
    }

    const notifier = new PluginNotifier(errorClient)
    // Should not throw
    await notifier.notifyToolCreated("memory_indexer", "registered")
    await notifier.notify({ message: "General info notification", variant: "info" })
    await notifier.notify({ message: "Warning notification", variant: "warning" })
    await notifier.notify({ message: "Failure notification", variant: "error" })
  })
})
