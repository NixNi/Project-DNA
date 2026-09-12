/**
 * Turn Tracker & Telemetry Evaluation
 * Manages the sliding window of recent execution outcomes, turn counting,
 * health score recalculation, and automatic archival of degraded tools.
 */

import { TelemetryCalculator } from "../../core/telemetry.js"
import type {
  ToolPackageMetadata,
  ToolLifecycleStatus,
  ToolTelemetry,
} from "../../../specs/contracts/live-tools.js"

export class TurnTracker {
  private recentExecutionsMap: Map<string, boolean[]> = new Map()
  private unusedTurnsMap: Map<string, number> = new Map()
  private toolsExecutedInCurrentTurn: Set<string> = new Set()

  public initTool(toolName: string, telemetry?: ToolTelemetry): void {
    const teleRecent = (telemetry as any)?.recentExecutions
    if (Array.isArray(teleRecent)) {
      this.recentExecutionsMap.set(toolName, teleRecent.slice(-5))
    } else if (!this.recentExecutionsMap.has(toolName)) {
      this.recentExecutionsMap.set(toolName, [])
    }

    const teleUnused = (telemetry as any)?.unusedTurns
    if (typeof teleUnused === "number") {
      this.unusedTurnsMap.set(toolName, Math.max(0, teleUnused))
    } else if (!this.unusedTurnsMap.has(toolName)) {
      this.unusedTurnsMap.set(toolName, 0)
    }
  }

  public recordExecution(
    toolName: string,
    success: boolean,
    durationMs: number,
    metadata: ToolPackageMetadata
  ): void {
    if (!metadata.telemetry) {
      metadata.telemetry = {
        totalInvocations: 0,
        successCount: 0,
        failureCount: 0,
        avgDurationMs: 0,
        healthScore: 1.0,
      }
    }

    const tele = metadata.telemetry
    tele.totalInvocations++
    if (success) {
      tele.successCount++
    } else {
      tele.failureCount++
    }

    tele.avgDurationMs =
      Math.round(
        ((tele.avgDurationMs * (tele.totalInvocations - 1) + durationMs) /
          tele.totalInvocations) *
          100
      ) / 100

    // Maintain sliding window of last 5 execution outcomes
    const history = this.recentExecutionsMap.get(toolName) ?? []
    history.push(success)
    if (history.length > 5) {
      history.shift()
    }
    this.recentExecutionsMap.set(toolName, history)
    tele.recentExecutions = [...history]

    const recentFailuresInLast5 = history.filter((s) => !s).length
    tele.healthScore = TelemetryCalculator.computeHealthScore(
      tele.successCount,
      tele.failureCount,
      recentFailuresInLast5
    )
    tele.lastExecutedAt = new Date().toISOString()
    metadata.updatedAt = new Date().toISOString()

    // Reset unused turn counter and mark executed in current turn
    this.toolsExecutedInCurrentTurn.add(toolName)
    this.unusedTurnsMap.set(toolName, 0)
    tele.unusedTurns = 0
  }

  public recordTurn(
    toolsMap: Map<string, { metadata: ToolPackageMetadata; executable?: unknown }>
  ): boolean {
    let dirty = false
    for (const [toolName, entry] of toolsMap) {
      const executed = this.toolsExecutedInCurrentTurn.has(toolName)
      let unusedTurns =
        this.unusedTurnsMap.get(toolName) ?? entry.metadata.telemetry?.unusedTurns ?? 0

      if (executed) {
        unusedTurns = 0
      } else {
        unusedTurns++
      }

      this.unusedTurnsMap.set(toolName, unusedTurns)
      if (entry.metadata.telemetry) {
        entry.metadata.telemetry.unusedTurns = unusedTurns
      }

      if (entry.metadata.status === "DEGRADED" && unusedTurns >= 100) {
        entry.metadata.status = "ARCHIVED"
        entry.metadata.updatedAt = new Date().toISOString()
        dirty = true
      }
    }

    this.toolsExecutedInCurrentTurn.clear()
    return dirty
  }

  public evaluateHealth(
    toolName: string,
    metadata: ToolPackageMetadata
  ): { status: ToolLifecycleStatus; dirty: boolean } {
    const tele = metadata.telemetry
    const unusedTurns = this.unusedTurnsMap.get(toolName) ?? tele?.unusedTurns ?? 0
    const prevStatus = metadata.status

    if (metadata.status === "ARCHIVED") {
      return { status: "ARCHIVED", dirty: false }
    }

    if (tele && tele.totalInvocations >= 5 && tele.healthScore < 0.6) {
      if (unusedTurns >= 100) {
        metadata.status = "ARCHIVED"
      } else {
        metadata.status = "DEGRADED"
      }
    } else if (metadata.status === "DEGRADED") {
      if (unusedTurns >= 100) {
        metadata.status = "ARCHIVED"
      } else if (tele && tele.healthScore >= 0.6) {
        metadata.status = "ACTIVE"
      }
    }

    if (metadata.status !== prevStatus) {
      metadata.updatedAt = new Date().toISOString()
      return { status: metadata.status, dirty: true }
    }

    return { status: metadata.status, dirty: false }
  }

  public getRecentExecutions(toolName: string): boolean[] {
    return [...(this.recentExecutionsMap.get(toolName) ?? [])]
  }

  public getUnusedTurns(toolName: string, metadata?: ToolPackageMetadata): number {
    return (
      this.unusedTurnsMap.get(toolName) ??
      (metadata?.telemetry as any)?.unusedTurns ??
      0
    )
  }

  public deleteTool(toolName: string): void {
    this.recentExecutionsMap.delete(toolName)
    this.unusedTurnsMap.delete(toolName)
    this.toolsExecutedInCurrentTurn.delete(toolName)
  }
}
