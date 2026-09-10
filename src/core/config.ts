import * as fs from "node:fs/promises"
import * as path from "node:path"

export interface ProjectDNAConfig {
  enableLiveTools: boolean
  enableLiveSkills: boolean
  enableLiveMemory: boolean
  storageDir: string
  maxInjectedSkills: number
  maxInjectedNotes: number
  autoPruneIntervalHours: number
  healthDecayThreshold: number
  synthesisTimeoutMs: number
}

export const DEFAULT_CONFIG: ProjectDNAConfig = {
  enableLiveTools: true,
  enableLiveSkills: true,
  enableLiveMemory: true,
  storageDir: ".opencode/dna",
  maxInjectedSkills: 2,
  maxInjectedNotes: 4,
  autoPruneIntervalHours: 24,
  healthDecayThreshold: 0.6,
  synthesisTimeoutMs: 120000,
}

export class ConfigManager {
  private config: ProjectDNAConfig
  private workspaceRoot: string

  constructor(workspaceRoot: string, userOptions?: Partial<ProjectDNAConfig>) {
    this.workspaceRoot = workspaceRoot
    this.config = { ...DEFAULT_CONFIG, ...userOptions }
  }

  public get current(): ProjectDNAConfig {
    return this.config
  }

  public get storagePath(): string {
    return path.resolve(this.workspaceRoot, this.config.storageDir)
  }

  public get toolsDir(): string {
    return path.join(this.storagePath, "tools")
  }

  public get toolsSrcDir(): string {
    return path.join(this.toolsDir, "src")
  }

  public get toolsTestsDir(): string {
    return path.join(this.toolsDir, "tests")
  }

  public get skillsDir(): string {
    return path.join(this.storagePath, "skills")
  }

  public get activeSkillsDir(): string {
    return path.join(this.skillsDir, "active")
  }

  public get stagedSkillsDir(): string {
    return path.join(this.skillsDir, "staging")
  }

  public get archivedSkillsDir(): string {
    return path.join(this.skillsDir, "archive")
  }

  public get memoryDir(): string {
    return path.join(this.storagePath, "memory")
  }

  public get memoryDbPath(): string {
    return path.join(this.memoryDir, "graph.db")
  }

  public get diagnosticsDir(): string {
    return path.join(this.memoryDir, "diagnostics")
  }

  public get exportsDir(): string {
    return path.join(this.memoryDir, "exports")
  }

  /**
   * Ensures all required directory trees exist
   */
  public async initializeStorage(): Promise<void> {
    const dirs = [
      this.storagePath,
      this.toolsDir,
      this.toolsSrcDir,
      this.toolsTestsDir,
      this.skillsDir,
      this.activeSkillsDir,
      this.stagedSkillsDir,
      this.archivedSkillsDir,
      this.memoryDir,
      this.diagnosticsDir,
      this.exportsDir,
    ]

    for (const dir of dirs) {
      await fs.mkdir(dir, { recursive: true })
    }

    const configFilePath = path.join(this.storagePath, "config.json")
    try {
      await fs.access(configFilePath)
    } catch {
      await fs.writeFile(configFilePath, JSON.stringify(this.config, null, 2), "utf-8")
    }
  }
}
