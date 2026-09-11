import { describe, it, before, after } from "node:test"
import assert from "node:assert"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { LiveSkillStore } from "../src/skills/skill-store.js"
import { LiveSkillHarvester } from "../src/skills/trace-harvester.js"
import type { DistilledSkillResult } from "../specs/contracts/live-skills.js"

describe("LiveSkills (Harvester & Store)", () => {
  const baseDir = path.resolve("./test-skills-tmp")
  const activeDir = path.join(baseDir, "active")
  const stagedDir = path.join(baseDir, "staged")
  const archiveDir = path.join(baseDir, "archive")

  before(async () => {
    await fs.mkdir(activeDir, { recursive: true })
    await fs.mkdir(stagedDir, { recursive: true })
    await fs.mkdir(archiveDir, { recursive: true })
  })

  after(async () => {
    await fs.rm(baseDir, { recursive: true, force: true }).catch(() => {})
  })

  it("should buffer steps and verify harvest eligibility", () => {
    const harvester = new LiveSkillHarvester()
    const sessId = "sess-abc"

    assert.strictEqual(harvester.isEligibleForHarvest(sessId), false)

    harvester.recordStep(sessId, {
      tool: "bash",
      args: { cmd: "git status" },
      output: "clean",
      timestamp: new Date().toISOString(),
    })
    harvester.recordStep(sessId, {
      tool: "edit",
      args: { file: "app.ts" },
      output: "ok",
      timestamp: new Date().toISOString(),
    })
    harvester.recordStep(sessId, {
      tool: "bash",
      args: { cmd: "npm test" },
      output: "passed",
      timestamp: new Date().toISOString(),
    })

    harvester.setResolution(sessId, "SUCCESS")
    assert.strictEqual(harvester.isEligibleForHarvest(sessId), true)

    const trace = harvester.getTrace(sessId)
    assert.ok(trace)
    assert.strictEqual(trace?.steps.length, 3)

    harvester.clearTrace(sessId)
    assert.strictEqual(harvester.getTrace(sessId), null)
  })

  it("should update step output and retain substantive user goals across turns", () => {
    const harvester = new LiveSkillHarvester()
    const sessId = "sess-goal-test"

    // Initial substantial goal
    harvester.setUserGoal(sessId, "Build a high-performance Redis cache layer")
    harvester.recordStep(sessId, {
      tool: "bash",
      args: { cmd: "docker run redis" },
      output: "",
      timestamp: new Date().toISOString(),
    })

    // Simulate tool.execute.after updating output
    harvester.updateStepOutput(sessId, "bash", "Container started: a1b2c3d4", 0)

    const trace = harvester.getTrace(sessId)
    assert.ok(trace)
    assert.strictEqual(trace?.steps[0].output, "Container started: a1b2c3d4")
    assert.strictEqual(trace?.steps[0].exitCode, 0)

    // Conversational acknowledgement should NOT overwrite the substantive goal
    harvester.setUserGoal(sessId, "ok")
    assert.strictEqual(trace?.userGoal, "Build a high-performance Redis cache layer")

    harvester.setUserGoal(sessId, "proceed!")
    assert.strictEqual(trace?.userGoal, "Build a high-performance Redis cache layer")

    // A new substantive follow-up task should enrich the goal
    harvester.setUserGoal(sessId, "Configure TTL eviction policy to LRU")
    assert.ok(trace?.userGoal.includes("Redis cache layer -> Configure TTL"))
  })

  it("should save, match, and record outcomes for skills", async () => {

    const store = new LiveSkillStore(activeDir, stagedDir, archiveDir)

    const mockSkill: DistilledSkillResult = {
      metadata: {
        id: "skill-1",
        name: "prisma-migration-fix",
        version: "1.0.0",
        description: "Fixes stalled or failed Prisma database migrations",
        triggers: ["prisma migration error", "migrate resolve"],
        tags: ["prisma", "database"],
        author: "dna-synthesizer",
        confidenceScore: 0.9,
        lifecycleStatus: "ACTIVE",
        telemetry: { executionCount: 1, successCount: 1, failureCount: 0 },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      skillMarkdownContent: "# Prisma Migration Fix\nRun migrate resolve.",
    }

    await store.saveSkill(mockSkill)
    await store.loadActiveSkills()

    const matches = await store.matchSkills("I got a prisma migration error on deploy")
    assert.strictEqual(matches.length, 1)
    assert.strictEqual(matches[0].skill.name, "prisma-migration-fix")
    assert.strictEqual(matches[0].relevanceScore, 0.95)

    // Record success
    await store.recordOutcome("prisma-migration-fix", true)
    const afterSuccess = await store.matchSkills("migrate resolve")
    assert.strictEqual(afterSuccess[0].skill.confidenceScore, 0.95)

    // Record repeated failures to test degradation
    await store.recordOutcome("prisma-migration-fix", false)
    await store.recordOutcome("prisma-migration-fix", false)
    await store.recordOutcome("prisma-migration-fix", false)
    await store.recordOutcome("prisma-migration-fix", false)

    // Verify index.json was created
    const indexPath = path.join(baseDir, "index.json")
    const indexRaw = await fs.readFile(indexPath, "utf-8")
    const indexData = JSON.parse(indexRaw)
    assert.ok(Array.isArray(indexData))

    const pruneResult = await store.pruneLibrary()
    assert.ok(pruneResult.archived.includes("prisma-migration-fix"))
  })

  it("should adversarial verify skill and reject unsafe paths", async () => {
    const { LiveSkillVerifier } = await import("../src/skills/skill-verifier.js")
    const mockBridge: any = {
      promptJson: async () => {
        throw new Error("Trigger fallback")
      },
    }
    const verifier = new LiveSkillVerifier(mockBridge)

    const unsafeSkill: DistilledSkillResult = {
      metadata: {} as any,
      skillMarkdownContent: "# Deploy\nRun cd /Users/nixni/app && npm test",
    }
    const unsafeRes = await verifier.verify(unsafeSkill)
    assert.strictEqual(unsafeRes.passed, false)
    assert.ok(unsafeRes.feedback.includes("hardcoded machine paths"))

    const safeSkill: DistilledSkillResult = {
      metadata: {} as any,
      skillMarkdownContent: "# Deploy\nRun npm test in project root",
    }
    const safeRes = await verifier.verify(safeSkill)
    assert.strictEqual(safeRes.passed, true)
  })
})
