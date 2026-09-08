import { describe, it, before, after } from "node:test"
import assert from "node:assert"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { UniversalSqliteDatabase } from "../src/core/sqlite-adapter.js"
import { MemoryStore } from "../src/memory/memory-store.js"

describe("MemoryStore (Zettelkasten Graph)", () => {
  const dbPath = path.resolve("./test-memory.db")
  let db: UniversalSqliteDatabase
  let store: MemoryStore

  before(async () => {
    db = new UniversalSqliteDatabase(dbPath)
    store = new MemoryStore(db)
    await store.init()
  })

  after(async () => {
    db.close()
    await fs.unlink(dbPath).catch(() => {})
  })

  it("should create and retrieve an atomic memory card", async () => {
    const card = await store.createCard(
      {
        title: "Bun Timeout in Unit Tests",
        category: "ERROR_DIAGNOSTIC",
        insight: "Process teardown must be explicitly called for native addons.",
        context: "During tool sandbox test runs.",
        tags: ["bun", "testing", "timeout"],
      },
      "session-100"
    )

    assert.ok(card.id)
    assert.strictEqual(card.title, "Bun Timeout in Unit Tests")
    assert.deepStrictEqual(card.tags, ["bun", "testing", "timeout"])

    const fetched = await store.getCard(card.id)
    assert.ok(fetched)
    assert.strictEqual(fetched?.insight, card.insight)
  })

  it("should establish links between cards and traverse them", async () => {
    const cardA = await store.createCard({
      title: "Root Cause Card",
      category: "ARCH_DECISION",
      insight: "Use ES modules exclusively.",
      context: "Workspace configuration",
      tags: ["esm", "modules"],
    })

    const cardB = await store.createCard({
      title: "Dependent Card",
      category: "CODEBASE_CONVENTION",
      insight: "All internal imports must use .js extension.",
      context: "TypeScript configuration",
      tags: ["esm", "imports"],
    })

    await store.addLink(cardA.id, {
      targetCardId: cardB.id,
      relation: "RELATES_TO",
      strength: 0.9,
      rationale: "ESM requires explicit file extensions.",
    })

    const updatedA = await store.getCard(cardA.id)
    assert.strictEqual(updatedA?.links.length, 1)
    assert.strictEqual(updatedA?.links[0].targetCardId, cardB.id)

    const traversed = await store.traverseLinks(cardA.id, 1)
    assert.strictEqual(traversed.length, 2)
    assert.strictEqual(traversed[0].id, cardA.id)
    assert.strictEqual(traversed[1].id, cardB.id)
  })

  it("should query relevant cards by terms", async () => {
    const results = await store.queryRelevant("bun testing", 5)
    assert.ok(results.length > 0)
    assert.ok(results.some((r) => r.title.includes("Bun Timeout")))
  })

  it("should export to Open Memory format", async () => {
    const jsonString = await store.exportOpenMemory()
    const parsed = JSON.parse(jsonString)
    assert.strictEqual(parsed.format, "open-memory-zettelkasten")
    assert.ok(Array.isArray(parsed.nodes))
    assert.ok(parsed.nodes.length >= 2)
  })
})
