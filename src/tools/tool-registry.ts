import * as fs from "node:fs/promises"
import * as path from "node:path"
import { pathToFileURL } from "node:url"
import { TelemetryCalculator } from "../core/telemetry.js"
import type {
  ILiveToolRegistry,
  ToolPackageMetadata,
  ToolLifecycleStatus,
  ToolTelemetry,
} from "../../specs/contracts/live-tools.js"

export class LiveToolRegistry implements ILiveToolRegistry {
  private registryFilePath: string
  private toolsMap: Map<string, { metadata: ToolPackageMetadata; executable?: unknown }> =
    new Map()

  constructor(private toolsDir: string) {
    this.registryFilePath = path.join(toolsDir, "registry.json")
  }

  public static formatDescriptionWithStats(
    baseDescription: string,
    telemetry?: ToolTelemetry
  ): string {
    const cleanDesc = baseDescription.replace(/\s*\[Stats:[^\]]*\]\s*$/, "").trim()
    if (!telemetry || telemetry.totalInvocations === 0) {
      return `${cleanDesc} [Stats: 0 calls]`
    }
    const healthPct = Math.round(telemetry.healthScore * 100)
    return `${cleanDesc} [Stats: ${telemetry.totalInvocations} calls, ${healthPct}% health, ${telemetry.avgDurationMs}ms avg]`
  }

  public wrapExecutable(toolName: string, executable: unknown): unknown {
    if (!executable) return executable

    const execObj = executable as any
    // 1. Normalize schema: if model used input: z.object(...) instead of args: { ... }
    if (typeof execObj === "object") {
      if (!execObj.args && execObj.input) {
        if (execObj.input._def?.shape) {
          execObj.args =
            typeof execObj.input._def.shape === "function"
              ? execObj.input._def.shape()
              : execObj.input._def.shape
        } else if (execObj.input.shape) {
          execObj.args = execObj.input.shape
        } else {
          execObj.args = {}
        }
      }
      if (!execObj.args) {
        execObj.args = {}
      }

      // 2. Ensure description remains stable and immutable to guarantee 100% KV cache preservation
      const meta = this.toolsMap.get(toolName)?.metadata
      if (meta && meta.description) {
        execObj.description = meta.description
      }
    }

    // 3. Wrap execution method with timing, telemetry recording, and result normalization
    if (typeof execObj === "object" && typeof execObj.execute === "function") {
      const originalExecute = execObj.execute.bind(execObj)
      execObj.execute = async (args: any, ctx: any) => {
        const startTime = Date.now()
        let raw: unknown
        try {
          raw = await originalExecute(args, ctx)
          const normalized = LiveToolRegistry.normalizeToolResult(toolName, raw)
          const durationMs = Date.now() - startTime
          await this.recordExecution(toolName, true, durationMs).catch(() => {})
          const tele = this.toolsMap.get(toolName)?.metadata?.telemetry
          if (tele) {
            normalized.metadata = {
              ...(normalized.metadata ?? {}),
              telemetry: {
                totalInvocations: tele.totalInvocations,
                healthScore: tele.healthScore,
                avgDurationMs: tele.avgDurationMs,
                lastDurationMs: durationMs,
              },
            }
            if (!normalized.title) {
              normalized.title = `${toolName} [Run #${tele.totalInvocations} | ${Math.round(tele.healthScore * 100)}% health | ${durationMs}ms]`
            }
          }
          return normalized
        } catch (err) {
          const durationMs = Date.now() - startTime
          await this.recordExecution(toolName, false, durationMs).catch(() => {})
          throw err
        }
      }
      return execObj
    } else if (typeof execObj === "function") {
      const originalFn = execObj
      const wrappedFn = async (args: any, ctx: any) => {
        const startTime = Date.now()
        try {
          const raw = await originalFn(args, ctx)
          const normalized = LiveToolRegistry.normalizeToolResult(toolName, raw)
          const durationMs = Date.now() - startTime
          await this.recordExecution(toolName, true, durationMs).catch(() => {})
          return normalized
        } catch (err) {
          const durationMs = Date.now() - startTime
          await this.recordExecution(toolName, false, durationMs).catch(() => {})
          throw err
        }
      }
      return wrappedFn
    }

    return executable
  }

  public async loadActiveTools(): Promise<void> {
    try {
      const data = await fs.readFile(this.registryFilePath, "utf-8")
      const list: ToolPackageMetadata[] = JSON.parse(data)
      let dirty = false
      for (const meta of list) {
        if (!meta.telemetry) {
          meta.telemetry = {
            totalInvocations: 0,
            successCount: 0,
            failureCount: 0,
            avgDurationMs: 0,
            healthScore: 1.0,
          }
          dirty = true
        }
        this.toolsMap.set(meta.name, { metadata: meta, executable: undefined })

        let executable: unknown = undefined
        if (meta.status === "ACTIVE") {
          const rawExecutable = await this.loadExecutable(meta.name, meta.entrypoint)
          executable = this.wrapExecutable(meta.name, rawExecutable)

          // Sync parameters if missing in metadata
          if (executable && typeof executable === "object") {
            const execObj = executable as any
            if ((!meta.parameters || Object.keys(meta.parameters).length === 0) && execObj.args) {
              meta.parameters = Object.keys(execObj.args).reduce((acc: any, k: string) => {
                acc[k] = execObj.args[k]?.description || "parameter"
                return acc
              }, {})
              dirty = true
            }
          }
        }
        this.toolsMap.set(meta.name, { metadata: meta, executable })
      }
      if (dirty) {
        await this.saveRegistry()
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
      const fileUrl = `${pathToFileURL(absPath).href}?t=${Date.now()}`
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

  public static normalizeToolResult(
    toolName: string,
    raw: unknown
  ): {
    title?: string
    output: string
    metadata?: Record<string, unknown>
  } {
    if (typeof raw === "string") {
      return { output: raw }
    }
    if (raw && typeof raw === "object") {
      const obj = raw as Record<string, unknown>
      if (typeof obj.output === "string") {
        const result: {
          title?: string
          output: string
          metadata?: Record<string, unknown>
        } = {
          output: obj.output,
        }
        if (typeof obj.title === "string") {
          result.title = obj.title
        }
        if (obj.metadata && typeof obj.metadata === "object") {
          result.metadata = obj.metadata as Record<string, unknown>
        }
        return result
      }
      // If the tool returned a raw structured object (e.g. { platform: "darwin", arch: "arm64" }),
      // serialize to pretty-printed JSON string so OpenCode never crashes on c.split()
      const result: {
        title?: string
        output: string
        metadata?: Record<string, unknown>
      } = {
        output: JSON.stringify(raw, null, 2),
        metadata: obj,
      }
      if (typeof obj.title === "string") {
        result.title = obj.title
      }
      return result
    }
    return { output: String(raw ?? "") }
  }

  public async registerTool(
    metadata: ToolPackageMetadata,
    executableModule?: unknown
  ): Promise<void> {
    this.toolsMap.set(metadata.name, {
      metadata,
      executable: undefined,
    })
    const executable = executableModule
      ? this.wrapExecutable(metadata.name, executableModule)
      : undefined
    this.toolsMap.set(metadata.name, {
      metadata,
      executable,
    })
    await this.saveRegistry()
  }

  public async registerAndLoad(metadata: ToolPackageMetadata): Promise<unknown> {
    this.toolsMap.set(metadata.name, {
      metadata,
      executable: undefined,
    })
    const rawExecutable = await this.loadExecutable(metadata.name, metadata.entrypoint)
    const executable = this.wrapExecutable(metadata.name, rawExecutable)
    this.toolsMap.set(metadata.name, {
      metadata,
      executable,
    })
    await this.saveRegistry()
    return executable
  }

  public getToolMap(): Record<string, unknown> {
    const sortedKeys = Array.from(this.toolsMap.keys()).sort()
    const map: Record<string, unknown> = {}
    for (const name of sortedKeys) {
      const entry = this.toolsMap.get(name)
      if (entry && entry.metadata.status === "ACTIVE" && entry.executable) {
        map[name] = entry.executable
      }
    }
    return map
  }

  public async invokeTool(
    toolName: string,
    args: Record<string, unknown>,
    context?: unknown
  ): Promise<unknown> {
    const entry = this.toolsMap.get(toolName)
    if (!entry) {
      throw new Error(`Live tool '${toolName}' is not registered. Available tools: ${Array.from(this.toolsMap.keys()).join(", ") || "none"}`)
    }
    if (entry.metadata.status !== "ACTIVE" || !entry.executable) {
      throw new Error(`Live tool '${toolName}' is currently ${entry.metadata.status} and cannot be executed.`)
    }

    const exec = entry.executable as any
    if (typeof exec === "function") {
      return await exec(args, context)
    } else if (exec && typeof exec.execute === "function") {
      return await exec.execute(args, context)
    } else {
      throw new Error(`Live tool '${toolName}' does not export a runnable execute method.`)
    }
  }

  public listTools(): Array<{
    name: string
    description: string
    parameters?: Record<string, unknown>
    status: ToolLifecycleStatus
    totalInvocations: number
    healthScore: number
  }> {
    const list: Array<{
      name: string
      description: string
      parameters?: Record<string, unknown>
      status: ToolLifecycleStatus
      totalInvocations: number
      healthScore: number
    }> = []
    const sortedKeys = Array.from(this.toolsMap.keys()).sort()
    for (const name of sortedKeys) {
      const entry = this.toolsMap.get(name)
      if (entry) {
        // Extract parameters from metadata or executable args
        let parameters = entry.metadata.parameters
        if ((!parameters || Object.keys(parameters).length === 0) && entry.executable) {
          const exec = entry.executable as any
          if (exec.args && typeof exec.args === "object") {
            parameters = Object.keys(exec.args).reduce((acc: any, key: string) => {
              acc[key] = exec.args[key]?.description || "parameter"
              return acc
            }, {})
          }
        }

        list.push({
          name: entry.metadata.name,
          description: LiveToolRegistry.formatDescriptionWithStats(
            entry.metadata.description,
            entry.metadata.telemetry
          ),
          parameters,
          status: entry.metadata.status,
          totalInvocations: entry.metadata.telemetry?.totalInvocations ?? 0,
          healthScore: entry.metadata.telemetry?.healthScore ?? 1.0,
        })
      }
    }
    return list
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

    if (!entry.metadata.telemetry) {
      entry.metadata.telemetry = {
        totalInvocations: 0,
        successCount: 0,
        failureCount: 0,
        avgDurationMs: 0,
        healthScore: 1.0,
      }
    }

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
