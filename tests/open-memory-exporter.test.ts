import { describe, it, before, after } from "node:test"
import assert from "node:assert"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { UniversalSqliteDatabase } from "../src/core/sqlite-adapter.js"
import { MemoryStore } from "../src/memory/memory-store.js"
import { OpenMemoryExporter } from "../src/memory/open-memory-exporter.js"

describe("OpenMemoryExporter", () => {
  const dbPathA = path.resolve("./test-export-a.db")
  const dbPathB = path.resolve("./test-export-b.db")
  const exportFile = path.resolve("./test-export.json")

  let dbA: UniversalSqliteDatabase
  let dbB: UniversalSqliteDatabase
  let storeA: MemoryStore
  let storeB: MemoryStore

  before(async () => {
    dbA = new UniversalSqliteDatabase(dbPathA)
    dbB = new UniversalSqliteDatabase(dbPathB)
    storeA = new MemoryStore(dbA)
    storeB = new MemoryStore(dbB)
    await storeA.init()
    await storeB.init()
  })

  after(async () => {
    dbA.close()
    dbB.close()
    await fs.unlink(dbPathA).catch(() => {})
    await fs.unlink(dbPathB).catch(() => {})
    await fs.unlink(exportFile).catch(() => {})
  })

  it("should export from one store and import into another", async () => {
    await storeA.createCard({
      title: "Shared Convention",
      category: "CODEBASE_CONVENTION",
      insight: "Exported memory persists everywhere.",
      context: "global team sync",
      tags: ["open-memory", "standards"],
    })

    const exporterA = new OpenMemoryExporter(storeA)
    await exporterA.exportToFile(exportFile)

    const fileStat = await fs.stat(exportFile)
    assert.ok(fileStat.size > 50)

    const exporterB = new OpenMemoryExporter(storeB)
    const importedCount = await exporterB.importFromFile(exportFile)
    assert.strictEqual(importedCount, 1)

    const importedCard = await storeB.queryRelevant("Shared Convention", 1)
    assert.strictEqual(importedCard.length, 1)
    assert.strictEqual(importedCard[0].title, "Shared Convention")
  })
})
