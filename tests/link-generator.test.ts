import { describe, it } from "node:test"
import assert from "node:assert"
import { DynamicLinkGenerator } from "../src/memory/link-generator.js"
import type { MemoryCard } from "../specs/contracts/live-memory.js"

describe("DynamicLinkGenerator (A-Mem)", () => {
  it("should generate heuristic fallback links for shared tags", async () => {
    const mockBridge: any = {
      promptJson: async () => {
        throw new Error("Simulated LLM network failure to test heuristic fallback")
      },
    }

    const generator = new DynamicLinkGenerator(mockBridge)

    const cardA: MemoryCard = {
      id: "card-a",
      title: "Prisma schema migration",
      category: "ARCH_DECISION",
      insight: "Always create schema baseline.",
      context: "db init",
      tags: ["prisma", "database", "postgres"],
      accessCount: 0,
      links: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }

    const candidateB: MemoryCard = {
      id: "card-b",
      title: "Prisma rollback instructions",
      category: "ERROR_DIAGNOSTIC",
      insight: "Use migrate resolve --rolled-back.",
      context: "db error",
      tags: ["prisma", "database", "rollback"],
      accessCount: 0,
      links: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }

    const links = await generator.generateLinks(cardA, [candidateB])
    assert.strictEqual(links.length, 1)
    assert.strictEqual(links[0].targetCardId, "card-b")
    assert.strictEqual(links[0].relation, "RELATES_TO")
    assert.ok(links[0].strength >= 0.5)
  })

  it("should parse LLM-generated links with valid relations", async () => {
    const mockBridge: any = {
      promptJson: async () => [
        {
          targetCardId: "card-target",
          relation: "CAUSED_BY",
          strength: 0.95,
          rationale: "Unclosed handle directly caused test process timeout.",
        },
      ],
    }

    const generator = new DynamicLinkGenerator(mockBridge)

    const sourceCard: MemoryCard = {
      id: "card-source",
      title: "Node-pty process hang",
      category: "ERROR_DIAGNOSTIC",
      insight: "Teardown is required.",
      context: "testing",
      tags: ["pty"],
      accessCount: 0,
      links: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }

    const targetCard: MemoryCard = {
      id: "card-target",
      title: "Process lifecycle",
      category: "ARCH_DECISION",
      insight: "Handles must close.",
      context: "testing",
      tags: ["process"],
      accessCount: 0,
      links: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }

    const links = await generator.generateLinks(sourceCard, [targetCard])
    assert.strictEqual(links.length, 1)
    assert.strictEqual(links[0].relation, "CAUSED_BY")
    assert.strictEqual(links[0].strength, 0.95)
    assert.strictEqual(links[0].targetCardId, "card-target")
  })
})
