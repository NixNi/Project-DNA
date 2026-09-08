import type { OpenCodeLLMBridge } from "../core/llm-bridge.js"
import type {
  IDynamicLinkGenerator,
  MemoryCard,
  MemoryLink,
  LinkRelation,
} from "../../specs/contracts/live-memory.js"

export class DynamicLinkGenerator implements IDynamicLinkGenerator {
  constructor(private llmBridge: OpenCodeLLMBridge) {}

  public async generateLinks(
    newCard: MemoryCard,
    candidates: MemoryCard[]
  ): Promise<MemoryLink[]> {
    if (candidates.length === 0) return []

    // Filter out self if present
    const validCandidates = candidates.filter((c) => c.id !== newCard.id)
    if (validCandidates.length === 0) return []

    const prompt = `
You are the Link Generator engine for an A-Mem (Agentic Memory) Zettelkasten knowledge graph.
Analyze the newly created Memory Card against existing Candidate Cards to identify epistemic, causal, or procedural links.

[NEW MEMORY CARD]
ID: ${newCard.id}
Title: ${newCard.title}
Category: ${newCard.category}
Insight: ${newCard.insight}
Context: ${newCard.context}
Tags: ${newCard.tags.join(", ")}

[CANDIDATE EXISTING CARDS]
${validCandidates
  .map(
    (c) => `
---
ID: ${c.id}
Title: ${c.title}
Category: ${c.category}
Insight: ${c.insight}
Context: ${c.context}
Tags: ${c.tags.join(", ")}
`
  )
  .join("\n")}

Determine which candidates have a meaningful relationship with the new card.
Valid relations:
- "CAUSED_BY": The new card explains the cause of the candidate, or the candidate caused the new card.
- "SUPERSEDES": The new card makes the candidate card obsolete or outdated.
- "REFINES": The new card narrows down, deepens, or adds constraints to the candidate.
- "CONTRADICTS": The new card conflicts with or refutes the candidate.
- "RELATES_TO": A strong conceptual, thematic, or workflow association.

Return a JSON array of links with this schema:
[
  {
    "targetCardId": "<string>",
    "relation": "CAUSED_BY" | "SUPERSEDES" | "RELATES_TO" | "REFINES" | "CONTRADICTS",
    "strength": <number between 0.5 and 1.0>,
    "rationale": "<brief 1-sentence explanation>"
  }
]
If no strong relationships exist, return an empty array [].
`

    try {
      const links = await this.llmBridge.promptJson<
        Array<{
          targetCardId: string
          relation: string
          strength: number
          rationale: string
        }>
      >({
        systemPrompt: "You are an expert knowledge graph linker. Respond only with JSON.",
        userPrompt: prompt,
        useSmallModel: true,
      })

      const validRelations = new Set([
        "CAUSED_BY",
        "SUPERSEDES",
        "RELATES_TO",
        "REFINES",
        "CONTRADICTS",
      ])

      return links
        .filter(
          (l) =>
            validCandidates.some((c) => c.id === l.targetCardId) &&
            validRelations.has(l.relation) &&
            typeof l.strength === "number" &&
            l.strength >= 0.5
        )
        .map((l) => ({
          targetCardId: l.targetCardId,
          relation: l.relation as LinkRelation,
          strength: Math.min(1.0, Math.max(0.0, l.strength)),
          rationale: l.rationale ?? "Associative relationship identified by A-Mem",
        }))
    } catch {
      // Fallback: heuristic tag matching if LLM call fails
      return this.heuristicTagLink(newCard, validCandidates)
    }
  }

  /**
   * Deterministic fallback linker based on shared tags
   */
  private heuristicTagLink(newCard: MemoryCard, candidates: MemoryCard[]): MemoryLink[] {
    const newTags = new Set(newCard.tags.map((t) => t.toLowerCase()))
    const links: MemoryLink[] = []

    for (const cand of candidates) {
      const shared = cand.tags.filter((t) => newTags.has(t.toLowerCase()))
      if (shared.length >= 2) {
        links.push({
          targetCardId: cand.id,
          relation: "RELATES_TO",
          strength: 0.6,
          rationale: `Shares common tags: ${shared.join(", ")}`,
        })
      }
    }

    return links
  }
}
