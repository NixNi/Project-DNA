import * as fs from "node:fs/promises"
import * as path from "node:path"
import type {
  ILiveSkillStore,
  SkillPackageMetadata,
  DistilledSkillResult,
  SkillMatchResult,
} from "../../specs/contracts/live-skills.js"

export class LiveSkillStore implements ILiveSkillStore {
  private activeSkills: Map<string, { metadata: SkillPackageMetadata; content: string }> =
    new Map()

  constructor(
    private activeDir: string,
    private stagedDir: string,
    private archiveDir: string
  ) {}

  public async loadActiveSkills(): Promise<void> {
    this.activeSkills.clear()
    try {
      const entries = await fs.readdir(this.activeDir, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const skillDir = path.join(this.activeDir, entry.name)
          const skillMdPath = path.join(skillDir, "SKILL.md")
          const metaPath = path.join(skillDir, "metadata.json")

          try {
            const content = await fs.readFile(skillMdPath, "utf-8")
            const metaRaw = await fs.readFile(metaPath, "utf-8")
            const metadata: SkillPackageMetadata = JSON.parse(metaRaw)
            this.activeSkills.set(metadata.name, { metadata, content })
          } catch {
            // Ignore incomplete skill package
          }
        }
      }
    } catch {
      // Directory may not yet have skills
    }
  }

  public async matchSkills(prompt: string): Promise<SkillMatchResult[]> {
    const promptLower = prompt.toLowerCase()
    const matches: SkillMatchResult[] = []

    for (const [, item] of this.activeSkills.entries()) {
      const meta = item.metadata
      if (meta.lifecycleStatus !== "ACTIVE") continue

      let matchedTrigger = ""
      let relevance = 0

      for (const trigger of meta.triggers) {
        if (promptLower.includes(trigger.toLowerCase())) {
          matchedTrigger = trigger
          relevance = 0.95
          break
        }
      }

      if (relevance === 0) {
        // Tag overlap check
        const promptWords = promptLower.split(/\W+/)
        const matchedTags = meta.tags.filter((t) => promptWords.includes(t.toLowerCase()))
        if (matchedTags.length > 0) {
          relevance = 0.6 + matchedTags.length * 0.1
          matchedTrigger = `Tags: ${matchedTags.join(", ")}`
        }
      }

      if (relevance >= 0.6) {
        matches.push({
          skill: meta,
          relevanceScore: Math.min(1.0, relevance),
          matchedTrigger,
          injectedGuideline: `[Procedural Skill: ${meta.name}]\n${meta.description}\nKey Trigger: ${matchedTrigger}`,
        })
      }
    }

    matches.sort((a, b) => b.relevanceScore - a.relevanceScore)
    return matches
  }

  public async saveSkill(distilled: DistilledSkillResult): Promise<void> {
    const skillDir = path.join(this.activeDir, distilled.metadata.name)
    await fs.mkdir(skillDir, { recursive: true })

    distilled.metadata.lifecycleStatus = "ACTIVE"
    await fs.writeFile(path.join(skillDir, "SKILL.md"), distilled.skillMarkdownContent, "utf-8")
    await fs.writeFile(
      path.join(skillDir, "metadata.json"),
      JSON.stringify(distilled.metadata, null, 2),
      "utf-8"
    )

    this.activeSkills.set(distilled.metadata.name, {
      metadata: distilled.metadata,
      content: distilled.skillMarkdownContent,
    })
  }

  public async recordOutcome(skillName: string, success: boolean): Promise<void> {
    const item = this.activeSkills.get(skillName)
    if (!item) return

    const tele = item.metadata.telemetry
    tele.executionCount++
    if (success) {
      tele.successCount++
      item.metadata.confidenceScore = Math.min(1.0, Math.round((item.metadata.confidenceScore + 0.05) * 100) / 100)
    } else {
      tele.failureCount++
      item.metadata.confidenceScore = Math.max(0.0, Math.round((item.metadata.confidenceScore - 0.15) * 100) / 100)
    }

    tele.lastAppliedAt = new Date().toISOString()
    item.metadata.updatedAt = new Date().toISOString()

    const skillDir = path.join(this.activeDir, skillName)
    await fs.writeFile(
      path.join(skillDir, "metadata.json"),
      JSON.stringify(item.metadata, null, 2),
      "utf-8"
    )
  }

  public async pruneLibrary(): Promise<{ archived: string[]; retained: string[] }> {
    const archived: string[] = []
    const retained: string[] = []

    for (const [name, item] of this.activeSkills.entries()) {
      if (item.metadata.confidenceScore < 0.5) {
        // Move to archive
        const srcDir = path.join(this.activeDir, name)
        const destDir = path.join(this.archiveDir, name)
        await fs.mkdir(path.dirname(destDir), { recursive: true })
        await fs.rename(srcDir, destDir).catch(() => {})

        this.activeSkills.delete(name)
        archived.push(name)
      } else {
        retained.push(name)
      }
    }

    return { archived, retained }
  }
}
