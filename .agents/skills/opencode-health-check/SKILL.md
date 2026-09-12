---
name: opencode-health-check
description: >-
  Verifies that OpenCode starts up cleanly with the Project DNA plugin, validates plugin
  configuration and schema integrity, and checks OpenCode system logs for startup crashes.
  Use when testing plugin loading, troubleshooting "Unexpected server error", or after
  modifying plugin hooks, tool definitions, or dependencies.
---

# OpenCode Startup & Plugin Health Check

This runbook guides verification that OpenCode boots cleanly with `@opencode-ai/plugin` and the Project DNA runtime without server crashes or schema serialization failures.

## Quick Verification

Run the automated check script:
```bash
bash .agents/skills/opencode-health-check/scripts/verify.sh
```

---

## Step-by-Step Manual Verification

### 1. Build & Typecheck
Ensure all TypeScript definitions and compiled plugin artifacts are consistent:
```bash
npm run typecheck && npm run build
```
- Expected result: 0 TypeScript errors.

### 2. Verify OpenCode Plugin Resolution & Config
Inspect OpenCode's resolved plugin origins and configuration without launching an interactive UI:
```bash
opencode debug config
```
- **Expected result**: Exit code `0`.
- **Output check**: `plugin` array contains `file://.../.opencode/plugins/dna.ts` and `plugin_origins` resolves to local workspace.

### 3. Verify Tool Schema & Prompt Resolution
Test that OpenCode's internal schema encoder (AI-SDK) resolves live tool definitions without crashing:
```bash
opencode run --pure --auto "echo test"
```
*(Or run headless session test)*:
- If a schema error occurs, OpenCode throws:
  `TypeError: undefined is not an object (evaluating 'X.encoding') at SessionTools.resolve (definition)`
- **Fix**: Ensure `out.parameters` in `tool.definition` hook is never assigned raw parameter description maps (`Record<string, string>`).

### 4. Inspect OpenCode System Logs
OpenCode logs runtime events, boot lifecycle, and uncaught exceptions to:
```bash
tail -n 50 ~/.local/share/opencode/log/opencode.log
```
Check for:
- `level=ERROR`
- `cause="TypeError: ..."`
- `SessionTools.resolve` or `SessionPrompt.run` stack traces.

### 5. Run Integration Tests
Verify that Project DNA plugin integration tests pass:
```bash
bun test tests/plugin-integration.test.ts
```
