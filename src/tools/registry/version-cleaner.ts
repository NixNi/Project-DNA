/**
 * Version Cleaner & On-Disk Artifact Purger
 * Cleans up stale versioned source entrypoints and purges on-disk files upon tool unregistration.
 */

import * as fs from "node:fs/promises"
import * as path from "node:path"
import type { ToolPackageMetadata } from "../../../specs/contracts/live-tools.js"

/**
 * Removes older versioned entrypoints for a tool while preserving the active and canonical files.
 */
export async function cleanupOlderVersions(
  toolsDir: string,
  toolName: string,
  activeEntrypoint?: string
): Promise<void> {
  try {
    const srcDir = path.join(toolsDir, "src")
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
    // Ignore directory read or unlink errors
  }
}

/**
 * Purges on-disk tool artifacts (source, test, versioned files) when a tool is unregistered.
 */
export async function removeToolFiles(
  toolsDir: string,
  metadata: ToolPackageMetadata
): Promise<void> {
  const toolName = metadata.name

  if (metadata.entrypoint) {
    const absEntry = path.isAbsolute(metadata.entrypoint)
      ? metadata.entrypoint
      : path.join(toolsDir, metadata.entrypoint)
    await fs.unlink(absEntry).catch(() => {})
  }
  if (metadata.sourceFile) {
    const absSrc = path.isAbsolute(metadata.sourceFile)
      ? metadata.sourceFile
      : path.join(toolsDir, metadata.sourceFile)
    await fs.unlink(absSrc).catch(() => {})
  }
  if (metadata.testFile) {
    const absTest = path.isAbsolute(metadata.testFile)
      ? metadata.testFile
      : path.join(toolsDir, metadata.testFile)
    await fs.unlink(absTest).catch(() => {})
  }

  // Also clean up any lingering versioned files or canonical files matching toolName in src
  try {
    const srcDir = path.join(toolsDir, "src")
    const files = await fs.readdir(srcDir)
    const pattern = new RegExp(`^${toolName}(\\.v.*)?\\.(ts|js)$`)
    for (const file of files) {
      if (pattern.test(file)) {
        await fs.unlink(path.join(srcDir, file)).catch(() => {})
      }
    }
  } catch {}

  // Clean up any test files in tests
  try {
    const testDir = path.join(toolsDir, "tests")
    const files = await fs.readdir(testDir)
    const pattern = new RegExp(`^${toolName}(\\.test)?\\.(ts|js)$`)
    for (const file of files) {
      if (pattern.test(file)) {
        await fs.unlink(path.join(testDir, file)).catch(() => {})
      }
    }
  } catch {}
}
