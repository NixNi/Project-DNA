/**
 * LiveSkills Interface Contracts
 * Implements Dynamic Procedural Knowledge Lifecycle for OpenCode
 */

export type SkillLifecycleStatus =
  | "HARVESTED"
  | "DISTILLING"
  | "STAGED"
  | "VERIFYING"
  | "ACTIVE"
  | "DEGRADED"
  | "ARCHIVED"

export interface SkillTelemetry {
  executionCount: number
  successCount: number
  failureCount: number
  lastAppliedAt?: string
}

export interface SkillPackageMetadata {
  id: string
  name: string
  version: string
  description: string
  triggers: string[]
  tags: string[]
  author: string
  confidenceScore: number
  lifecycleStatus: SkillLifecycleStatus
  scripts?: string[]
  references?: string[]
  telemetry: SkillTelemetry
  createdAt: string
  updatedAt: string
}

export interface ExecutionTraceStep {
  tool: string
  args: Record<string, unknown>
  output: string
  exitCode?: number
  timestamp: string
}

export interface SessionTraceBuffer {
  sessionID: string
  userGoal: string
  steps: ExecutionTraceStep[]
  finalResolution: "SUCCESS" | "FAILED" | "IN_PROGRESS"
}

export interface DistilledSkillResult {
  metadata: SkillPackageMetadata
  skillMarkdownContent: string
  helperScripts?: Record<string, string> // filename -> script content
  referenceDocs?: Record<string, string> // filename -> doc content
}

export interface SkillMatchResult {
  skill: SkillPackageMetadata
  relevanceScore: number
  matchedTrigger: string
  injectedGuideline: string
}

/**
 * Interface for the Trace Harvester
 */
export interface ILiveSkillHarvester {
  /**
   * Buffers an execution step from OpenCode hooks
   */
  recordStep(sessionID: string, step: ExecutionTraceStep): void

  /**
   * Updates output and status of the latest matching step
   */
  updateStepOutput?(sessionID: string, toolName: string, output: string, exitCode?: number): void

  /**
   * Sets or enriches the user's high-level intent for the session
   */
  setUserGoal?(sessionID: string, goal: string): void

  /**
   * Sets explicit session resolution
   */
  setResolution?(sessionID: string, resolution: "SUCCESS" | "FAILED"): void

  /**
   * Evaluates if a session trace satisfies the criteria for distillation
   */
  isEligibleForHarvest(sessionID: string): boolean


  /**
   * Retrieves full trace buffer for distillation
   */
  getTrace(sessionID: string): SessionTraceBuffer | null

  /**
   * Clears trace buffer after distillation or session completion
   */
  clearTrace(sessionID: string): void
}

/**
 * Interface for the Skill Distiller
 */
export interface ILiveSkillDistiller {
  /**
   * Distills a raw trace buffer into a structured, parameterized SKILL.md package
   */
  distill(trace: SessionTraceBuffer): Promise<DistilledSkillResult>

  /**
   * Adversarially simulates edge cases against the newly distilled skill
   */
  adversarialVerify(skill: DistilledSkillResult): Promise<{ passed: boolean; score: number; feedback: string }>

  /**
   * Merges an updated trace into an existing skill to avoid duplication
   */
  mergeIntoExisting(existingId: string, trace: SessionTraceBuffer): Promise<DistilledSkillResult>
}

/**
 * Interface for the LiveSkills Store & Manager
 */
export interface ILiveSkillStore {
  /**
   * Loads all active skills from .opencode/dna/skills/active/
   */
  loadActiveSkills(): Promise<void>

  /**
   * Retrieves relevant skills matching a user's prompt or error context
   */
  matchSkills(prompt: string): Promise<SkillMatchResult[]>

  /**
   * Saves a newly verified skill into active storage
   */
  saveSkill(distilled: DistilledSkillResult): Promise<void>

  /**
   * Adjusts confidence score based on session outcomes
   */
  recordOutcome(skillId: string, success: boolean): Promise<void>

  /**
   * Scans library and archives underperforming or superseded skills
   */
  pruneLibrary(): Promise<{ archived: string[]; retained: string[] }>
}
