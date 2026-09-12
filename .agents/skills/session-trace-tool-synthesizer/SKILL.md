---
name: session-trace-tool-synthesizer
description: >-
  Analyzes interactive session traces, command histories, and multi-step agent workflows
  to identify candidate procedures and synthesize reusable LiveTools using register_live_tool.
  Use when asked to analyze a session trace, extract tools from past conversations, turn
  a conversation or workflow into reusable tools, or when running /analyze-trace.
---

# Session Trace Tool Synthesizer

This skill guides the agent in analyzing session execution traces (e.g., conversational transcripts, command histories, iterative data calculations) to extract, generalize, synthesize, and register reusable **LiveTools** into OpenCode via `register_live_tool`.

---

## When to Activate This Skill
- The user runs the slash command `/analyze-trace`.
- The user asks to:
  - *"analyze the session trace and create tools"*
  - *"turn what we just did into a live tool"*
  - *"extract reusable tools from this conversation / session log"*
- The current or prior session contains $\ge 2$ repetitive or multi-step procedures (e.g. log filtering, calculations, custom AST transforms, API aggregations, data parsing) that would benefit future agent turns.

---

## Analysis Workflow: From Trace to LiveTool

```
┌─────────────────────────┐
│ 1. Harvest Trace Source │ (Current session history, session-*.md, or CLI logs)
└───────────┬─────────────┘
            ▼
┌─────────────────────────┐
│ 2. Filter & Candidate   │ (Identify repeatable, deterministic algorithms)
└───────────┬─────────────┘
            ▼
┌─────────────────────────┐
│ 3. Generalize Logic     │ (Remove hardcoded paths, local usernames, commit hashes)
└───────────┬─────────────┘
            ▼
┌─────────────────────────┐
│ 4. Author Tool & Schema │ (args: { ... } with Zod; specify explicit sampleInputs)
└───────────┬─────────────┘
            ▼
┌─────────────────────────┐
│ 5. register_live_tool   │ (Validates AST security & passes sandbox test)
└───────────┬─────────────┘
            ▼
┌─────────────────────────┐
│ 6. invoke_live_tool     │ (Confirm execution and inspect telemetry)
└─────────────────────────┘
```

---

## Step-by-Step Procedure

### Step 1: Harvest & Inspect Trace
1. **Identify the source**:
   - If the user references a specific transcript file (e.g. `session-ses_f68d.md` or a log in the workspace), read it using `view_file` or parse it using the helper script:
     ```bash
     bun .agents/skills/session-trace-tool-synthesizer/scripts/inspect_traces.ts [path-to-session]
     ```
   - If analyzing the active session, inspect the preceding tool calls and user requests in context.
2. **Find candidate procedural workflows**:
   - Look for complex multi-line bash or python scripts written on the fly.
   - Look for multi-step calculations (e.g. statistics, data aggregations, parsing JSON/logs).
   - Look for repetitive search, inspection, or verification sequences.

### Step 2: Generalize the Logic
Before writing the tool:
- **Strip environment-specific artifacts**: Never hardcode paths like `/Users/nixni/...`, specific process IDs, or local git branch names.
- **Identify inputs**: Turn dynamic parts into parameters (e.g., `targetDirectory`, `pattern`, `threshold`, `items`).
- **Define clear outputs**: Tools should return `{ output: string }` containing structured JSON or human-readable summary text.

### Step 3: Author the Tool Source Code
Follow the OpenCode LiveTool standard:
- Import `{ tool }` from `@opencode-ai/plugin/tool` and `{ z }` from `zod`.
- Export a named tool constant matching `toolName`.
- Use `args: { [name]: z.type().describe("...") }`.
- **Do NOT** wrap in `input: z.object(...)`.
- The execute function receives `(args, ctx)` where `ctx` provides `ctx.directory` and `ctx.worktree`.

```typescript
import { tool } from "@opencode-ai/plugin/tool"
import { z } from "zod"

export const sample_analyzer = tool({
  description: "Analyzes items and returns summary metrics",
  args: {
    items: z.array(z.string()).describe("List of items to analyze"),
    threshold: z.number().optional().describe("Filtering threshold"),
  },
  async execute(args, ctx) {
    const threshold = args.threshold ?? 0
    const filtered = args.items.filter(item => item.length > threshold)
    return {
      output: JSON.stringify({ count: filtered.length, filtered })
    }
  }
})
```

### Step 4: Register the Tool with Explicit `sampleInputs`
Invoke `register_live_tool`:
```json
{
  "toolName": "sample_analyzer",
  "description": "Analyzes items and returns summary metrics",
  "sourceCode": "...",
  "sampleInputs": [
    {
      "items": ["alpha", "beta", "gamma"],
      "threshold": 4
    }
  ]
}
```

> [!IMPORTANT]
> **Always provide realistic `sampleInputs`**:
> When `sampleInputs` is omitted, the sandbox test harness synthesizes generic placeholder mock values (e.g. `"test"`, `1`, `[1]`, `true`). If your tool relies on valid file paths, URLs, positive integers, specific array shapes, or regex patterns, generic placeholders will cause sandbox verification to fail. Providing explicit `sampleInputs` guarantees instant attempt-1 activation.

### Step 5: Verify via `invoke_live_tool`
Verify the tool is active and callable:
```json
{
  "toolName": "sample_analyzer",
  "args": {
    "items": ["one", "three", "seventeen"],
    "threshold": 4
  }
}
```

### Step 6: Inform the User
Present a brief summary:
1. Tool Name and Intent.
2. Argument schema and parameter descriptions.
3. Successful test invocation output.
4. How the user or agent can invoke it in subsequent turns.
