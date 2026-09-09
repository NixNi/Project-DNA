/**
 * LiveMemory Interface Contracts
 * Implements A-Mem (Agentic Memory) & Zettelkasten Knowledge Systems for OpenCode
 */

export type MemoryCategory =
  | "ARCH_DECISION"
  | "CODEBASE_CONVENTION"
  | "ERROR_DIAGNOSTIC"
  | "DOMAIN_LOGIC"
  | "USER_PREFERENCE"

export type LinkRelation =
  | "CAUSED_BY"
  | "SUPERSEDES"
  | "RELATES_TO"
  | "REFINES"
  | "CONTRADICTS"

export interface MemoryLink {
  targetCardId: string
  relation: LinkRelation
  strength: number // 0.0 to 1.0
  rationale: string
}

export interface MemoryCard {
  id: string
  title: string
  category: MemoryCategory
  insight: string
  context: string
  evidence?: string
  tags: string[]
  accessCount: number
  links: MemoryLink[]
  sessionID?: string
  createdAt: string
  updatedAt: string
}

export interface DiagnosticTrace {
  id: string
  sessionID: string
  errorSignature: string
  command?: string
  toolName?: string
  rawError: string
  recoveryAction?: string
  resolved: boolean
  timestamp: string
}

export interface NoteCandidate {
  title: string
  category: MemoryCategory
  insight: string
  context: string
  evidence?: string
  tags: string[]
}

/**
 * Interface for the Dynamic Link Generator (A-Mem)
 */
export interface IDynamicLinkGenerator {
  /**
   * Evaluates a new note against candidate notes to establish semantic & causal links
   */
  generateLinks(
    newCard: MemoryCard,
    candidates: MemoryCard[]
  ): Promise<MemoryLink[]>
}

/**
 * Interface for the Zettelkasten Knowledge Graph Store
 */
export interface ILiveMemoryStore {
  /**
   * Initializes SQLite database and indexes
   */
  init(workspacePath: string): Promise<void>

  /**
   * Creates an atomic memory card and triggers dynamic link generation
   */
  createCard(note: NoteCandidate, sessionID?: string): Promise<MemoryCard>

  /**
   * Fetches a memory card by its ID
   */
  getCard(id: string): Promise<MemoryCard | null>

  /**
   * Queries cards by semantic similarity, tags, and graph walk
   */
  queryRelevant(query: string, limit?: number): Promise<MemoryCard[]>

  /**
   * Retrieves all notes formulated during a specific session
   */
  getNotesForSession(sessionID: string): Promise<MemoryCard[]>

  /**
   * Traverses links from a given card ID up to a specific depth
   */
  traverseLinks(cardId: string, depth?: number): Promise<MemoryCard[]>

  /**
   * Exports full knowledge graph to Open Memory JSON format
   */
  exportOpenMemory(): Promise<string>
}

/**
 * Interface for the Diagnostic Failure Bank
 */
export interface IDiagnosticBank {
  /**
   * Records an intercepted failure from tool execution or shell command
   */
  recordFailure(trace: {
    sessionID: string
    errorSignature?: string
    command?: string
    toolName?: string
    rawError: string
    recoveryAction?: string
    resolved?: boolean
  }): Promise<void>

  /**
   * Marks an error trace as resolved and pairs it with the successful recovery action
   */
  recordRecovery(sessionID: string, recoveryAction: string): Promise<void>

  /**
   * Retrieves active diagnostics to avoid repeating known failure modes
   */
  getActiveDiagnostics(sessionID: string): Promise<DiagnosticTrace[]>

  /**
   * Distills recurring error patterns into permanent Zettelkasten notes
   */
  distillToMemory(memoryStore: ILiveMemoryStore): Promise<void>
}
