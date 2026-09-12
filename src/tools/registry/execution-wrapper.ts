/**
 * Tool Execution Wrapper & Result Normalization
 * Intercepts tool executions, measures execution latency, handles permission gating,
 * attaches telemetry metadata, and normalizes outputs for the OpenCode ecosystem.
 */

import type { ToolPackageMetadata, ToolTelemetry } from "../../../specs/contracts/live-tools.js"

export const WRAPPED_MARKER = Symbol.for("project_dna.wrapped_executable")
export const UNWRAPPED_EXECUTE = Symbol.for("project_dna.unwrapped_execute")
export const REGISTRY_INSTANCE = Symbol.for("project_dna.registry_instance")

export interface ExecutionWrapperContext {
  registry: unknown
  getMetadata: (toolName: string) => ToolPackageMetadata | undefined
  recordExecution: (toolName: string, success: boolean, durationMs: number) => Promise<void>
}

/**
 * Formats a base description with live execution statistics without altering the core description.
 */
export function formatDescriptionWithStats(
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

/**
 * Normalizes raw tool execution output into standard OpenCode ToolResult format.
 */
export function normalizeToolResult(
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

/**
 * Wraps a tool executable (object or function) to intercept execution, gate permissions,
 * measure duration, record telemetry, and normalize results.
 */
export function wrapExecutable(
  toolName: string,
  executable: unknown,
  ctxHost: ExecutionWrapperContext
): unknown {
  if (!executable) return executable

  const execObj = executable as any

  // Prevent double-wrapping on the exact same LiveToolRegistry instance
  if (execObj[REGISTRY_INSTANCE] === ctxHost.registry) {
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
    const meta = ctxHost.getMetadata(toolName)
    if (meta && meta.description) {
      execObj.description = meta.description
    }

    // 3. Extract the underlying original execute function
    const originalExecute =
      execObj[UNWRAPPED_EXECUTE] ??
      (typeof execObj.execute === "function" ? execObj.execute.bind(execObj) : undefined)

    if (originalExecute) {
      execObj[UNWRAPPED_EXECUTE] = originalExecute

      const wrappedExecute = async (args: any, ctx: any) => {
        // Permission Gating Hook
        const currentMeta = ctxHost.getMetadata(toolName)
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
          const normalized = normalizeToolResult(toolName, raw)
          const durationMs = Date.now() - startTime
          await ctxHost.recordExecution(toolName, true, durationMs).catch(() => {})
          const tele = ctxHost.getMetadata(toolName)?.telemetry
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
          await ctxHost.recordExecution(toolName, false, durationMs).catch(() => {})
          throw err
        }
      }

      const proto = Object.getPrototypeOf(execObj)
      const wrappedObj = Object.assign(Object.create(proto), execObj, {
        execute: wrappedExecute,
      })
      wrappedObj[UNWRAPPED_EXECUTE] = originalExecute
      wrappedObj[REGISTRY_INSTANCE] = ctxHost.registry
      wrappedObj[WRAPPED_MARKER] = true

      // Also update execObj so that any direct access or fallback points to the active registry execution
      execObj.execute = wrappedExecute
      execObj[REGISTRY_INSTANCE] = ctxHost.registry
      execObj[WRAPPED_MARKER] = true

      return wrappedObj
    }

    return execObj
  } else if (typeof execObj === "function") {
    const originalFn = execObj[UNWRAPPED_EXECUTE] ?? execObj
    execObj[UNWRAPPED_EXECUTE] = originalFn

    const wrappedFn = async (args: any, ctx: any) => {
      // Permission Gating Hook
      const currentMeta = ctxHost.getMetadata(toolName)
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
        const normalized = normalizeToolResult(toolName, raw)
        const durationMs = Date.now() - startTime
        await ctxHost.recordExecution(toolName, true, durationMs).catch(() => {})
        return normalized
      } catch (err) {
        const durationMs = Date.now() - startTime
        await ctxHost.recordExecution(toolName, false, durationMs).catch(() => {})
        throw err
      }
    }
    ;(wrappedFn as any)[UNWRAPPED_EXECUTE] = originalFn
    ;(wrappedFn as any)[REGISTRY_INSTANCE] = ctxHost.registry
    ;(wrappedFn as any)[WRAPPED_MARKER] = true
    return wrappedFn
  }

  return executable
}
