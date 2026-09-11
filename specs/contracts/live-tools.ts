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

export interface ToolTelemetry {
  totalInvocations: number
  successCount: number
  failureCount: number
  avgDurationMs: number
  healthScore: number
  lastExecutedAt?: string
}

export interface ToolPackageMetadata {
  id: string
  name: string
  version: string
  description: string
  entrypoint: string
  testFile?: string
  status: ToolLifecycleStatus
  parameters: Record<string, unknown>
  telemetry: ToolTelemetry
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
}

export interface ToolVerificationReport {
  toolName: string
  passed: boolean
  testsRun: number
  testsFailed: number
  durationMs: number
  errorOutput?: string
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
  validateAST(sourceCode: string): Promise<{ valid: boolean; violations: string[] }>

  /**
   * Executes synthetic unit tests in an isolated sandbox
   */
  verifyInSandbox(toolName: string, testCode: string): Promise<ToolVerificationReport>

  /**
   * Attempts self-repair on a tool that failed test execution
   */
  repair(toolName: string, errorOutput: string): Promise<ToolSynthesisResult>
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
  registerTool(metadata: ToolPackageMetadata, executableModule: unknown): Promise<void>

  /**
   * Returns dictionary of tools compatible with OpenCode's `tool` hook
   */
  getToolMap(): Record<string, unknown>

  /**
   * Records execution telemetry to compute health score
   */
  recordExecution(toolName: string, success: boolean, durationMs: number): Promise<void>

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

