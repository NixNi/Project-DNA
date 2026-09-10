/**
 * OpenCode Plugin Entry Point Contract for Project DNA
 * Connects LiveTools, LiveSkills, and LiveMemory to the OpenCode runtime
 */

import type {
  Plugin,
  PluginInput,
  Hooks,
  ToolDefinition,
} from "@opencode-ai/plugin"
import type { Event, OpencodeClient } from "@opencode-ai/sdk"

import type { ILiveToolRegistry, ILiveToolMaker } from "./live-tools.js"
import type { ILiveSkillStore, ILiveSkillHarvester, ILiveSkillDistiller } from "./live-skills.js"
import type { ILiveMemoryStore, IDiagnosticBank } from "./live-memory.js"

/**
 * DNA Plugin Options configurable via opencode.json
 */
export interface ProjectDNAPluginOptions {
  enableLiveTools?: boolean
  enableLiveSkills?: boolean
  enableLiveMemory?: boolean
  storageDir?: string // defaults to .opencode/dna
  maxInjectedSkills?: number // defaults to 2
  maxInjectedNotes?: number // defaults to 4
  autoPruneIntervalHours?: number // defaults to 24
}

/**
 * Internal Context container for Project DNA
 */
export interface ProjectDNAContext {
  input: PluginInput
  options: ProjectDNAPluginOptions
  tools: {
    maker: ILiveToolMaker
    registry: ILiveToolRegistry
  }
  skills: {
    harvester: ILiveSkillHarvester
    distiller: ILiveSkillDistiller
    store: ILiveSkillStore
  }
  memory: {
    store: ILiveMemoryStore
    diagnosticBank: IDiagnosticBank
  }
}

/**
 * Main OpenCode Plugin Export Specification
 *
 * Implements the `@opencode-ai/plugin` interface:
 * `export const ProjectDNAPlugin: Plugin = async (input, options) => Hooks`
 */
export type ProjectDNAPluginFactory = Plugin

/**
 * Options for OpenCode LLM Bridge prompt execution
 */
export interface LLMPromptOptions {
  systemPrompt: string
  userPrompt: string
  useSmallModel?: boolean
  timeoutMs?: number
}

/**
 * OpenCode LLM Reuse Bridge
 * Allows background synthesis to run via `ctx.client.session` without external keys
 */
export interface IOpenCodeLLMBridge {
  prompt(options: LLMPromptOptions): Promise<string>
  promptJson<T = unknown>(options: LLMPromptOptions): Promise<T>
  synthesize(options: LLMPromptOptions): Promise<string>
}
