import * as fs from "node:fs/promises"
import * as path from "node:path"
import { pathToFileURL } from "node:url"
import type {
  ILiveToolRegistry,
  ToolPackageMetadata,
  ToolLifecycleStatus,
  ToolTelemetry,
} from "../../specs/contracts/live-tools.js"
import {
  normalizeToolResult,
  formatDescriptionWithStats,
  wrapExecutable,
  WRAPPED_MARKER,
  UNWRAPPED_EXECUTE,
  REGISTRY_INSTANCE,
} from "./registry/execution-wrapper.js"
import { TurnTracker } from "./registry/turn-tracker.js"
import { cleanupOlderVersions, removeToolFiles } from "./registry/version-cleaner.js"

export { WRAPPED_MARKER, UNWRAPPED_EXECUTE, REGISTRY_INSTANCE }

export class LiveToolRegistry implements ILiveToolRegistry {
  private registryFilePath: string
  private toolsMap: Map<string, { metadata: ToolPackageMetadata; executable?: unknown }> =
    new Map()
  private turnTracker = new TurnTracker()

  constructor(private toolsDir: string) {
    this.registryFilePath = path.join(toolsDir, "registry.json")
  }

  public static formatDescriptionWithStats(
    baseDescription: string,
    telemetry?: ToolTelemetry
  ): string {
    return formatDescriptionWithStats(baseDescription, telemetry)
  }

  public static normalizeToolResult(
    toolName: string,
    raw: unknown
  ): {
    title?: string
    output: string
    metadata?: Record<string, unknown>
  } {
    return normalizeToolResult(toolName, raw)
  }

  public wrapExecutable(toolName: string, executable: unknown): unknown {
    return wrapExecutable(toolName, executable, {
      registry: this,
      getMetadata: (name) => this.toolsMap.get(name)?.metadata,
      recordExecution: (name, success, durationMs) =>
        this.recordExecution(name, success, durationMs),
    })
  }

  public async loadActiveTools(): Promise<void> {
    await this.reloadTools(false)
  }

  public async loadExecutable(toolName: string, entrypoint: string): Promise<unknown> {
    const absPath = path.isAbsolute(entrypoint)
      ? entrypoint
      : path.join(this.toolsDir, entrypoint)

    try {
      const cacheBuster = `v=${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
      const fileUrl = `${pathToFileURL(absPath).href}?${cacheBuster}`
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
    this.turnTracker.initTool(metadata.name, metadata.telemetry)
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
    // Preserve existing telemetry if re-registering
    const existing = this.toolsMap.get(metadata.name)
    if (existing?.metadata?.telemetry && metadata.telemetry.totalInvocations === 0) {
      metadata.telemetry = { ...existing.metadata.telemetry }
    }

    this.turnTracker.initTool(metadata.name, metadata.telemetry)

    this.toolsMap.set(metadata.name, {
      metadata,
      executable: undefined,
    })
    const rawExecutable = await this.loadExecutable(metadata.name, metadata.entrypoint)
    const executable = this.wrapExecutable(metadata.name, rawExecutable)

    // Sync parameters into metadata if not populated
    if (executable && typeof executable === "object") {
      const execObj = executable as any
      if ((!metadata.parameters || Object.keys(metadata.parameters).length === 0) && execObj.args) {
        metadata.parameters = Object.keys(execObj.args).reduce((acc: any, k: string) => {
          acc[k] = execObj.args[k]?.description || "parameter"
          return acc
        }, {})
      }
    }

    this.toolsMap.set(metadata.name, {
      metadata,
      executable,
    })
    await this.saveRegistry()

    // Clean up older version files for this tool
    await this.cleanupOlderVersions(metadata.name, metadata.entrypoint)

    return executable
  }

  public async cleanupOlderVersions(toolName: string, activeEntrypoint?: string): Promise<void> {
    await cleanupOlderVersions(this.toolsDir, toolName, activeEntrypoint)
  }

  public async unregisterTool(
    toolName: string,
    options?: { removeFiles?: boolean }
  ): Promise<boolean> {
    const entry = this.toolsMap.get(toolName)
    if (!entry) return false

    // 1. Evict from memory and turn tracker
    this.toolsMap.delete(toolName)
    this.turnTracker.deleteTool(toolName)

    // 2. Save registry (evicts from registry.json)
    await this.saveRegistry()

    // 3. Clean up files on disk if requested
    if (options?.removeFiles !== false) {
      await removeToolFiles(this.toolsDir, entry.metadata)
    }

    return true
  }

  public async reloadTools(forceFreshVersion = true): Promise<void> {
    try {
      const data = await fs.readFile(this.registryFilePath, "utf-8")
      const list: ToolPackageMetadata[] = JSON.parse(data)
      const diskToolNames = new Set(list.map((m) => m.name))

      // 1. Reconcile: Purge tools from memory that no longer exist in registry.json
      for (const existingName of Array.from(this.toolsMap.keys())) {
        if (!diskToolNames.has(existingName)) {
          this.toolsMap.delete(existingName)
          this.turnTracker.deleteTool(existingName)
        }
      }

      // 2. Load and refresh each tool in registry.json
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

        this.turnTracker.initTool(meta.name, meta.telemetry)

        let executable: unknown = undefined
        if (meta.status === "ACTIVE") {
          if (forceFreshVersion) {
            const canonicalPath = path.join(this.toolsDir, "src", `${meta.name}.ts`)
            try {
              const srcContent = await fs.readFile(canonicalPath, "utf-8")
              const newVersionFileName = `${meta.name}.v${Date.now()}.ts`
              const newVersionPath = path.join(this.toolsDir, "src", newVersionFileName)
              await fs.writeFile(newVersionPath, srcContent, "utf-8")
              meta.entrypoint = `src/${newVersionFileName}`
              meta.updatedAt = new Date().toISOString()
              dirty = true
              await this.cleanupOlderVersions(meta.name, meta.entrypoint)
            } catch {
              // Canonical file missing, continue with existing entrypoint
            }
          }

          const rawExecutable = await this.loadExecutable(meta.name, meta.entrypoint)
          if (rawExecutable) {
            executable = this.wrapExecutable(meta.name, rawExecutable)
          }

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
      await this.saveRegistry()
    }
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
      throw new Error(
        `Live tool '${toolName}' is not registered. Available tools: ${Array.from(this.toolsMap.keys()).join(", ") || "none"}`
      )
    }
    if (entry.metadata.status !== "ACTIVE" || !entry.executable) {
      throw new Error(
        `Live tool '${toolName}' is currently ${entry.metadata.status} and cannot be executed.`
      )
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
          description: formatDescriptionWithStats(
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

    this.turnTracker.recordExecution(toolName, success, durationMs, entry.metadata)
    await this.evaluateHealth(toolName)
    await this.saveRegistry()
  }

  public async recordTurn(): Promise<void> {
    const dirty = this.turnTracker.recordTurn(this.toolsMap)
    if (dirty) {
      await this.saveRegistry()
    }
  }

  public async evaluateHealth(toolName: string): Promise<ToolLifecycleStatus> {
    const entry = this.toolsMap.get(toolName)
    if (!entry) return "ARCHIVED"

    const result = this.turnTracker.evaluateHealth(toolName, entry.metadata)
    if (result.dirty) {
      await this.saveRegistry()
    }
    return result.status
  }

  public getRecentExecutions(toolName: string): boolean[] {
    return this.turnTracker.getRecentExecutions(toolName)
  }

  public getUnusedTurns(toolName: string): number {
    return this.turnTracker.getUnusedTurns(toolName, this.toolsMap.get(toolName)?.metadata)
  }

  private async saveRegistry(): Promise<void> {
    const list = Array.from(this.toolsMap.values()).map((v) => v.metadata)
    await fs.mkdir(path.dirname(this.registryFilePath), { recursive: true })
    await fs.writeFile(this.registryFilePath, JSON.stringify(list, null, 2), "utf-8")
  }
}
