/**
 * LiveTools Interface Contracts
 * Implements the LATM (LLMs as Tool Makers) Paradigm for OpenCode
 */

import type { z } from "zod"

export type ToolLifecycleStatus =
  | "PROPOSED"
  | "GENERATING"
  | "VALIDATING_AST"
  | "TESTING"
  | "ACTIVE"
  | "DEGRADED"
  | "ARCHIVED"

/**
 * Developer capabilities requiring OpenCode permission gating
 */
export type ToolPermission =
  | "shell_execution"
  | "network_access"
  | "filesystem_write"
  | "raw_socket_access"

export interface ASTDiagnostic {
  rule: string
  severity: "error" | "warning" | "info"
  message: string
  line?: number
  column?: number
  permission?: ToolPermission
}

export interface ASTValidationReport {
  valid: boolean
  violations: string[]
  detectedCapabilities: ToolPermission[]
  requiredPermissions: ToolPermission[]
  diagnostics?: ASTDiagnostic[]
}

export type ASTValidationResult = ASTValidationReport

export interface ToolTelemetry {
  totalInvocations: number
  successCount: number
  failureCount: number
  avgDurationMs: number
  healthScore: number
  lastExecutedAt?: string
  recentExecutions?: boolean[]
  unusedTurns?: number
}

export interface ToolPackageMetadata {
  id: string
  name: string
  version: string
  description: string
  entrypoint: string
  sourceFile?: string
  testFile?: string
  status: ToolLifecycleStatus
  parameters: Record<string, unknown>
  telemetry: ToolTelemetry
  requiredPermissions?: ToolPermission[]
  createdAt: string
  updatedAt: string
}

export interface ToolSynthesisRequest {
  toolName: string
  intent: string
  sampleInputs?: Record<string, unknown>[]
  expectedOutputs?: unknown[]
  sourceCode?: string
  testCode?: string
  requiredDependencies?: string[]
}

export interface DirectToolRegistrationRequest {
  toolName: string
  description: string
  sourceCode: string
  testCode?: string
  sampleInputs?: Record<string, unknown>[]
  expectedOutputs?: unknown[]
}

export interface ToolSynthesisResult {
  toolName: string
  sourceCode: string
  testCode: string
  zodSchemaDefinition: string
  entrypoint?: string
  sourceFile?: string
  requiredPermissions?: ToolPermission[]
  attempts?: number
  status?: ToolLifecycleStatus | string
  transitions?: string[]
}

export interface ToolVerificationReport {
  toolName: string
  passed: boolean
  testsRun: number
  testsFailed: number
  durationMs: number
  errorOutput?: string
  stdout?: string
  stderr?: string
}

/**
 * Interface for the Tool Maker Subsystem
 */
export interface ILiveToolMaker {
  /**
   * Synthesizes tool source and unit test suite
   */
  synthesize(request: ToolSynthesisRequest): Promise<ToolSynthesisResult>

  /**
   * Directly registers a model-authored tool implementation without background LLM delegation
   */
  registerDirect(request: DirectToolRegistrationRequest): Promise<ToolSynthesisResult>

  /**
   * Performs static AST security analysis on generated code
   */
  validateAST(
    sourceCode: string,
    options?: { strict?: boolean }
  ): Promise<ASTValidationReport>

  /**
   * Executes synthetic unit tests in an isolated sandbox
   */
  verifyInSandbox(toolName: string, testCode: string): Promise<ToolVerificationReport>

  /**
   * Attempts self-repair on a tool that failed test execution
   */
  repair(
    toolName: string,
    errorOutput: string,
    stdout?: string,
    stderr?: string
  ): Promise<ToolSynthesisResult>
}

/**
 * Interface for the LiveTool Registry
 */
export interface ILiveToolRegistry {
  /**
   * Loads all verified tools from .opencode/dna/tools/
   */
  loadActiveTools(): Promise<void>

  /**
   * Hot-loads and registers a new tool in the active runtime
   */
  registerTool(metadata: ToolPackageMetadata, executableModule?: unknown): Promise<void>

  /**
   * Registers metadata and dynamically imports the executable module into memory
   */
  registerAndLoad(metadata: ToolPackageMetadata): Promise<unknown>

  /**
   * Unregisters and evicts a tool from the registry, disk, and in-memory state
   */
  unregisterTool(
    toolName: string,
    options?: { removeFiles?: boolean }
  ): Promise<boolean>

  /**
   * Reloads all active tools from disk/registry.json and refreshes executable imports
   */
  reloadTools(forceFreshVersion?: boolean): Promise<void>

  /**
   * Cleans up superseded versioned entrypoint files for a tool
   */
  cleanupOlderVersions?(toolName: string, activeEntrypoint?: string): Promise<void>

  /**
   * Returns dictionary of tools compatible with OpenCode's `tool` hook
   */
  getToolMap(): Record<string, unknown>

  /**
   * Records execution telemetry to compute health score
   */
  recordExecution(toolName: string, success: boolean, durationMs: number): Promise<void>

  /**
   * Records the completion of an agent turn, updating unused turns and archival state
   */
  recordTurn(): Promise<void>

  /**
   * Directly invokes a registered live tool by name
   */
  invokeTool?(toolName: string, args: Record<string, unknown>, context?: unknown): Promise<unknown>

  /**
   * Returns list of registered tool summaries
   */
  listTools?(): Array<{
    name: string
    description: string
    parameters?: Record<string, unknown>
    status: ToolLifecycleStatus
    totalInvocations: number
    healthScore: number
  }>

  /**
   * Checks if a tool should be flagged as degraded or archived
   */
  evaluateHealth(toolName: string): Promise<ToolLifecycleStatus>
}

