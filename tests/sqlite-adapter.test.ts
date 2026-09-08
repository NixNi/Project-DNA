import { describe, it, before, after } from "node:test"
import assert from "node:assert"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { UniversalSqliteDatabase } from "../src/core/sqlite-adapter.js"

describe("UniversalSqliteDatabase", () => {
  const testDbPath = path.resolve("./test-tmp.db")
  let db: UniversalSqliteDatabase

  before(() => {
    db = new UniversalSqliteDatabase(testDbPath)
  })

  after(async () => {
    db.close()
    await fs.unlink(testDbPath).catch(() => {})
  })

  it("should create table and execute parameterized queries", () => {
    db.exec(`
      CREATE TABLE test_items (
        id TEXT PRIMARY KEY,
        val INTEGER NOT NULL
      );
    `)

    const insertStmt = db.prepare("INSERT INTO test_items (id, val) VALUES (?, ?)")
    const res = insertStmt.run("item-1", 42)
    assert.strictEqual(res.changes, 1)

    const selectStmt = db.prepare("SELECT * FROM test_items WHERE id = ?")
    const item = selectStmt.get("item-1") as { id: string; val: number }
    assert.ok(item)
    assert.strictEqual(item.id, "item-1")
    assert.strictEqual(item.val, 42)

    const allStmt = db.prepare("SELECT * FROM test_items")
    const all = allStmt.all() as Array<{ id: string; val: number }>
    assert.strictEqual(all.length, 1)
  })
})
