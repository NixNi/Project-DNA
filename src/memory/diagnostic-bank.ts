import type {
  IDiagnosticBank,
  DiagnosticTrace,
  ILiveMemoryStore,
} from "../../specs/contracts/live-memory.js"
import { randomUUID } from "node:crypto"

export class DiagnosticBank implements IDiagnosticBank {
  private traces: DiagnosticTrace[] = []

  public async recordFailure(
    trace: Omit<DiagnosticTrace, "id" | "timestamp">
  ): Promise<void> {
    const signature = this.normalizeErrorSignature(trace.rawError)
    const newTrace: DiagnosticTrace = {
      id: randomUUID(),
      sessionID: trace.sessionID,
      errorSignature: signature,
      command: trace.command,
      toolName: trace.toolName,
      rawError: trace.rawError,
      recoveryAction: trace.recoveryAction,
      resolved: false,
      timestamp: new Date().toISOString(),
    }

    this.traces.push(newTrace)
  }

  public async recordRecovery(sessionID: string, recoveryAction: string): Promise<void> {
    // Find the latest unresolved trace for this session and mark as resolved
    for (let i = this.traces.length - 1; i >= 0; i--) {
      const trace = this.traces[i]
      if (trace.sessionID === sessionID && !trace.resolved) {
        trace.resolved = true
        trace.recoveryAction = recoveryAction
        break
      }
    }
  }

  public async getActiveDiagnostics(sessionID: string): Promise<DiagnosticTrace[]> {
    return this.traces.filter((t) => t.sessionID === sessionID && !t.resolved)
  }

  public async getAllTraces(): Promise<DiagnosticTrace[]> {
    return [...this.traces]
  }

  public async distillToMemory(memoryStore: ILiveMemoryStore): Promise<void> {
    // Find resolved traces that have a clear recovery action
    const resolvedTraces = this.traces.filter((t) => t.resolved && t.recoveryAction)

    // Group by signature
    const signatureGroups = new Map<string, DiagnosticTrace[]>()
    for (const trace of resolvedTraces) {
      const group = signatureGroups.get(trace.errorSignature) ?? []
      group.push(trace)
      signatureGroups.set(trace.errorSignature, group)
    }

    for (const [sig, group] of signatureGroups.entries()) {
      if (group.length >= 1) {
        const sample = group[group.length - 1]
        const toolOrCommand = sample.toolName ? `Tool: ${sample.toolName}` : `Command: ${sample.command}`

        await memoryStore.createCard({
          title: `Diagnostic Recovery: ${sig.slice(0, 50)}`,
          category: "ERROR_DIAGNOSTIC",
          insight: `When encountering error "${sig}", apply recovery: ${sample.recoveryAction}`,
          context: `Observed in ${toolOrCommand}`,
          evidence: sample.rawError.slice(0, 500),
          tags: ["error-recovery", "diagnostic", ...(sample.toolName ? [sample.toolName] : [])],
        })
      }
    }
  }

  /**
   * Normalizes raw error logs by stripping file paths, line numbers, and timestamps
   */
  public normalizeErrorSignature(rawError: string): string {
    return rawError
      .split("\n")[0]
      .replace(/\/[\w.-]+/g, "<path>")
      .replace(/:\d+:\d+/g, ":<line>:<col>")
      .replace(/0x[0-9a-fA-F]+/g, "<hex>")
      .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z/g, "<time>")
      .trim()
      .slice(0, 150)
  }
}
