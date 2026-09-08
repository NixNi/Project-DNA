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

  public setUserGoal(sessionID: string, goal: string): void {
    const buf = this.buffers.get(sessionID)
    if (buf) {
      buf.userGoal = goal
    }
  }

  public setResolution(sessionID: string, resolution: "SUCCESS" | "FAILED"): void {
    const buf = this.buffers.get(sessionID)
    if (buf) {
      buf.finalResolution = resolution
    }
  }

  public isEligibleForHarvest(sessionID: string): boolean {
    const buf = this.buffers.get(sessionID)
    if (!buf || buf.finalResolution !== "SUCCESS") return false

    // Eligible if >= 3 steps and includes tool interactions
    return buf.steps.length >= 3
  }

  public getTrace(sessionID: string): SessionTraceBuffer | null {
    return this.buffers.get(sessionID) ?? null
  }

  public clearTrace(sessionID: string): void {
    this.buffers.delete(sessionID)
  }
}
