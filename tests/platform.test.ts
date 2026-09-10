import { describe, it } from "node:test"
import assert from "node:assert"
import * as path from "node:path"
import { Platform } from "../src/core/platform.js"
import { DiagnosticBank } from "../src/memory/diagnostic-bank.js"
import { LiveSkillVerifier } from "../src/skills/skill-verifier.js"

describe("Platform & Cross-Platform Utilities", () => {
  it("should accurately reflect current OS flags", () => {
    if (process.platform === "win32") {
      assert.strictEqual(Platform.isWindows(), true)
      assert.strictEqual(Platform.isMac(), false)
      assert.strictEqual(Platform.isLinux(), false)
    } else if (process.platform === "darwin") {
      assert.strictEqual(Platform.isWindows(), false)
      assert.strictEqual(Platform.isMac(), true)
      assert.strictEqual(Platform.isLinux(), false)
    } else if (process.platform === "linux") {
      assert.strictEqual(Platform.isWindows(), false)
      assert.strictEqual(Platform.isMac(), false)
      assert.strictEqual(Platform.isLinux(), true)
    }
  })

  it("should retrieve and set PATH regardless of case", () => {
    const mockEnvLower: Record<string, string | undefined> = { path: "/custom/bin" }
    assert.strictEqual(Platform.getEnvPath(mockEnvLower as any), "/custom/bin")

    const mockEnvUpper: Record<string, string | undefined> = { PATH: "/other/bin" }
    assert.strictEqual(Platform.getEnvPath(mockEnvUpper as any), "/other/bin")

    const mockEnvWin: Record<string, string | undefined> = { Path: "C:\\Windows" }
    assert.strictEqual(Platform.getEnvPath(mockEnvWin as any), "C:\\Windows")

    Platform.setEnvPath(mockEnvWin, "C:\\Windows;C:\\bun")
    assert.strictEqual(mockEnvWin.Path, "C:\\Windows;C:\\bun")
  })

  it("should provide valid candidate binary paths and system directories", () => {
    const bunCandidates = Platform.getCandidateBunPaths()
    assert.ok(bunCandidates.length > 0)

    const nodeCandidates = Platform.getCandidateNodePaths()
    assert.ok(nodeCandidates.length > 0)

    const defaultDirs = Platform.getDefaultSystemPathDirs()
    assert.ok(defaultDirs.length > 0)
  })

  it("should build enriched environment using system path delimiter", () => {
    const fakeEnv: Record<string, string | undefined> = {
      PATH: "/existing/dir",
      NODE_ENV: "test",
    }
    const enriched = Platform.buildEnrichedEnv(fakeEnv as any, { EXTRA_VAR: "1" })
    assert.strictEqual(enriched.EXTRA_VAR, "1")
    assert.strictEqual(enriched.NODE_ENV, "test")

    const enrichedPath = Platform.getEnvPath(enriched)
    assert.ok(enrichedPath.includes("/existing/dir"))
    // Ensure path.delimiter is used to separate segments
    const segments = enrichedPath.split(path.delimiter)
    assert.ok(segments.length > 1)
  })

  it("should resolve existing binaries and fallback for non-existent ones", () => {
    const fallback = Platform.resolveBinary(["/non/existent/path/binary12345"], "fallback-bin")
    assert.strictEqual(fallback, "fallback-bin")
  })

  it("should normalize error signatures across Windows, UNC, and POSIX formats", () => {
    const bank = new DiagnosticBank()

    // POSIX path error
    const posixError = "TypeError: map of undefined at /Users/alice/repo/src/index.ts:42:15"
    const posixNorm = bank.normalizeErrorSignature(posixError)
    assert.ok(posixNorm.includes("<path>:<line>:<col>"))
    assert.ok(!posixNorm.includes("/Users/alice"))

    // Windows backslash path error
    const winError = "TypeError: map of undefined at C:\\Users\\alice\\repo\\src\\index.ts:42:15"
    const winNorm = bank.normalizeErrorSignature(winError)
    assert.ok(winNorm.includes("<path>:<line>:<col>"))
    assert.ok(!winNorm.includes("C:\\Users\\alice"))

    // Windows forward-slash path error
    const winFwdError = "Error: Cannot find module at C:/Users/alice/repo/src/index.ts:10:5"
    const winFwdNorm = bank.normalizeErrorSignature(winFwdError)
    assert.ok(winFwdNorm.includes("<path>:<line>:<col>"))
    assert.ok(!winFwdNorm.includes("C:/Users/alice"))

    // UNC share path error
    const uncError = "Error: File read failed at \\\\server\\share\\repo\\src\\index.ts:8:2"
    const uncNorm = bank.normalizeErrorSignature(uncError)
    assert.ok(uncNorm.includes("<path>:<line>:<col>"))
    assert.ok(!uncNorm.includes("\\\\server\\share"))
  })

  it("should reject hardcoded Windows, UNC, and POSIX paths in skill verifier", async () => {
    const mockBridge: any = {
      promptJson: async () => {
        throw new Error("Trigger fallback")
      },
    }
    const verifier = new LiveSkillVerifier(mockBridge)

    // POSIX path
    const resPosix = await verifier.verify({
      metadata: {} as any,
      skillMarkdownContent: "# Step\nRun script at /Users/alice/project/build.sh",
    })
    assert.strictEqual(resPosix.passed, false)

    // Linux home path
    const resLinux = await verifier.verify({
      metadata: {} as any,
      skillMarkdownContent: "# Step\nRun script at /home/bob/project/build.sh",
    })
    assert.strictEqual(resLinux.passed, false)

    // Windows backslash path
    const resWin = await verifier.verify({
      metadata: {} as any,
      skillMarkdownContent: "# Step\nRun script at C:\\Users\\alice\\project\\build.bat",
    })
    assert.strictEqual(resWin.passed, false)

    // Windows forward slash path
    const resWinFwd = await verifier.verify({
      metadata: {} as any,
      skillMarkdownContent: "# Step\nRun script at D:/Projects/alice/build.bat",
    })
    assert.strictEqual(resWinFwd.passed, false)

    // UNC network share path
    const resUnc = await verifier.verify({
      metadata: {} as any,
      skillMarkdownContent: "# Step\nRun script at \\\\fileserver\\shared\\build.bat",
    })
    assert.strictEqual(resUnc.passed, false)

    // Generic relative path should pass
    const resClean = await verifier.verify({
      metadata: {} as any,
      skillMarkdownContent: "# Step\nRun npm run build in the workspace root",
    })
    assert.strictEqual(resClean.passed, true)
  })
})
