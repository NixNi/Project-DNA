/**
 * Empirical Adversarial Challenger Test Suite — Milestone 2: LiveTools LATM Engine Upgrades
 *
 * Focus:
 * 1. TelemetryCalculator multiplicative formula stress testing across boundary values
 *    (0/0, 100/100, 0/1, clamped failures < 0 or > 5, extreme values, monotonicity oracle).
 * 2. LiveToolRegistry sliding window FIFO discipline over 100+ executions.
 * 3. 100+ turn simulation stress test: verifying DEGRADED -> ARCHIVED transition at turn 100
 *    while ACTIVE tools remain ACTIVE, recovery dynamics, and disk persistence.
 */

import { describe, it, before, after } from "node:test"
import assert from "node:assert"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { randomUUID } from "node:crypto"

import { TelemetryCalculator } from "../src/core/telemetry.js"
import { LiveToolRegistry } from "../src/tools/tool-registry.js"
import type { ToolPackageMetadata } from "../specs/contracts/live-tools.js"

describe("Adversarial Empirical Challenge: Milestone 2 LiveTools Upgrades", () => {
  const testWorkspace = path.resolve(`./test-adversarial-m2-${randomUUID().slice(0, 8)}`)
  const toolsDir = path.join(testWorkspace, ".opencode", "dna", "tools")

  before(async () => {
    await fs.mkdir(toolsDir, { recursive: true })
  })

  after(async () => {
    await fs.rm(testWorkspace, { recursive: true, force: true }).catch(() => {})
  })

  // =========================================================================
  // CHALLENGE 1: TelemetryCalculator Multiplicative Formula Boundary Testing
  // =========================================================================
  describe("TelemetryCalculator Boundary Stress Testing", () => {
    it("[CHALLENGE-TEL-01] Boundary (0/0) zero total executions returns neutral 1.0 regardless of recentFailures", () => {
      // 0 total invocations: division by zero prevention
      assert.strictEqual(TelemetryCalculator.computeHealthScore(0, 0, 0), 1.0)
      assert.strictEqual(TelemetryCalculator.computeHealthScore(0, 0, 5), 1.0)
      assert.strictEqual(TelemetryCalculator.computeHealthScore(0, 0, -5), 1.0)
      assert.strictEqual(TelemetryCalculator.computeHealthScore(0, 0, 100), 1.0)
    })

    it("[CHALLENGE-TEL-02] Boundary (100/100) equal ratio across all recent failure values [0..5]", () => {
      // safeSuccess = 100, safeFailure = 100, total = 200 -> rawSuccessRate = 0.5
      // Multiplier = (1 - f/5)
      const expectedScores: Record<number, number> = {
        0: 0.5, // 0.5 * 1.0 = 0.50
        1: 0.4, // 0.5 * 0.8 = 0.40
        2: 0.3, // 0.5 * 0.6 = 0.30
        3: 0.2, // 0.5 * 0.4 = 0.20
        4: 0.1, // 0.5 * 0.2 = 0.10
        5: 0.0, // 0.5 * 0.0 = 0.00
      }

      for (const [fStr, expected] of Object.entries(expectedScores)) {
        const f = Number(fStr)
        const actual = TelemetryCalculator.computeHealthScore(100, 100, f)
        assert.strictEqual(
          actual,
          expected,
          `Score for (100, 100, ${f}) should be ${expected}, got ${actual}`
        )
      }
    })

    it("[CHALLENGE-TEL-03] Boundary (0/1) zero successes always returns 0.0 regardless of recent failure count", () => {
      // rawSuccessRate = 0 / 1 = 0
      assert.strictEqual(TelemetryCalculator.computeHealthScore(0, 1, 0), 0.0)
      assert.strictEqual(TelemetryCalculator.computeHealthScore(0, 1, 1), 0.0)
      assert.strictEqual(TelemetryCalculator.computeHealthScore(0, 1, 5), 0.0)
      assert.strictEqual(TelemetryCalculator.computeHealthScore(0, 1, -2), 0.0)
      assert.strictEqual(TelemetryCalculator.computeHealthScore(0, 100, 0), 0.0)
      assert.strictEqual(TelemetryCalculator.computeHealthScore(0, 100, 5), 0.0)
    })

    it("[CHALLENGE-TEL-04] Clamping for recentFailuresInLast5 < 0 (never inflates multiplier beyond 1.0)", () => {
      // Negative recent failures must be clamped to 0, not allow multiplier > 1.0
      const scoreNeg1 = TelemetryCalculator.computeHealthScore(10, 0, -1)
      assert.strictEqual(scoreNeg1, 1.0, "Score should not exceed 1.0 on negative recent failures")

      const scoreNeg5 = TelemetryCalculator.computeHealthScore(8, 2, -5)
      // 8/10 * (1 - 0) = 0.80, NOT 8/10 * (1 - (-5)/5) = 1.60
      assert.strictEqual(scoreNeg5, 0.8, "Negative failures must clamp to 0")

      const scoreNegHuge = TelemetryCalculator.computeHealthScore(5, 5, -999999)
      assert.strictEqual(scoreNegHuge, 0.5, "Extreme negative failures must clamp to 0")
    })

    it("[CHALLENGE-TEL-05] Clamping for recentFailuresInLast5 > 5 (never drops multiplier below 0.0)", () => {
      // Recent failures > 5 must be clamped to 5, not allow negative score
      const score6 = TelemetryCalculator.computeHealthScore(10, 0, 6)
      assert.strictEqual(score6, 0.0, "Score must clamp to 0 when recent failures >= 5")

      const score100 = TelemetryCalculator.computeHealthScore(100, 1, 100)
      assert.strictEqual(score100, 0.0, "Recent failures > 5 must yield 0.0, not negative score")

      const scoreHuge = TelemetryCalculator.computeHealthScore(1000, 1000, 999999)
      assert.strictEqual(scoreHuge, 0.0, "Extreme recent failures must clamp to 0.0")
    })

    it("[CHALLENGE-TEL-06] Defensive clamping for negative successCount and failureCount", () => {
      // Negative counts must be clamped to 0
      assert.strictEqual(TelemetryCalculator.computeHealthScore(-5, 5, 0), 0.0)
      assert.strictEqual(TelemetryCalculator.computeHealthScore(5, -5, 0), 1.0)
      assert.strictEqual(TelemetryCalculator.computeHealthScore(-10, -10, 0), 1.0) // 0/0 -> 1.0
    })

    it("[CHALLENGE-TEL-07] Property-Based Monotonicity Oracle over 500 randomized parameter tuples", () => {
      // Monte Carlo testing of mathematical properties:
      // 1. Bound check: 0.0 <= score <= 1.0
      // 2. Monotonicity: higher recent failures must monotonically decrease (or keep equal) the health score
      for (let i = 0; i < 500; i++) {
        const successes = Math.floor(Math.random() * 100)
        const failures = Math.floor(Math.random() * 100)
        const total = successes + failures

        if (total === 0) continue

        let prevScore = 2.0 // Above max possible
        for (let recentF = 0; recentF <= 5; recentF++) {
          const score = TelemetryCalculator.computeHealthScore(successes, failures, recentF)

          // Property 1: Boundedness
          assert.ok(
            score >= 0.0 && score <= 1.0,
            `Score must be in [0, 1], got ${score} for (${successes}, ${failures}, ${recentF})`
          )

          // Property 2: Monotonic degradation with increasing recent failures
          assert.ok(
            score <= prevScore + 1e-9,
            `Monotonicity violation: score(${recentF})=${score} > score(${recentF - 1})=${prevScore}`
          )
          prevScore = score
        }
      }
    })

    it("[CHALLENGE-TEL-08] Half-life exponential time decay boundary behavior", () => {
      const now = new Date()
      const nowIso = now.toISOString()

      // 0 days elapsed -> no decay
      assert.strictEqual(TelemetryCalculator.applyTimeDecay(0.85, nowIso, 30), 0.85)

      // 30 days elapsed -> exactly half
      const date30DaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString()
      assert.strictEqual(TelemetryCalculator.applyTimeDecay(1.0, date30DaysAgo, 30), 0.5)

      // 60 days elapsed -> quarter
      const date60DaysAgo = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000).toISOString()
      assert.strictEqual(TelemetryCalculator.applyTimeDecay(1.0, date60DaysAgo, 30), 0.25)

      // Future timestamp -> elapsed is 0 -> no decay
      const futureDate = new Date(now.getTime() + 10 * 24 * 60 * 60 * 1000).toISOString()
      assert.strictEqual(TelemetryCalculator.applyTimeDecay(0.9, futureDate, 30), 0.9)
    })
  })

  // =========================================================================
  // CHALLENGE 2: LiveToolRegistry Sliding Window FIFO Stress Testing
  // =========================================================================
  describe("LiveToolRegistry Sliding Window FIFO Discipline", () => {
    it("[CHALLENGE-WIN-01] 100+ executions FIFO sliding window maintains exact size 5 and sliding history", async () => {
      const registry = new LiveToolRegistry(toolsDir)

      const meta: ToolPackageMetadata = {
        name: "fifo_stress_tool",
        version: "1.0.0",
        description: "FIFO stress test tool",
        author: "CHALLENGER",
        createdTimestamp: Date.now(),
        lastUpdatedTimestamp: Date.now(),
        entrypoint: "src/fifo_stress_tool.js",
        status: "ACTIVE",
        totalInvocations: 0,
        failedInvocations: 0,
        averageDurationMs: 0,
        parameters: {},
      }

      await registry.registerTool(meta, {
        execute: async () => ({ output: "ok" }),
      })

      // Generate a pseudorandom stream of 120 execution outcomes
      const outcomes: boolean[] = []
      for (let i = 0; i < 120; i++) {
        // Alternating burst pattern
        const success = (i % 7 !== 0 && i % 11 !== 0) // ~82% success rate
        outcomes.push(success)
        await registry.recordExecution("fifo_stress_tool", success, 5)

        const recent = registry.getRecentExecutions("fifo_stress_tool")
        const expectedWindow = outcomes.slice(-5)

        // Verify window size is min(i+1, 5)
        assert.strictEqual(
          recent.length,
          Math.min(i + 1, 5),
          `Window length mismatch at iteration ${i}`
        )

        // Verify window contents exactly match FIFO tail
        assert.deepStrictEqual(
          recent,
          expectedWindow,
          `Window contents mismatch at iteration ${i}`
        )

        // Verify failure count in window
        const recentFailures = expectedWindow.filter((s) => !s).length
        const totalSuccesses = outcomes.filter((s) => s).length
        const totalFailures = outcomes.filter((s) => !s).length
        const expectedScore = TelemetryCalculator.computeHealthScore(
          totalSuccesses,
          totalFailures,
          recentFailures
        )

        const toolMeta = registry.getMetadata("fifo_stress_tool")
        assert.strictEqual(
          toolMeta?.telemetry.healthScore,
          expectedScore,
          `Health score mismatch at iteration ${i}: expected ${expectedScore}, got ${toolMeta?.telemetry.healthScore}`
        )
      }
    })
  })

  // =========================================================================
  // CHALLENGE 3: 100+ Turn Archival Simulation & Status State Machine
  // =========================================================================
  describe("Turn Archival Simulation & Status State Machine (100+ Turns)", () => {
    it("[CHALLENGE-ARC-01] 105-turn simulation: verify ONLY DEGRADED tools transition to ARCHIVED, ACTIVE tools remain ACTIVE, and recovery operates accurately", async () => {
      const registry = new LiveToolRegistry(toolsDir)

      // Tool A: Degraded Dormant (Fails 5 times initially -> DEGRADED, then inactive for 105 turns)
      const metaDegraded: ToolPackageMetadata = {
        name: "tool_degraded_dormant",
        version: "1.0.0",
        description: "Degraded dormant tool",
        author: "CHALLENGER",
        createdTimestamp: Date.now(),
        lastUpdatedTimestamp: Date.now(),
        entrypoint: "src/tool_degraded_dormant.js",
        status: "ACTIVE",
        totalInvocations: 0,
        failedInvocations: 0,
        averageDurationMs: 0,
        parameters: {},
      }

      // Tool B: Active Dormant (Succeeds 5 times initially -> ACTIVE, then inactive for 105 turns)
      const metaActiveDormant: ToolPackageMetadata = {
        name: "tool_active_dormant",
        version: "1.0.0",
        description: "Active dormant tool",
        author: "CHALLENGER",
        createdTimestamp: Date.now(),
        lastUpdatedTimestamp: Date.now(),
        entrypoint: "src/tool_active_dormant.js",
        status: "ACTIVE",
        totalInvocations: 0,
        failedInvocations: 0,
        averageDurationMs: 0,
        parameters: {},
      }

      // Tool C: Active Periodic (Executed every 10 turns, keeps unusedTurns <= 10)
      const metaActivePeriodic: ToolPackageMetadata = {
        name: "tool_active_periodic",
        version: "1.0.0",
        description: "Active periodic tool",
        author: "CHALLENGER",
        createdTimestamp: Date.now(),
        lastUpdatedTimestamp: Date.now(),
        entrypoint: "src/tool_active_periodic.js",
        status: "ACTIVE",
        totalInvocations: 0,
        failedInvocations: 0,
        averageDurationMs: 0,
        parameters: {},
      }

      // Tool D: Degraded Recovering (Degraded initially, but recovered at turn 50 through successful executions)
      const metaDegradedRecovering: ToolPackageMetadata = {
        name: "tool_degraded_recovering",
        version: "1.0.0",
        description: "Degraded recovering tool",
        author: "CHALLENGER",
        createdTimestamp: Date.now(),
        lastUpdatedTimestamp: Date.now(),
        entrypoint: "src/tool_degraded_recovering.js",
        status: "ACTIVE",
        totalInvocations: 0,
        failedInvocations: 0,
        averageDurationMs: 0,
        parameters: {},
      }

      await registry.registerTool(metaDegraded, { execute: async () => ({ output: "err" }) })
      await registry.registerTool(metaActiveDormant, { execute: async () => ({ output: "ok" }) })
      await registry.registerTool(metaActivePeriodic, { execute: async () => ({ output: "ok" }) })
      await registry.registerTool(metaDegradedRecovering, { execute: async () => ({ output: "ok" }) })

      // Setup initial states
      // 1. Degrade Tool A (5 failures)
      for (let i = 0; i < 5; i++) {
        await registry.recordExecution("tool_degraded_dormant", false, 10)
      }
      const statusA = await registry.evaluateHealth("tool_degraded_dormant")
      assert.strictEqual(statusA, "DEGRADED", "Tool A must be DEGRADED after 5 failures")

      // 2. Establish Tool B as Active (5 successes)
      for (let i = 0; i < 5; i++) {
        await registry.recordExecution("tool_active_dormant", true, 10)
      }
      const statusB = await registry.evaluateHealth("tool_active_dormant")
      assert.strictEqual(statusB, "ACTIVE", "Tool B must be ACTIVE after 5 successes")

      // 3. Establish Tool C as Active (5 successes)
      for (let i = 0; i < 5; i++) {
        await registry.recordExecution("tool_active_periodic", true, 10)
      }
      const statusC = await registry.evaluateHealth("tool_active_periodic")
      assert.strictEqual(statusC, "ACTIVE", "Tool C must be ACTIVE")

      // 4. Degrade Tool D (5 failures)
      for (let i = 0; i < 5; i++) {
        await registry.recordExecution("tool_degraded_recovering", false, 10)
      }
      const statusD = await registry.evaluateHealth("tool_degraded_recovering")
      assert.strictEqual(statusD, "DEGRADED", "Tool D must be DEGRADED initially")

      // Close setup turn
      await registry.recordTurn()

      // Verify all tools start unusedTurns at 0
      assert.strictEqual(registry.getUnusedTurns("tool_degraded_dormant"), 0)
      assert.strictEqual(registry.getUnusedTurns("tool_active_dormant"), 0)
      assert.strictEqual(registry.getUnusedTurns("tool_active_periodic"), 0)
      assert.strictEqual(registry.getUnusedTurns("tool_degraded_recovering"), 0)

      // =======================================================================
      // Run 105-turn simulation
      // =======================================================================
      for (let turn = 1; turn <= 105; turn++) {
        // Tool C executes every 10 turns
        if (turn % 10 === 0) {
          await registry.recordExecution("tool_active_periodic", true, 10)
        }

        // Tool D recovers at turn 50 by executing 8 successful calls
        if (turn === 50) {
          for (let k = 0; k < 8; k++) {
            await registry.recordExecution("tool_degraded_recovering", true, 10)
          }
          const recoveredStatus = await registry.evaluateHealth("tool_degraded_recovering")
          assert.strictEqual(
            recoveredStatus,
            "ACTIVE",
            "Tool D should recover to ACTIVE at turn 50"
          )
        }

        await registry.recordTurn()

        // Mid-point checks at turn 50
        if (turn === 50) {
          assert.strictEqual(registry.getUnusedTurns("tool_degraded_dormant"), 50)
          assert.strictEqual(registry.getUnusedTurns("tool_active_dormant"), 50)
          assert.strictEqual(registry.getMetadata("tool_degraded_dormant")?.status, "DEGRADED")
          assert.strictEqual(registry.getMetadata("tool_active_dormant")?.status, "ACTIVE")
        }

        // Boundary check at turn 99 (one turn before archival threshold)
        if (turn === 99) {
          assert.strictEqual(registry.getUnusedTurns("tool_degraded_dormant"), 99)
          assert.strictEqual(registry.getUnusedTurns("tool_active_dormant"), 99)
          // Crucial: Must NOT be ARCHIVED yet at turn 99
          assert.strictEqual(
            registry.getMetadata("tool_degraded_dormant")?.status,
            "DEGRADED",
            "Tool A must still be DEGRADED at turn 99 (< 100)"
          )
          assert.strictEqual(
            registry.getMetadata("tool_active_dormant")?.status,
            "ACTIVE",
            "Tool B must be ACTIVE at turn 99"
          )
        }

        // Exact transition check at turn 100
        if (turn === 100) {
          assert.strictEqual(registry.getUnusedTurns("tool_degraded_dormant"), 100)
          assert.strictEqual(registry.getUnusedTurns("tool_active_dormant"), 100)

          // Tool A (DEGRADED) MUST transition to ARCHIVED
          assert.strictEqual(
            registry.getMetadata("tool_degraded_dormant")?.status,
            "ARCHIVED",
            "Tool A must transition to ARCHIVED at turn 100"
          )

          // Tool B (ACTIVE) MUST REMAIN ACTIVE despite 100 unused turns
          assert.strictEqual(
            registry.getMetadata("tool_active_dormant")?.status,
            "ACTIVE",
            "Tool B must remain ACTIVE even after 100 unused turns"
          )

          // Tool C (ACTIVE PERIODIC) MUST REMAIN ACTIVE with small unused turns
          assert.strictEqual(
            registry.getMetadata("tool_active_periodic")?.status,
            "ACTIVE"
          )
          assert.ok(registry.getUnusedTurns("tool_active_periodic") <= 10)

          // Tool D (RECOVERED to ACTIVE) has 50 unused turns since turn 50 -> must still be ACTIVE
          assert.strictEqual(
            registry.getMetadata("tool_degraded_recovering")?.status,
            "ACTIVE"
          )
          assert.strictEqual(registry.getUnusedTurns("tool_degraded_recovering"), 50)
        }
      }

      // =======================================================================
      // Post-105-turn verifications
      // =======================================================================

      // 1. Tool A remains ARCHIVED
      assert.strictEqual(
        await registry.evaluateHealth("tool_degraded_dormant"),
        "ARCHIVED"
      )
      assert.strictEqual(
        registry.getMetadata("tool_degraded_dormant")?.status,
        "ARCHIVED"
      )
      assert.strictEqual(registry.getUnusedTurns("tool_degraded_dormant"), 105)

      // 2. Invoking ARCHIVED tool must throw
      await assert.rejects(
        async () => {
          await registry.invokeTool("tool_degraded_dormant", {})
        },
        (err: any) => {
          assert.ok(err.message.includes("is currently ARCHIVED and cannot be executed"))
          return true
        }
      )

      // 3. Tool B remains ACTIVE at 105 turns and CAN be invoked
      assert.strictEqual(
        await registry.evaluateHealth("tool_active_dormant"),
        "ACTIVE"
      )
      assert.strictEqual(
        registry.getMetadata("tool_active_dormant")?.status,
        "ACTIVE"
      )
      assert.strictEqual(registry.getUnusedTurns("tool_active_dormant"), 105)

      const invB = (await registry.invokeTool("tool_active_dormant", {})) as any
      assert.strictEqual(invB.output, "ok")

      // Invocation resets unused turns back to 0
      assert.strictEqual(registry.getUnusedTurns("tool_active_dormant"), 0)
      assert.strictEqual(
        registry.getMetadata("tool_active_dormant")?.telemetry.unusedTurns,
        0
      )

      // 4. Persistence across registry re-instantiation
      const freshRegistry = new LiveToolRegistry(toolsDir)
      await freshRegistry.loadActiveTools()

      const freshA = freshRegistry.getMetadata("tool_degraded_dormant")
      assert.strictEqual(
        freshA?.status,
        "ARCHIVED",
        "Tool A status must persist as ARCHIVED across reload"
      )
      assert.strictEqual(
        freshRegistry.getUnusedTurns("tool_degraded_dormant"),
        105,
        "Tool A unusedTurns must persist across reload"
      )

      const freshB = freshRegistry.getMetadata("tool_active_dormant")
      assert.strictEqual(
        freshB?.status,
        "ACTIVE",
        "Tool B status must persist as ACTIVE across reload"
      )
      assert.strictEqual(
        freshRegistry.getUnusedTurns("tool_active_dormant"),
        0,
        "Tool B reset unusedTurns must persist across reload"
      )
    })

    it("[CHALLENGE-ARC-02] Tool execution on turn 100 prevents archival of DEGRADED tool (resets unused turns)", async () => {
      const registry = new LiveToolRegistry(toolsDir)

      const meta: ToolPackageMetadata = {
        name: "tool_clutch_execution",
        version: "1.0.0",
        description: "Clutch execution tool",
        author: "CHALLENGER",
        createdTimestamp: Date.now(),
        lastUpdatedTimestamp: Date.now(),
        entrypoint: "src/tool_clutch_execution.js",
        status: "ACTIVE",
        totalInvocations: 0,
        failedInvocations: 0,
        averageDurationMs: 0,
        parameters: {},
      }

      await registry.registerTool(meta, { execute: async () => ({ output: "clutch" }) })

      // Degrade with 5 failures
      for (let i = 0; i < 5; i++) {
        await registry.recordExecution("tool_clutch_execution", false, 5)
      }
      assert.strictEqual(await registry.evaluateHealth("tool_clutch_execution"), "DEGRADED")
      // Close the turn where execution occurred
      await registry.recordTurn()
      assert.strictEqual(registry.getUnusedTurns("tool_clutch_execution"), 0)

      // Advance 99 unexecuted turns -> total 99 unused turns
      for (let i = 0; i < 99; i++) {
        await registry.recordTurn()
      }
      assert.strictEqual(registry.getUnusedTurns("tool_clutch_execution"), 99)
      assert.strictEqual(registry.getMetadata("tool_clutch_execution")?.status, "DEGRADED")

      // Turn 100: clutch execution occurs during this turn!
      await registry.recordExecution("tool_clutch_execution", false, 5) // Even if it fails again, it was used!
      assert.strictEqual(registry.getUnusedTurns("tool_clutch_execution"), 0)

      // Complete turn 100
      await registry.recordTurn()

      // Must NOT be archived, because it was executed in turn 100!
      assert.strictEqual(registry.getUnusedTurns("tool_clutch_execution"), 0)
      assert.strictEqual(
        registry.getMetadata("tool_clutch_execution")?.status,
        "DEGRADED",
        "Tool executed in turn 100 must not be archived"
      )
    })

    it("[CHALLENGE-ARC-03] Irreversibility: ARCHIVED status is terminal and cannot silently transition back", async () => {
      const registry = new LiveToolRegistry(toolsDir)

      const meta: ToolPackageMetadata = {
        name: "tool_terminal_archived",
        version: "1.0.0",
        description: "Terminal archived tool",
        author: "CHALLENGER",
        createdTimestamp: Date.now(),
        lastUpdatedTimestamp: Date.now(),
        entrypoint: "src/tool_terminal_archived.js",
        status: "ACTIVE",
        totalInvocations: 0,
        failedInvocations: 0,
        averageDurationMs: 0,
        parameters: {},
      }

      await registry.registerTool(meta, { execute: async () => ({ output: "terminal" }) })

      // Force degrade
      for (let i = 0; i < 5; i++) {
        await registry.recordExecution("tool_terminal_archived", false, 5)
      }
      assert.strictEqual(await registry.evaluateHealth("tool_terminal_archived"), "DEGRADED")
      // Close initial execution turn
      await registry.recordTurn()
      assert.strictEqual(registry.getUnusedTurns("tool_terminal_archived"), 0)

      // Advance 100 unexecuted turns to archive
      for (let i = 0; i < 100; i++) {
        await registry.recordTurn()
      }
      assert.strictEqual(await registry.evaluateHealth("tool_terminal_archived"), "ARCHIVED")

      // Subsequent health evaluation must remain ARCHIVED
      assert.strictEqual(await registry.evaluateHealth("tool_terminal_archived"), "ARCHIVED")

      // Attempting to record an execution on archived tool must preserve ARCHIVED status
      await registry.recordExecution("tool_terminal_archived", true, 5)
      assert.strictEqual(
        registry.getMetadata("tool_terminal_archived")?.status,
        "ARCHIVED",
        "ARCHIVED status must be terminal and not revert to ACTIVE"
      )
    })

    it("[CHALLENGE-ARC-04] Physical file hot-loading and execution persistence across reload after 100 turns", async () => {
      // Create a physical JS file in toolsDir/src/
      const srcDir = path.join(toolsDir, "src")
      await fs.mkdir(srcDir, { recursive: true })
      const toolFilePath = path.join(srcDir, "physical_persistent_tool.js")
      const toolCode = `
export default {
  description: "Physically persisted tool",
  args: {},
  async execute() {
    return { output: "physical_success" }
  }
}
`
      await fs.writeFile(toolFilePath, toolCode, "utf-8")

      const registry1 = new LiveToolRegistry(toolsDir)
      const meta: ToolPackageMetadata = {
        name: "physical_persistent_tool",
        version: "1.0.0",
        description: "Physically persisted tool",
        author: "CHALLENGER",
        createdTimestamp: Date.now(),
        lastUpdatedTimestamp: Date.now(),
        entrypoint: "src/physical_persistent_tool.js",
        status: "ACTIVE",
        totalInvocations: 0,
        failedInvocations: 0,
        averageDurationMs: 0,
        parameters: {},
      }

      // Add a companion degraded tool to trigger the registry flush at turn 100
      const metaCompanion: ToolPackageMetadata = {
        name: "companion_degraded_flusher",
        version: "1.0.0",
        description: "Companion degraded flusher",
        author: "CHALLENGER",
        createdTimestamp: Date.now(),
        lastUpdatedTimestamp: Date.now(),
        entrypoint: "src/companion_degraded_flusher.js",
        status: "ACTIVE",
        totalInvocations: 0,
        failedInvocations: 0,
        averageDurationMs: 0,
        parameters: {},
      }

      await registry1.registerAndLoad(meta)
      await registry1.registerTool(metaCompanion, { execute: async () => ({ output: "err" }) })

      // Degrade companion tool
      for (let i = 0; i < 5; i++) {
        await registry1.recordExecution("companion_degraded_flusher", false, 5)
      }
      assert.strictEqual(await registry1.evaluateHealth("companion_degraded_flusher"), "DEGRADED")

      // Initial execution of physical_persistent_tool
      const res1 = (await registry1.invokeTool("physical_persistent_tool", {})) as any
      assert.strictEqual(res1.output, "physical_success")

      // Close execution turn
      await registry1.recordTurn()

      // Advance 100 turns
      for (let i = 0; i < 100; i++) {
        await registry1.recordTurn()
      }

      // At turn 100: companion_degraded_flusher archived, flushing registry.json to disk!
      assert.strictEqual(await registry1.evaluateHealth("companion_degraded_flusher"), "ARCHIVED")
      assert.strictEqual(await registry1.evaluateHealth("physical_persistent_tool"), "ACTIVE")

      // Instantiate fresh registry and load from disk
      const registry2 = new LiveToolRegistry(toolsDir)
      await registry2.loadActiveTools()

      const loadedMeta = registry2.getMetadata("physical_persistent_tool")
      assert.strictEqual(loadedMeta?.status, "ACTIVE")
      assert.strictEqual(registry2.getUnusedTurns("physical_persistent_tool"), 100)

      // Invoke through fresh registry dynamically imported module
      const res2 = (await registry2.invokeTool("physical_persistent_tool", {})) as any
      assert.strictEqual(res2.output, "physical_success")
      assert.strictEqual(registry2.getUnusedTurns("physical_persistent_tool"), 0)
    })

    it("[CHALLENGE-TURN-01] Multiple executions within a single turn do not desynchronize turn counter", async () => {
      const registry = new LiveToolRegistry(toolsDir)

      const metaA: ToolPackageMetadata = {
        name: "tool_multi_turn_a",
        version: "1.0.0",
        description: "Tool Multi A",
        author: "CHALLENGER",
        createdTimestamp: Date.now(),
        lastUpdatedTimestamp: Date.now(),
        entrypoint: "src/tool_multi_turn_a.js",
        status: "ACTIVE",
        totalInvocations: 0,
        failedInvocations: 0,
        averageDurationMs: 0,
        parameters: {},
      }

      const metaB: ToolPackageMetadata = {
        name: "tool_multi_turn_b",
        version: "1.0.0",
        description: "Tool Multi B",
        author: "CHALLENGER",
        createdTimestamp: Date.now(),
        lastUpdatedTimestamp: Date.now(),
        entrypoint: "src/tool_multi_turn_b.js",
        status: "ACTIVE",
        totalInvocations: 0,
        failedInvocations: 0,
        averageDurationMs: 0,
        parameters: {},
      }

      await registry.registerTool(metaA, { execute: async () => ({ output: "a" }) })
      await registry.registerTool(metaB, { execute: async () => ({ output: "b" }) })

      // Execute Tool A 10 times in a single turn
      for (let i = 0; i < 10; i++) {
        await registry.recordExecution("tool_multi_turn_a", true, 2)
      }

      // Close turn
      await registry.recordTurn()

      // Tool A unused turns is 0, Tool B unused turns is 1
      assert.strictEqual(registry.getUnusedTurns("tool_multi_turn_a"), 0)
      assert.strictEqual(registry.getUnusedTurns("tool_multi_turn_b"), 1)
      assert.strictEqual(
        registry.getMetadata("tool_multi_turn_a")?.telemetry.totalInvocations,
        10
      )
    })
  })
})
