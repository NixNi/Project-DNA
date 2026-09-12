#!/usr/bin/env bun
/**
 * Helper script to inspect session transcript files or active LiveTool registry
 * Usage:
 *   bun .agents/skills/session-trace-tool-synthesizer/scripts/inspect_traces.ts [path-to-session-file]
 */

import * as fs from "node:fs/promises"
import * as path from "node:path"

async function main() {
  const targetPath = process.argv[2]

  if (targetPath) {
    const fullPath = path.resolve(targetPath)
    console.log(`[Trace Inspector] Analyzing session file: ${fullPath}\n`)
    try {
      const content = await fs.readFile(fullPath, "utf-8")
      analyzeSessionMarkdown(content)
    } catch (err: any) {
      console.error(`Failed to read file ${fullPath}:`, err.message)
      process.exit(1)
    }
    return
  }

  // If no argument, discover session files in current working directory
  console.log(`[Trace Inspector] Scanning workspace for session transcripts...\n`)
  const cwd = process.cwd()
  const entries = await fs.readdir(cwd, { withFileTypes: true })
  const sessionFiles = entries
    .filter((e) => e.isFile() && e.name.startsWith("session-") && e.name.endsWith(".md"))
    .map((e) => e.name)

  if (sessionFiles.length === 0) {
    console.log("No 'session-*.md' files found in workspace root.")
  } else {
    console.log(`Found ${sessionFiles.length} session file(s):`)
    for (const f of sessionFiles) {
      console.log(`  - ${f}`)
    }
    console.log(`\nRun: bun .agents/skills/session-trace-tool-synthesizer/scripts/inspect_traces.ts <filename> to analyze.`)
  }

  // Check active LiveTools in .opencode/dna/tools/registry.json
  const registryPath = path.join(cwd, ".opencode", "dna", "tools", "registry.json")
  try {
    const raw = await fs.readFile(registryPath, "utf-8")
    const data = JSON.parse(raw)
    const tools = Object.keys(data.tools || {})
    console.log(`\nActive LiveTools in registry (${tools.length}):`)
    for (const t of tools) {
      const toolMeta = data.tools[t]
      console.log(`  - ${t} (v${toolMeta.version}, health: ${toolMeta.telemetry?.healthScore ?? 1.0})`)
    }
  } catch {
    console.log("\nNo active LiveTools registry found at .opencode/dna/tools/registry.json")
  }
}

function analyzeSessionMarkdown(content: string) {
  const lines = content.split("\n")
  const toolCalls: { name: string; line: number }[] = []
  const toolBlocks: { tool: string; input?: string; output?: string }[] = []

  let currentTool = ""
  let capturingInput = false
  let capturingOutput = false
  let currentInput = ""
  let currentOutput = ""

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const toolMatch = line.match(/\*\*Tool:\s*([a-zA-Z0-9_-]+)\*\*/)
    if (toolMatch) {
      if (currentTool) {
        toolBlocks.push({
          tool: currentTool,
          input: currentInput.trim(),
          output: currentOutput.trim(),
        })
        currentInput = ""
        currentOutput = ""
      }
      currentTool = toolMatch[1]
      toolCalls.push({ name: currentTool, line: i + 1 })
      capturingInput = false
      capturingOutput = false
      continue
    }

    if (line.includes("**Input:**")) {
      capturingInput = true
      capturingOutput = false
      continue
    }

    if (line.includes("**Output:**") || line.includes("**Error:**")) {
      capturingInput = false
      capturingOutput = true
      continue
    }

    if (capturingInput) {
      currentInput += line + "\n"
    } else if (capturingOutput) {
      currentOutput += line + "\n"
    }
  }

  if (currentTool) {
    toolBlocks.push({
      tool: currentTool,
      input: currentInput.trim(),
      output: currentOutput.trim(),
    })
  }

  console.log(`Summary of Tool Calls (${toolBlocks.length} total):`)
  const countMap: Record<string, number> = {}
  for (const b of toolBlocks) {
    countMap[b.tool] = (countMap[b.tool] || 0) + 1
  }
  for (const [tool, count] of Object.entries(countMap)) {
    console.log(`  - ${tool}: ${count} invocation(s)`)
  }

  console.log("\nRecent Invocations:")
  for (let i = 0; i < Math.min(toolBlocks.length, 5); i++) {
    const b = toolBlocks[i]
    console.log(`\n[${i + 1}] Tool: ${b.tool}`)
    if (b.input) {
      console.log(`    Input snippet: ${b.input.slice(0, 150).replace(/\n/g, " ")}...`)
    }
    if (b.output) {
      console.log(`    Output snippet: ${b.output.slice(0, 150).replace(/\n/g, " ")}...`)
    }
  }
}

main().catch(console.error)
