import * as fs from "node:fs/promises"
import * as path from "node:path"
import { TelemetryCalculator } from "../core/telemetry.js"
import type {
  ILiveToolRegistry,
  ToolPackageMetadata,
  ToolLifecycleStatus,
} from "../../specs/contracts/live-tools.js"

export class LiveToolRegistry implements ILiveToolRegistry {
  private registryFilePath: string
  private toolsMap: Map<string, { metadata: ToolPackageMetadata; executable?: unknown }> =
    new Map()

  constructor(private toolsDir: string) {
    this.registryFilePath = path.join(toolsDir, "registry.json")
  }

  public async loadActiveTools(): Promise<void> {
    try {
      const data = await fs.readFile(this.registryFilePath, "utf-8")
      const list: ToolPackageMetadata[] = JSON.parse(data)
      for (const meta of list) {
        let executable: unknown = undefined
        if (meta.status === "ACTIVE") {
          executable = await this.loadExecutable(meta.name, meta.entrypoint)
        }
        this.toolsMap.set(meta.name, { metadata: meta, executable })
      }
    } catch {
      // Initialize empty registry file if missing
      await this.saveRegistry()
    }
  }

  public async loadExecutable(toolName: string, entrypoint: string): Promise<unknown> {
    const absPath = path.isAbsolute(entrypoint)
      ? entrypoint
      : path.join(this.toolsDir, entrypoint)

    try {
      const fileUrl = `file://${absPath}?t=${Date.now()}`
      const mod = await import(fileUrl)
      const executable =
        mod.default ||
        mod[toolName] ||
        Object.values(mod).find(
          (v: any) => typeof v === "object" && v !== null && "execute" in v
        )
      return executable
    } catch (err) {
      console.error(`[Project DNA] Failed to dynamically import tool ${toolName}:`, err)
      return undefined
    }
  }

  public async registerTool(
    metadata: ToolPackageMetadata,
    executableModule?: unknown
  ): Promise<void> {
    this.toolsMap.set(metadata.name, {
      metadata,
      executable: executableModule,
    })
    await this.saveRegistry()
  }

  public async registerAndLoad(metadata: ToolPackageMetadata): Promise<unknown> {
    const executable = await this.loadExecutable(metadata.name, metadata.entrypoint)
    this.toolsMap.set(metadata.name, {
      metadata,
      executable,
    })
    await this.saveRegistry()
    return executable
  }

  public getToolMap(): Record<string, unknown> {
    const map: Record<string, unknown> = {}
    for (const [name, entry] of this.toolsMap.entries()) {
      if (entry.metadata.status === "ACTIVE" && entry.executable) {
        map[name] = entry.executable
      }
    }
    return map
  }

  public getMetadata(toolName: string): ToolPackageMetadata | undefined {
    return this.toolsMap.get(toolName)?.metadata
  }

  public isLiveTool(toolName: string): boolean {
    return this.toolsMap.has(toolName)
  }

  public async recordExecution(
    toolName: string,
    success: boolean,
    durationMs: number
  ): Promise<void> {
    const entry = this.toolsMap.get(toolName)
    if (!entry) return

    const tele = entry.metadata.telemetry
    tele.totalInvocations++
    if (success) {
      tele.successCount++
    } else {
      tele.failureCount++
    }

    tele.avgDurationMs =
      Math.round(((tele.avgDurationMs * (tele.totalInvocations - 1) + durationMs) /
        tele.totalInvocations) * 100) / 100

    tele.healthScore = TelemetryCalculator.computeHealthScore(
      tele.successCount,
      tele.failureCount
    )
    tele.lastExecutedAt = new Date().toISOString()
    entry.metadata.updatedAt = new Date().toISOString()

    await this.evaluateHealth(toolName)
    await this.saveRegistry()
  }

  public async evaluateHealth(toolName: string): Promise<ToolLifecycleStatus> {
    const entry = this.toolsMap.get(toolName)
    if (!entry) return "ARCHIVED"

    const tele = entry.metadata.telemetry
    if (tele.totalInvocations >= 5 && tele.healthScore < 0.6) {
      entry.metadata.status = "DEGRADED"
    } else if (tele.healthScore >= 0.6 && entry.metadata.status === "DEGRADED") {
      entry.metadata.status = "ACTIVE"
    }

    return entry.metadata.status
  }

  private async saveRegistry(): Promise<void> {
    const list = Array.from(this.toolsMap.values()).map((v) => v.metadata)
    await fs.mkdir(path.dirname(this.registryFilePath), { recursive: true })
    await fs.writeFile(this.registryFilePath, JSON.stringify(list, null, 2), "utf-8")
  }
}
