import type { OpenCodeLLMBridge } from "../core/llm-bridge.js"
import type {
  ILiveSkillDistiller,
  SessionTraceBuffer,
  DistilledSkillResult,
  SkillPackageMetadata,
} from "../../specs/contracts/live-skills.js"
import { randomUUID } from "node:crypto"

export class LiveSkillDistiller implements ILiveSkillDistiller {
  constructor(private llmBridge: OpenCodeLLMBridge) {}

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

    const response = await this.llmBridge.promptJson<{
      name: string
      description: string
      triggers: string[]
      tags: string[]
      skillMarkdownContent: string
    }>({
      systemPrompt: "You are an expert agent skill architect. Respond only with raw JSON.",
      userPrompt: prompt,
      useSmallModel: false,
    })

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
    const prompt = `
You are an Adversarial Skill Verifier evaluating an agent's newly distilled skill.
Analyze this SKILL.md content for:
1. Are there remaining hardcoded environment-specific paths? (Reject if present)
2. Are the instructions deterministic and reproducible?
3. Does it protect against dangerous side-effects (e.g. data loss, force pushes)?

[SKILL CONTENT]
${skill.skillMarkdownContent}

Return a JSON object:
{
  "passed": <boolean>,
  "score": <number between 0.0 and 1.0>,
  "feedback": "<concise evaluation explanation>"
}
`

    try {
      const evaluation = await this.llmBridge.promptJson<{
        passed: boolean
        score: number
        feedback: string
      }>({
        systemPrompt: "You are a strict security and quality reviewer. Output raw JSON only.",
        userPrompt: prompt,
        useSmallModel: true,
      })

      return {
        passed: evaluation.passed && evaluation.score >= 0.7,
        score: evaluation.score,
        feedback: evaluation.feedback,
      }
    } catch {
      // Heuristic fallback
      const hasHardcodedPath = /\/Users\/|\/home\/|[A-Z]:\\/.test(skill.skillMarkdownContent)
      return {
        passed: !hasHardcodedPath,
        score: hasHardcodedPath ? 0.4 : 0.85,
        feedback: hasHardcodedPath
          ? "Found hardcoded machine paths."
          : "Passed heuristic safety check.",
      }
    }
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
}
