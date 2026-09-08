import { describe, it } from "node:test"
import assert from "node:assert"
import { DiagnosticBank } from "../src/memory/diagnostic-bank.js"

describe("DiagnosticBank", () => {
  it("should record failures and normalize error signatures", async () => {
    const bank = new DiagnosticBank()
    const rawError = "TypeError: Cannot read properties of undefined (reading 'map') at /Users/nixni/app/index.ts:42:15"

    await bank.recordFailure({
      sessionID: "sess-1",
      toolName: "compile",
      rawError,
      resolved: false,
    })

    const active = await bank.getActiveDiagnostics("sess-1")
    assert.strictEqual(active.length, 1)
    assert.ok(active[0].errorSignature.includes("<path>"))
    assert.ok(active[0].errorSignature.includes("<line>:<col>"))
  })

  it("should pair recovery action and mark failure resolved", async () => {
    const bank = new DiagnosticBank()
    await bank.recordFailure({
      sessionID: "sess-2",
      command: "npm test",
      rawError: "Error: Migration failed at 2026-09-08T16:00:00.000Z",
      resolved: false,
    })

    let active = await bank.getActiveDiagnostics("sess-2")
    assert.strictEqual(active.length, 1)

    await bank.recordRecovery("sess-2", "npx prisma migrate resolve --rolled-back")
    active = await bank.getActiveDiagnostics("sess-2")
    assert.strictEqual(active.length, 0)

    const all = await bank.getAllTraces()
    assert.strictEqual(all[0].resolved, true)
    assert.strictEqual(all[0].recoveryAction, "npx prisma migrate resolve --rolled-back")
  })
})
