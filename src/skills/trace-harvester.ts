import type {
  ILiveSkillHarvester,
  ExecutionTraceStep,
  SessionTraceBuffer,
} from "../../specs/contracts/live-skills.js"

export class LiveSkillHarvester implements ILiveSkillHarvester {
  private buffers: Map<string, SessionTraceBuffer> = new Map()

  public recordStep(sessionID: string, step: ExecutionTraceStep): void {
    let buf = this.buffers.get(sessionID)
    if (!buf) {
      buf = {
        sessionID,
        userGoal: "",
        steps: [],
        finalResolution: "IN_PROGRESS",
      }
      this.buffers.set(sessionID, buf)
    }

    buf.steps.push(step)
  }

  public updateStepOutput(
    sessionID: string,
    toolName: string,
    output: string,
    exitCode?: number
  ): void {
    const buf = this.buffers.get(sessionID)
    if (!buf || buf.steps.length === 0) return

    // Find the latest step matching toolName with empty output or last step
    for (let i = buf.steps.length - 1; i >= 0; i--) {
      const s = buf.steps[i]
      if (s.tool === toolName) {
        s.output = output
        if (exitCode !== undefined) {
          s.exitCode = exitCode
        }
        return
      }
    }

    // Fallback: update the very latest step
    const latest = buf.steps[buf.steps.length - 1]
    if (latest) {
      latest.output = output
      if (exitCode !== undefined) {
        latest.exitCode = exitCode
      }
    }
  }

  public setUserGoal(sessionID: string, goal: string): void {
    let buf = this.buffers.get(sessionID)
    if (!buf) {
      buf = {
        sessionID,
        userGoal: goal,
        steps: [],
        finalResolution: "IN_PROGRESS",
      }
      this.buffers.set(sessionID, buf)
      return
    }

    const trimmed = goal.trim()
    // Avoid overwriting a substantive goal with short conversational acknowledgements
    const isAcknowledgement = /^(yes|ok|okay|sure|thanks|thank you|proceed|continue|fix this|go ahead|looks good)[\.!]?$/i.test(
      trimmed
    )

    if (!buf.userGoal) {
      buf.userGoal = trimmed
    } else if (!isAcknowledgement && trimmed.length > 15) {
      // Append or replace if a new distinct task instruction was given
      buf.userGoal = `${buf.userGoal} -> ${trimmed}`
    }
  }

  public setResolution(sessionID: string, resolution: "SUCCESS" | "FAILED"): void {
    const buf = this.buffers.get(sessionID)
    if (buf) {
      buf.finalResolution = resolution
    }
  }

  /**
   * Intelligently infers session resolution if still IN_PROGRESS.
   * If the session had multiple steps and completed without active unresolved errors,
   * it marks the resolution as SUCCESS to enable skill harvesting.
   */
  public evaluateAndSetResolution(sessionID: string, hasUnresolvedError = false): "SUCCESS" | "FAILED" {
    const buf = this.buffers.get(sessionID)
    if (!buf) return "FAILED"

    if (buf.finalResolution === "IN_PROGRESS") {
      buf.finalResolution = (!hasUnresolvedError && buf.steps.length >= 2) ? "SUCCESS" : "FAILED"
    }

    return buf.finalResolution
  }

  public isEligibleForHarvest(sessionID: string): boolean {
    const buf = this.buffers.get(sessionID)
    if (!buf || buf.finalResolution !== "SUCCESS") return false

    // Eligible if >= 2 steps and includes tool interactions
    return buf.steps.length >= 2
  }

  public getTrace(sessionID: string): SessionTraceBuffer | null {
    return this.buffers.get(sessionID) ?? null
  }

  public clearTrace(sessionID: string): void {
    this.buffers.delete(sessionID)
  }
}
