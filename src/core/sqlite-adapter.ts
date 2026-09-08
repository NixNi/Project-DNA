/**
 * Universal SQLite Adapter for Project DNA
 * Seamlessly abstracts between node:sqlite (Node 22+) and bun:sqlite (Bun)
 * with zero external native npm dependencies.
 */

export interface ISqliteStatement {
  all(...params: unknown[]): unknown[]
  get(...params: unknown[]): unknown | undefined
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint }
}

export interface ISqliteDatabase {
  exec(sql: string): void
  prepare(sql: string): ISqliteStatement
  close(): void
}

export class UniversalSqliteDatabase implements ISqliteDatabase {
  private db: any
  private isBun: boolean

  constructor(filePath: string) {
    this.isBun = typeof (globalThis as any).Bun !== "undefined"

    if (this.isBun) {
      try {
        // Bun native SQLite
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { Database } = require("bun:sqlite")
        this.db = new Database(filePath, { create: true })
      } catch (err) {
        throw new Error(`Failed to initialize bun:sqlite: ${String(err)}`)
      }
    } else {
      try {
        // Node 22+ native DatabaseSync
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { DatabaseSync } = require("node:sqlite")
        this.db = new DatabaseSync(filePath)
      } catch (err) {
        throw new Error(
          `Failed to initialize node:sqlite. Ensure Node.js v22+ is used. Error: ${String(err)}`
        )
      }
    }
  }

  public exec(sql: string): void {
    this.db.exec(sql)
  }

  public prepare(sql: string): ISqliteStatement {
    const stmt = this.db.prepare(sql)

    if (this.isBun) {
      return {
        all: (...params: unknown[]) => stmt.all(...params),
        get: (...params: unknown[]) => stmt.get(...params),
        run: (...params: unknown[]) => {
          const res = stmt.run(...params)
          return {
            changes: res.changes,
            lastInsertRowid: res.lastInsertRowid,
          }
        },
      }
    }

    // Node:sqlite implementation
    return {
      all: (...params: unknown[]) => stmt.all(...params),
      get: (...params: unknown[]) => stmt.get(...params),
      run: (...params: unknown[]) => {
        const res = stmt.run(...params)
        return {
          changes: Number(res.changes ?? 0),
          lastInsertRowid: res.lastInsertRowid ?? 0,
        }
      },
    }
  }

  public close(): void {
    if (this.db) {
      this.db.close()
    }
  }
}
