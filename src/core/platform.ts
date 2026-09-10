/**
 * Cross-Platform Utilities for Project DNA
 * Ensures unified operation across macOS, Linux, and Windows (win32).
 */

import * as syncFs from "node:fs"
import * as path from "node:path"
import type { ChildProcess } from "node:child_process"

export class Platform {
  public static isWindows(): boolean {
    return process.platform === "win32"
  }

  public static isMac(): boolean {
    return process.platform === "darwin"
  }

  public static isLinux(): boolean {
    return process.platform === "linux"
  }

  /**
   * Retrieves the PATH environment variable value regardless of case (PATH, Path, path)
   */
  public static getEnvPath(env: NodeJS.ProcessEnv = process.env): string {
    const key = Object.keys(env).find((k) => k.toLowerCase() === "path")
    return (key ? env[key] : undefined) || ""
  }

  /**
   * Sets the PATH environment variable on a target environment object
   */
  public static setEnvPath(
    env: Record<string, string | undefined>,
    newPath: string
  ): void {
    const existingKey = Object.keys(env).find((k) => k.toLowerCase() === "path")
    const key = existingKey || (this.isWindows() ? "Path" : "PATH")
    env[key] = newPath
  }

  /**
   * Returns OS-specific candidate locations for the Bun binary
   */
  public static getCandidateBunPaths(): string[] {
    const candidates: string[] = []

    // 1. If currently executing under Bun, check process.execPath
    if (process.execPath && /bun(\.exe)?$/i.test(process.execPath)) {
      candidates.push(process.execPath)
    }

    // 2. Explicit BUN_INSTALL environment variable
    if (process.env.BUN_INSTALL) {
      candidates.push(
        path.join(
          process.env.BUN_INSTALL,
          "bin",
          this.isWindows() ? "bun.exe" : "bun"
        )
      )
    }

    if (this.isWindows()) {
      // Windows common install locations
      const userProfile = process.env.USERPROFILE || process.env.HOME || ""
      if (userProfile) {
        candidates.push(path.join(userProfile, ".bun", "bin", "bun.exe"))
      }
      const localAppData = process.env.LOCALAPPDATA
      if (localAppData) {
        candidates.push(path.join(localAppData, "Programs", "bun", "bun.exe"))
      }
      const programFiles = process.env.ProgramFiles
      if (programFiles) {
        candidates.push(path.join(programFiles, "bun", "bun.exe"))
      }
      candidates.push("bun.exe")
    } else {
      // POSIX common install locations
      const home = process.env.HOME || ""
      if (home) {
        candidates.push(path.join(home, ".bun", "bin", "bun"))
      }
      if (this.isMac()) {
        candidates.push("/opt/homebrew/bin/bun")
        candidates.push("/usr/local/bin/bun")
      } else if (this.isLinux()) {
        candidates.push("/home/linuxbrew/.linuxbrew/bin/bun")
        candidates.push("/usr/local/bin/bun")
        candidates.push("/usr/bin/bun")
        candidates.push("/snap/bin/bun")
      }
      candidates.push("/usr/local/bin/bun")
      candidates.push("/usr/bin/bun")
    }

    candidates.push("bun")

    return candidates.filter(Boolean)
  }

  /**
   * Returns OS-specific candidate locations for the Node binary.
   * Explicitly avoids using OpenCode executable path.
   */
  public static getCandidateNodePaths(): string[] {
    const candidates: string[] = []

    // Check if process.execPath is actually node (and not opencode)
    if (process.execPath && /node(\.exe)?$/i.test(process.execPath)) {
      candidates.push(process.execPath)
    }

    if (this.isWindows()) {
      const programFiles = process.env.ProgramFiles
      if (programFiles) {
        candidates.push(path.join(programFiles, "nodejs", "node.exe"))
      }
      const programFilesX86 = process.env["ProgramFiles(x86)"]
      if (programFilesX86) {
        candidates.push(path.join(programFilesX86, "nodejs", "node.exe"))
      }
      const localAppData = process.env.LOCALAPPDATA
      if (localAppData) {
        candidates.push(path.join(localAppData, "Programs", "nodejs", "node.exe"))
      }
      candidates.push("node.exe")
    } else {
      if (this.isMac()) {
        candidates.push("/opt/homebrew/bin/node")
      } else if (this.isLinux()) {
        candidates.push("/home/linuxbrew/.linuxbrew/bin/node")
        candidates.push("/snap/bin/node")
      }
      candidates.push("/usr/local/bin/node")
      candidates.push("/usr/bin/node")
    }

    candidates.push("node")

    return candidates.filter(Boolean)
  }

  /**
   * Resolves the first existing binary path from candidates, or returns fallback
   */
  public static resolveBinary(candidates: string[], fallback: string): string {
    for (const candidate of candidates) {
      if (!candidate) continue
      // If it's just a bare command name (e.g. "bun", "bun.exe"), don't check existence via fs
      if (!path.isAbsolute(candidate)) {
        continue
      }
      try {
        if (syncFs.existsSync(candidate)) {
          return candidate
        }
      } catch {
        // Skip inaccessible paths
      }
    }
    return fallback
  }

  /**
   * Returns standard system directories where binaries reside on the current OS
   */
  public static getDefaultSystemPathDirs(): string[] {
    const dirs: string[] = []

    if (this.isWindows()) {
      const systemRoot = process.env.SystemRoot || "C:\\Windows"
      dirs.push(path.join(systemRoot, "System32"))
      dirs.push(systemRoot)
      dirs.push(path.join(systemRoot, "System32", "Wbem"))
      const programFiles = process.env.ProgramFiles
      if (programFiles) {
        dirs.push(path.join(programFiles, "nodejs"))
        dirs.push(path.join(programFiles, "bun"))
      }
      const userProfile = process.env.USERPROFILE || process.env.HOME
      if (userProfile) {
        dirs.push(path.join(userProfile, ".bun", "bin"))
      }
    } else {
      if (this.isMac()) {
        dirs.push("/opt/homebrew/bin")
        dirs.push("/usr/local/bin")
      } else if (this.isLinux()) {
        dirs.push("/home/linuxbrew/.linuxbrew/bin")
        dirs.push("/snap/bin")
      }
      dirs.push("/usr/local/bin")
      dirs.push("/usr/bin")
      dirs.push("/bin")
      dirs.push("/usr/sbin")
      dirs.push("/sbin")
      const home = process.env.HOME
      if (home) {
        dirs.push(path.join(home, ".bun", "bin"))
      }
    }

    return dirs.filter(Boolean)
  }

  /**
   * Builds an enriched environment dictionary with cross-platform PATH delimiter
   */
  public static buildEnrichedEnv(
    baseEnv: NodeJS.ProcessEnv = process.env,
    extraVars: Record<string, string | undefined> = {}
  ): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...baseEnv, ...extraVars }
    const currentPath = this.getEnvPath(env)
    const defaultDirs = this.getDefaultSystemPathDirs()

    const segments = currentPath
      ? currentPath.split(path.delimiter).filter(Boolean)
      : []

    for (const dir of defaultDirs) {
      if (!segments.includes(dir)) {
        segments.push(dir)
      }
    }

    const mergedPath = segments.join(path.delimiter)
    this.setEnvPath(env, mergedPath)

    return env
  }

  /**
   * Cross-platform child process termination
   */
  public static safeKill(child: ChildProcess): void {
    try {
      if (this.isWindows()) {
        child.kill()
      } else {
        child.kill("SIGKILL")
      }
    } catch {
      try {
        child.kill()
      } catch {
        // Process may already have terminated
      }
    }
  }
}
