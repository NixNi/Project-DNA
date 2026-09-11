import type { OpenCodeLLMBridge } from "../core/llm-bridge.js"
import { LiveSkillVerifier } from "./skill-verifier.js"
import type {
  ILiveSkillDistiller,
  SessionTraceBuffer,
  DistilledSkillResult,
  SkillPackageMetadata,
} from "../../specs/contracts/live-skills.js"
import { randomUUID } from "node:crypto"

export class LiveSkillDistiller implements ILiveSkillDistiller {
  private verifier: LiveSkillVerifier

  constructor(private llmBridge: OpenCodeLLMBridge) {
    this.verifier = new LiveSkillVerifier(llmBridge)
  }

  public async distill(trace: SessionTraceBuffer): Promise<DistilledSkillResult> {
    const prompt = `
You are the Skill Distiller in the Project DNA LiveSkills engine.
Extract a generalizable, reusable procedural skill from this successful multi-step session trace.

[SESSION CONTEXT]
Session ID: ${trace.sessionID}
User Goal: ${trace.userGoal || "Complex multi-step resolution"}
Execution Steps:
${trace.steps
  .map(
    (s, i) =>
      `Step ${i + 1}: Tool [${s.tool}] with args: ${JSON.stringify(s.args)}\nOutput snippet: ${s.output.slice(0, 300)}`
  )
  .join("\n\n")}

Instructions for Distillation:
1. Strip all project-specific hardcoded paths, local usernames, and specific commit hashes.
2. Formulate generalized trigger phrases that indicate when an agent should use this skill.
3. Structure the output into standard SKILL.md format:
   - Frontmatter with name, description, version (1.0.0), triggers (array), tags (array), confidence_score (0.9).
   - Overview section.
   - Step-by-step procedure with recommended tools/commands.
   - Critical pitfalls and edge cases to avoid.

Return a JSON object matching this schema:
{
  "name": "<kebab-case-slug>",
  "description": "<one-sentence summary>",
  "triggers": ["<phrase1>", "<phrase2>"],
  "tags": ["<tag1>", "<tag2>"],
  "skillMarkdownContent": "<complete SKILL.md content including YAML frontmatter>"
}
`

    let rawText: string
    try {
      rawText = await this.llmBridge.prompt({
        systemPrompt: "You are an expert agent skill architect. Respond with valid JSON.",
        userPrompt: prompt,
        useSmallModel: false,
      })
    } catch (primaryErr) {
      try {
        rawText = await this.llmBridge.prompt({
          systemPrompt: "You are an expert agent skill architect. Respond with valid JSON.",
          userPrompt: prompt,
          useSmallModel: true,
        })
      } catch {
        throw primaryErr
      }
    }

    const response = this.parseDistillationResponse(rawText)


    const now = new Date().toISOString()
    const metadata: SkillPackageMetadata = {
      id: randomUUID(),
      name: response.name,
      version: "1.0.0",
      description: response.description,
      triggers: response.triggers,
      tags: response.tags,
      author: "dna-synthesizer",
      confidenceScore: 0.9,
      lifecycleStatus: "STAGED",
      telemetry: {
        executionCount: 1,
        successCount: 1,
        failureCount: 0,
        lastAppliedAt: now,
      },
      createdAt: now,
      updatedAt: now,
    }

    return {
      metadata,
      skillMarkdownContent: response.skillMarkdownContent,
    }
  }

  public async adversarialVerify(
    skill: DistilledSkillResult
  ): Promise<{ passed: boolean; score: number; feedback: string }> {
    return this.verifier.verify(skill)
  }

  public async mergeIntoExisting(
    existingId: string,
    trace: SessionTraceBuffer
  ): Promise<DistilledSkillResult> {
    const distilled = await this.distill(trace)
    distilled.metadata.id = existingId
    distilled.metadata.version = "1.1.0"
    return distilled
  }

  private parseDistillationResponse(rawText: string): {
    name: string
    description: string
    triggers: string[]
    tags: string[]
    skillMarkdownContent: string
  } {
    const cleaned = rawText
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim()

    try {
      const parsed = JSON.parse(cleaned)
      if (parsed.name && parsed.skillMarkdownContent) {
        return {
          name: String(parsed.name).toLowerCase().replace(/[^a-z0-9_-]/g, "-"),
          description: String(parsed.description || "Procedural skill"),
          triggers: Array.isArray(parsed.triggers)
            ? parsed.triggers.map(String)
            : ["custom task"],
          tags: Array.isArray(parsed.tags) ? parsed.tags.map(String) : ["procedural"],
          skillMarkdownContent: String(parsed.skillMarkdownContent),
        }
      }
    } catch {
      // JSON parse failed due to unescaped quotes or newlines, fallback to pattern matching
    }

    // Regex fallback extraction
    const nameMatch = rawText.match(/"name"\s*:\s*"([^"]+)"/)
    const descMatch = rawText.match(/"description"\s*:\s*"([^"]+)"/)
    const triggersMatch = rawText.match(/"triggers"\s*:\s*\[([\s\S]*?)\]/)
    const tagsMatch = rawText.match(/"tags"\s*:\s*\[([\s\S]*?)\]/)

    const name = nameMatch
      ? nameMatch[1].toLowerCase().replace(/[^a-z0-9_-]/g, "-")
      : "procedural-skill-" + Date.now()
    const description = descMatch ? descMatch[1] : "Extracted procedural skill"

    const triggers: string[] = []
    if (triggersMatch) {
      const parts = triggersMatch[1].match(/"([^"]+)"/g)
      if (parts) triggers.push(...parts.map((p) => p.replace(/"/g, "")))
    }
    if (triggers.length === 0) triggers.push(name.replace(/-/g, " "))

    const tags: string[] = []
    if (tagsMatch) {
      const parts = tagsMatch[1].match(/"([^"]+)"/g)
      if (parts) tags.push(...parts.map((p) => p.replace(/"/g, "")))
    }
    if (tags.length === 0) tags.push("procedural", "automated")

    let skillMarkdownContent = ""
    const contentMatch = rawText.match(
      /"skillMarkdownContent"\s*:\s*"([\s\S]*?)"\s*[\}\]]?\s*$/
    )
    if (contentMatch) {
      skillMarkdownContent = contentMatch[1]
        .replace(/\\n/g, "\n")
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, "\\")
    } else {
      skillMarkdownContent = `---
name: ${name}
description: ${description}
version: 1.0.0
triggers:
${triggers.map((t) => `  - "${t}"`).join("\n")}
tags:
${tags.map((t) => `  - "${t}"`).join("\n")}
confidence_score: 0.9
---

# ${description}

## Overview
Procedural execution pattern synthesized by Project DNA.

## Procedure
Follow the steps outlined in the execution trace.
`
    }

    return {
      name,
      description,
      triggers,
      tags,
      skillMarkdownContent,
    }
  }
}

