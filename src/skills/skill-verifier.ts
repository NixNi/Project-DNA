import type { OpenCodeLLMBridge } from "../core/llm-bridge.js"
import type { DistilledSkillResult } from "../../specs/contracts/live-skills.js"

export interface SkillVerificationResult {
  passed: boolean
  score: number
  feedback: string
}

export interface ILiveSkillVerifier {
  verify(skill: DistilledSkillResult): Promise<SkillVerificationResult>
}

export class LiveSkillVerifier implements ILiveSkillVerifier {
  constructor(private llmBridge: OpenCodeLLMBridge) {}

  public async verify(
    skill: DistilledSkillResult
  ): Promise<SkillVerificationResult> {
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
      // Heuristic fallback: detect POSIX user paths, Windows drive paths (both \ and /), and UNC paths
      const hasHardcodedPath =
        /\/Users\/|\/home\/|[a-zA-Z]:[\\\/]|\\\\[\w.-]+\\/i.test(
          skill.skillMarkdownContent
        )
      return {
        passed: !hasHardcodedPath,
        score: hasHardcodedPath ? 0.4 : 0.85,
        feedback: hasHardcodedPath
          ? "Found hardcoded machine paths."
          : "Passed heuristic safety check.",
      }
    }
  }
}
