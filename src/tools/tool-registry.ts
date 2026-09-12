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

const WRAPPED_MARKER = Symbol.for("project_dna.wrapped_executable")
const UNWRAPPED_EXECUTE = Symbol.for("project_dna.unwrapped_execute")
const REGISTRY_INSTANCE = Symbol.for("project_dna.registry_instance")

export class LiveToolRegistry implements ILiveToolRegistry {
  private registryFilePath: string
  private toolsMap: Map<string, { metadata: ToolPackageMetadata; executable?: unknown }> =
    new Map()
  private recentExecutionsMap: Map<string, boolean[]> = new Map()
  private unusedTurnsMap: Map<string, number> = new Map()
  private toolsExecutedInCurrentTurn: Set<string> = new Set()

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

    // Prevent double-wrapping on the exact same LiveToolRegistry instance
    if (execObj[REGISTRY_INSTANCE] === this) {
      return execObj
    }

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

      // 3. Extract the underlying original execute function
      const originalExecute =
        execObj[UNWRAPPED_EXECUTE] ??
        (typeof execObj.execute === "function" ? execObj.execute.bind(execObj) : undefined)

      if (originalExecute) {
        execObj[UNWRAPPED_EXECUTE] = originalExecute

        const self = this
        const wrappedExecute = async (args: any, ctx: any) => {
          // Permission Gating Hook
          const currentMeta = self.toolsMap.get(toolName)?.metadata
          if (currentMeta?.requiredPermissions && currentMeta.requiredPermissions.length > 0) {
            if (ctx && typeof ctx.ask === "function") {
              for (const perm of currentMeta.requiredPermissions) {
                await ctx.ask({
                  permission: `tool:${perm}`,
                  patterns: [toolName],
                  always: [`trust-tool-${toolName}`],
                  metadata: {
                    reason: `LiveTool '${toolName}' requested capability '${perm}'.`,
                  },
                })
              }
            }
          }

          const startTime = Date.now()
          let raw: unknown
          try {
            raw = await originalExecute(args, ctx)
            const normalized = LiveToolRegistry.normalizeToolResult(toolName, raw)
            const durationMs = Date.now() - startTime
            await self.recordExecution(toolName, true, durationMs).catch(() => {})
            const tele = self.toolsMap.get(toolName)?.metadata?.telemetry
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
              const runInfo = `[Run #${tele.totalInvocations} | ${Math.round(tele.healthScore * 100)}% health | ${durationMs}ms]`
              if (normalized.title) {
                if (!normalized.title.includes("Run #")) {
                  normalized.title = `${normalized.title} ${runInfo}`
                }
              } else {
                normalized.title = `${toolName} ${runInfo}`
              }
            }
            return normalized
          } catch (err) {
            const durationMs = Date.now() - startTime
            await self.recordExecution(toolName, false, durationMs).catch(() => {})
            throw err
          }
        }

        const proto = Object.getPrototypeOf(execObj)
        const wrappedObj = Object.assign(Object.create(proto), execObj, {
          execute: wrappedExecute,
        })
        wrappedObj[UNWRAPPED_EXECUTE] = originalExecute
        wrappedObj[REGISTRY_INSTANCE] = self
        wrappedObj[WRAPPED_MARKER] = true

        // Also update execObj so that any direct access or fallback points to the active registry execution
        execObj.execute = wrappedExecute
        execObj[REGISTRY_INSTANCE] = self
        execObj[WRAPPED_MARKER] = true

        return wrappedObj
      }

      return execObj
    } else if (typeof execObj === "function") {
      const originalFn = execObj[UNWRAPPED_EXECUTE] ?? execObj
      execObj[UNWRAPPED_EXECUTE] = originalFn

      const self = this
      const wrappedFn = async (args: any, ctx: any) => {
        // Permission Gating Hook
        const currentMeta = self.toolsMap.get(toolName)?.metadata
        if (currentMeta?.requiredPermissions && currentMeta.requiredPermissions.length > 0) {
          if (ctx && typeof ctx.ask === "function") {
            for (const perm of currentMeta.requiredPermissions) {
              await ctx.ask({
                permission: `tool:${perm}`,
                patterns: [toolName],
                always: [`trust-tool-${toolName}`],
                metadata: {
                  reason: `LiveTool '${toolName}' requested capability '${perm}'.`,
                },
              })
            }
          }
        }

        const startTime = Date.now()
        try {
          const raw = await originalFn(args, ctx)
          const normalized = LiveToolRegistry.normalizeToolResult(toolName, raw)
          const durationMs = Date.now() - startTime
          await self.recordExecution(toolName, true, durationMs).catch(() => {})
          return normalized
        } catch (err) {
          const durationMs = Date.now() - startTime
          await self.recordExecution(toolName, false, durationMs).catch(() => {})
          throw err
        }
      }
      ;(wrappedFn as any)[UNWRAPPED_EXECUTE] = originalFn
      ;(wrappedFn as any)[REGISTRY_INSTANCE] = self
      ;(wrappedFn as any)[WRAPPED_MARKER] = true
      return wrappedFn
    }

    return executable
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
      // If the tool returned a raw structured object, serialize to pretty-printed JSON
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
    const teleRecent = (metadata.telemetry as any)?.recentExecutions
    if (Array.isArray(teleRecent)) {
      this.recentExecutionsMap.set(metadata.name, teleRecent.slice(-5))
    } else if (!this.recentExecutionsMap.has(metadata.name)) {
      this.recentExecutionsMap.set(metadata.name, [])
    }

    const teleUnused = (metadata.telemetry as any)?.unusedTurns
    if (typeof teleUnused === "number") {
      this.unusedTurnsMap.set(metadata.name, Math.max(0, teleUnused))
    } else if (!this.unusedTurnsMap.has(metadata.name)) {
      this.unusedTurnsMap.set(metadata.name, 0)
    }

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

    const teleRecent = (metadata.telemetry as any)?.recentExecutions
    if (Array.isArray(teleRecent)) {
      this.recentExecutionsMap.set(metadata.name, teleRecent.slice(-5))
    } else if (!this.recentExecutionsMap.has(metadata.name)) {
      this.recentExecutionsMap.set(metadata.name, [])
    }

    const teleUnused = (metadata.telemetry as any)?.unusedTurns
    if (typeof teleUnused === "number") {
      this.unusedTurnsMap.set(metadata.name, Math.max(0, teleUnused))
    } else if (!this.unusedTurnsMap.has(metadata.name)) {
      this.unusedTurnsMap.set(metadata.name, 0)
    }

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
    try {
      const srcDir = path.join(this.toolsDir, "src")
      const files = await fs.readdir(srcDir)
      const activeBase = activeEntrypoint ? path.basename(activeEntrypoint) : ""
      const canonicalBase = `${toolName}.ts`
      const versionedRegex = new RegExp(`^${toolName}\\.v\\d+\\.ts$`)

      for (const file of files) {
        if (versionedRegex.test(file) && file !== activeBase && file !== canonicalBase) {
          await fs.unlink(path.join(srcDir, file)).catch(() => {})
        }
      }
    } catch {
      // Ignore directory read/unlink errors
    }
  }

  public async unregisterTool(
    toolName: string,
    options?: { removeFiles?: boolean }
  ): Promise<boolean> {
    const entry = this.toolsMap.get(toolName)
    if (!entry) return false

    // 1. Evict from memory
    this.toolsMap.delete(toolName)
    this.recentExecutionsMap.delete(toolName)
    this.unusedTurnsMap.delete(toolName)
    this.toolsExecutedInCurrentTurn.delete(toolName)

    // 2. Save registry (evicts from registry.json)
    await this.saveRegistry()

    // 3. Clean up files on disk if requested
    if (options?.removeFiles !== false) {
      const meta = entry.metadata
      if (meta.entrypoint) {
        const absEntry = path.isAbsolute(meta.entrypoint)
          ? meta.entrypoint
          : path.join(this.toolsDir, meta.entrypoint)
        await fs.unlink(absEntry).catch(() => {})
      }
      if (meta.sourceFile) {
        const absSrc = path.isAbsolute(meta.sourceFile)
          ? meta.sourceFile
          : path.join(this.toolsDir, meta.sourceFile)
        await fs.unlink(absSrc).catch(() => {})
      }
      if (meta.testFile) {
        const absTest = path.isAbsolute(meta.testFile)
          ? meta.testFile
          : path.join(this.toolsDir, meta.testFile)
        await fs.unlink(absTest).catch(() => {})
      }

      // Also clean up any lingering versioned files or canonical files matching toolName
      try {
        const srcDir = path.join(this.toolsDir, "src")
        const files = await fs.readdir(srcDir)
        const pattern = new RegExp(`^${toolName}(\\.v.*)?\\.(ts|js)$`)
        for (const file of files) {
          if (pattern.test(file)) {
            await fs.unlink(path.join(srcDir, file)).catch(() => {})
          }
        }
      } catch {}

      try {
        const testDir = path.join(this.toolsDir, "tests")
        const files = await fs.readdir(testDir)
        const pattern = new RegExp(`^${toolName}(\\.test)?\\.(ts|js)$`)
        for (const file of files) {
          if (pattern.test(file)) {
            await fs.unlink(path.join(testDir, file)).catch(() => {})
          }
        }
      } catch {}
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
          this.recentExecutionsMap.delete(existingName)
          this.unusedTurnsMap.delete(existingName)
          this.toolsExecutedInCurrentTurn.delete(existingName)
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

        const teleRecent = (meta.telemetry as any)?.recentExecutions
        if (Array.isArray(teleRecent)) {
          this.recentExecutionsMap.set(meta.name, teleRecent.slice(-5))
        } else if (!this.recentExecutionsMap.has(meta.name)) {
          this.recentExecutionsMap.set(meta.name, [])
        }

        const teleUnused = (meta.telemetry as any)?.unusedTurns
        if (typeof teleUnused === "number") {
          this.unusedTurnsMap.set(meta.name, Math.max(0, teleUnused))
        } else if (!this.unusedTurnsMap.has(meta.name)) {
          this.unusedTurnsMap.set(meta.name, 0)
        }

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
    entry.metadata.updatedAt = new Date().toISOString()

    // Reset unused turn counter and mark executed in current turn
    this.toolsExecutedInCurrentTurn.add(toolName)
    this.unusedTurnsMap.set(toolName, 0)
    tele.unusedTurns = 0

    await this.evaluateHealth(toolName)
    await this.saveRegistry()
  }

  /**
   * Records the completion of an agent turn.
   * Increments unused turn counter for all registered tools not executed in that turn.
   * If a tool has status DEGRADED and has not been executed for 100 turns, transitions to ARCHIVED.
   */
  public async recordTurn(): Promise<void> {
    let dirty = false
    for (const [toolName, entry] of this.toolsMap) {
      const executed = this.toolsExecutedInCurrentTurn.has(toolName)
      let unusedTurns = this.unusedTurnsMap.get(toolName) ?? entry.metadata.telemetry?.unusedTurns ?? 0

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

    if (dirty) {
      await this.saveRegistry()
    }
  }

  public async evaluateHealth(toolName: string): Promise<ToolLifecycleStatus> {
    const entry = this.toolsMap.get(toolName)
    if (!entry) return "ARCHIVED"

    const tele = entry.metadata.telemetry
    const unusedTurns = this.unusedTurnsMap.get(toolName) ?? tele?.unusedTurns ?? 0
    const prevStatus = entry.metadata.status

    if (entry.metadata.status === "ARCHIVED") {
      return "ARCHIVED"
    }

    if (tele.totalInvocations >= 5 && tele.healthScore < 0.6) {
      if (unusedTurns >= 100) {
        entry.metadata.status = "ARCHIVED"
      } else {
        entry.metadata.status = "DEGRADED"
      }
    } else if (entry.metadata.status === "DEGRADED") {
      if (unusedTurns >= 100) {
        entry.metadata.status = "ARCHIVED"
      } else if (tele.healthScore >= 0.6) {
        entry.metadata.status = "ACTIVE"
      }
    }

    if (entry.metadata.status !== prevStatus) {
      entry.metadata.updatedAt = new Date().toISOString()
      await this.saveRegistry()
    }

    return entry.metadata.status
  }

  public getRecentExecutions(toolName: string): boolean[] {
    return [...(this.recentExecutionsMap.get(toolName) ?? [])]
  }

  public getUnusedTurns(toolName: string): number {
    return this.unusedTurnsMap.get(toolName) ?? (this.toolsMap.get(toolName)?.metadata.telemetry as any)?.unusedTurns ?? 0
  }

  private async saveRegistry(): Promise<void> {
    const list = Array.from(this.toolsMap.values()).map((v) => v.metadata)
    await fs.mkdir(path.dirname(this.registryFilePath), { recursive: true })
    await fs.writeFile(this.registryFilePath, JSON.stringify(list, null, 2), "utf-8")
  }
}
