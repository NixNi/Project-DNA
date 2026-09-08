import type { ISqliteDatabase } from "../core/sqlite-adapter.js"
import type {
  ILiveMemoryStore,
  MemoryCard,
  MemoryLink,
  NoteCandidate,
  MemoryCategory,
  LinkRelation,
} from "../../specs/contracts/live-memory.js"
import { randomUUID } from "node:crypto"

export class MemoryStore implements ILiveMemoryStore {
  constructor(private db: ISqliteDatabase) {}

  public async init(): Promise<void> {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cards (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        category TEXT NOT NULL,
        insight TEXT NOT NULL,
        context TEXT NOT NULL,
        evidence TEXT,
        tags TEXT NOT NULL, -- JSON array of strings
        access_count INTEGER DEFAULT 0,
        session_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS links (
        source_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        relation TEXT NOT NULL,
        strength REAL NOT NULL,
        rationale TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (source_id, target_id, relation),
        FOREIGN KEY(source_id) REFERENCES cards(id) ON DELETE CASCADE,
        FOREIGN KEY(target_id) REFERENCES cards(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_cards_category ON cards(category);
      CREATE INDEX IF NOT EXISTS idx_cards_session ON cards(session_id);
      CREATE INDEX IF NOT EXISTS idx_links_source ON links(source_id);
      CREATE INDEX IF NOT EXISTS idx_links_target ON links(target_id);
    `)
  }

  public async createCard(note: NoteCandidate, sessionID?: string): Promise<MemoryCard> {
    const id = randomUUID()
    const now = new Date().toISOString()
    const tagsJson = JSON.stringify(note.tags)

    const stmt = this.db.prepare(`
      INSERT INTO cards (id, title, category, insight, context, evidence, tags, access_count, session_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
    `)

    stmt.run(
      id,
      note.title,
      note.category,
      note.insight,
      note.context,
      note.evidence ?? null,
      tagsJson,
      sessionID ?? null,
      now,
      now
    )

    return {
      id,
      title: note.title,
      category: note.category,
      insight: note.insight,
      context: note.context,
      evidence: note.evidence,
      tags: note.tags,
      accessCount: 0,
      links: [],
      sessionID,
      createdAt: now,
      updatedAt: now,
    }
  }

  public async addLink(sourceId: string, link: MemoryLink): Promise<void> {
    const now = new Date().toISOString()
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO links (source_id, target_id, relation, strength, rationale, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    stmt.run(sourceId, link.targetCardId, link.relation, link.strength, link.rationale, now)
  }

  public async getCard(id: string): Promise<MemoryCard | null> {
    const cardStmt = this.db.prepare(`SELECT * FROM cards WHERE id = ?`)
    const raw = cardStmt.get(id) as any
    if (!raw) return null

    const linksStmt = this.db.prepare(`SELECT * FROM links WHERE source_id = ?`)
    const rawLinks = linksStmt.all(id) as any[]

    const links: MemoryLink[] = rawLinks.map((l) => ({
      targetCardId: l.target_id,
      relation: l.relation as LinkRelation,
      strength: Number(l.strength),
      rationale: l.rationale,
    }))

    return {
      id: raw.id,
      title: raw.title,
      category: raw.category as MemoryCategory,
      insight: raw.insight,
      context: raw.context,
      evidence: raw.evidence ?? undefined,
      tags: JSON.parse(raw.tags ?? "[]"),
      accessCount: Number(raw.access_count ?? 0),
      links,
      sessionID: raw.session_id ?? undefined,
      createdAt: raw.created_at,
      updatedAt: raw.updated_at,
    }
  }

  public async queryRelevant(query: string, limit = 5): Promise<MemoryCard[]> {
    // Rank cards using term presence across title, insight, context, and tags
    const allStmt = this.db.prepare(`SELECT * FROM cards`)
    const rows = allStmt.all() as any[]

    const terms = query.toLowerCase().split(/\W+/).filter((t) => t.length > 2)
    if (terms.length === 0) {
      return rows.slice(0, limit).map((r) => this.rowToCard(r))
    }

    const scored = rows.map((row) => {
      let score = 0
      const fullText = `${row.title} ${row.insight} ${row.context} ${row.tags}`.toLowerCase()

      for (const term of terms) {
        if (row.title.toLowerCase().includes(term)) score += 5
        if (row.insight.toLowerCase().includes(term)) score += 3
        if (row.tags.toLowerCase().includes(term)) score += 4
        if (fullText.includes(term)) score += 1
      }

      return { row, score }
    })

    scored.sort((a, b) => b.score - a.score)
    const topRows = scored.filter((s) => s.score > 0).slice(0, limit).map((s) => s.row)

    const cards: MemoryCard[] = []
    for (const r of topRows) {
      const card = await this.getCard(r.id)
      if (card) {
        this.incrementAccessCount(card.id)
        cards.push(card)
      }
    }

    return cards
  }

  public async getNotesForSession(sessionID: string): Promise<MemoryCard[]> {
    const stmt = this.db.prepare(`SELECT id FROM cards WHERE session_id = ? ORDER BY created_at ASC`)
    const rows = stmt.all(sessionID) as any[]

    const cards: MemoryCard[] = []
    for (const r of rows) {
      const card = await this.getCard(r.id)
      if (card) cards.push(card)
    }
    return cards
  }

  public async getAllCards(): Promise<MemoryCard[]> {
    const stmt = this.db.prepare(`SELECT id FROM cards ORDER BY created_at DESC`)
    const rows = stmt.all() as any[]
    const cards: MemoryCard[] = []
    for (const r of rows) {
      const card = await this.getCard(r.id)
      if (card) cards.push(card)
    }
    return cards
  }

  public async traverseLinks(cardId: string, depth = 1): Promise<MemoryCard[]> {
    const visited = new Set<string>()
    const result: MemoryCard[] = []

    const walk = async (currentId: string, currentDepth: number) => {
      if (visited.has(currentId) || currentDepth > depth) return
      visited.add(currentId)

      const card = await this.getCard(currentId)
      if (!card) return
      result.push(card)

      for (const link of card.links) {
        await walk(link.targetCardId, currentDepth + 1)
      }
    }

    await walk(cardId, 0)
    return result
  }

  public async exportOpenMemory(): Promise<string> {
    const cards = await this.getAllCards()
    return JSON.stringify(
      {
        version: "1.0.0",
        format: "open-memory-zettelkasten",
        exportedAt: new Date().toISOString(),
        nodes: cards,
      },
      null,
      2
    )
  }

  private incrementAccessCount(id: string): void {
    const stmt = this.db.prepare(`UPDATE cards SET access_count = access_count + 1 WHERE id = ?`)
    stmt.run(id)
  }

  private rowToCard(row: any): MemoryCard {
    return {
      id: row.id,
      title: row.title,
      category: row.category,
      insight: row.insight,
      context: row.context,
      evidence: row.evidence ?? undefined,
      tags: JSON.parse(row.tags ?? "[]"),
      accessCount: Number(row.access_count ?? 0),
      links: [],
      sessionID: row.session_id ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }
}
