# AGENTS.md — Developer & Agent Guidelines for Project DNA

## 1. Project Overview

**Project DNA (Dynamic Neuro-Adaptive Architecture)** is an autonomous, self-synthesizing procedural and epistemic runtime plugin for **OpenCode** (`@opencode-ai/plugin`).

It transitions the coding agent from a static consumer of pre-compiled code into an autonomous architect of its own procedural tools, skills, and Zettelkasten memory.

### The Three Core Engines
1. **LiveTools (The LATM Paradigm)**: The agent dynamically synthesizes reusable TypeScript tools using `@opencode-ai/plugin/tool`, checks AST safety, verifies them with synthetic unit tests in an isolated subprocess, and hot-loads them immediately into OpenCode's active tool registry via `synthesize_live_tool`.
2. **LiveSkills (Dynamic Procedural Lifecycle)**: Multi-step interactive execution traces are harvested from `EventSessionIdle`, distilled into standardized `SKILL.md` packages with adversarial verification, and continuously scored for reliability and pruning.
3. **LiveMemory (A-Mem / Zettelkasten Knowledge Graph)**: Schema-free, interconnected atomic memory notes persisted in SQLite with dynamic relationship evaluation (`CAUSED_BY`, `SUPERSEDES`, `RELATES_TO`, `REFINES`, `CONTRADICTS`), paired with a Diagnostic Failure Bank and session compaction enrichment.

---

## 2. Developer & Environment Commands

| Command | Description |
| :--- | :--- |
| `bun test` | Executes the complete test suite across all subsystems. |
| `npx tsc` | Compiles TypeScript source files into `dist/` with type declarations. |
| `npx tsc --noEmit` | Runs strict type checking across `src/` and `specs/contracts/`. |
| `opencode debug config` | Inspects OpenCode's resolved configuration and verifies plugin loading. |

---

## 3. Directory Layout

```
Project DNA/
├── src/
│   ├── index.ts                      # Main OpenCode plugin entry point
│   ├── core/
│   │   ├── config.ts                 # Configuration manager & path resolution
│   │   ├── llm-bridge.ts             # Zero-friction LLM reuse via ctx.client.session
│   │   ├── sqlite-adapter.ts         # Universal SQLite (bun:sqlite + node:sqlite)
│   │   └── telemetry.ts              # Telemetry & health scoring
│   ├── memory/
│   │   ├── memory-store.ts           # SQLite Zettelkasten card & link store
│   │   ├── link-generator.ts         # A-Mem dynamic link generator
│   │   ├── diagnostic-bank.ts        # Failure interceptor & recovery telemetry
│   │   └── open-memory-exporter.ts   # Open Memory standard JSON export/import
│   ├── tools/
│   │   ├── ast-validator.ts          # Static security AST policy validator
│   │   ├── test-sandbox.ts           # Isolated subprocess test runner
│   │   ├── tool-maker.ts             # LATM prompt & synthesis engine
│   │   └── tool-registry.ts          # Hot-reload tool registry and loader
│   └── skills/
│       ├── trace-harvester.ts        # Interactive execution trace buffer
│       ├── skill-distiller.ts        # Trace-to-SKILL.md distillation pipeline
│       ├── skill-verifier.ts         # Adversarial skill verifier
│       └── skill-store.ts            # Active/staged/archive skill manager
├── .opencode/
│   ├── plugins/
│   │   └── dna.ts                    # Native OpenCode directory plugin loader
│   └── dna/                          # Runtime persistence directory
│       ├── config.json               # Runtime plugin settings
│       ├── memory/graph.db           # SQLite knowledge graph
│       ├── tools/registry.json       # Hot-reload tool registry
│       └── skills/                   # Active/staged/archive skill packages
├── opencode.json                     # Declarative OpenCode plugin configuration
└── specs/
    ├── contracts/                    # TypeScript interfaces for each pillar
    └── schemas/                      # JSON Schemas for tool, skill, and memory packages
```

---

## 4. Key Architectural Patterns for Agents

### Zero-Friction LLM Reuse
- **Never ask for external API keys**: Project DNA communicates with OpenCode's internal SDK (`@opencode-ai/sdk`) via `OpenCodeLLMBridge`.
- Background synthesis runs inside headless sub-sessions (`ctx.client.session.create()`) and automatically inherits the user's configured provider and model (and `small_model` for fast classification tasks).

### LiveTool Hot-Loading
- Synthesized tools are written to `.opencode/dna/tools/src/<name>.ts`.
- `LiveToolRegistry.loadAndRegister()` dynamically imports the module (`import(fileUrl)`) and attaches the tool to the live `hooks.tool` dictionary in real-time.
- To create a new tool at runtime, invoke the `synthesize_live_tool` meta-tool.

### Skill Harvesting Lifecycle
- Traces are recorded across turns.
- When `EventSessionIdle` fires, if the turn was successful and had $\ge 2$ tool steps, `LiveSkillHarvester.evaluateAndSetResolution()` marks the session as `SUCCESS`.
- `LiveSkillDistiller` distills the steps into a generalized `SKILL.md` package and saves it to `.opencode/dna/skills/active/`.

### Memory Compaction Hook
- OpenCode triggers `"experimental.session.compacting"` when the context window reaches capacity.
- Project DNA automatically injects all uncompacted session memory notes and active diagnostic traps into the compaction summary prompt, guaranteeing epistemic continuity.

---

## 5. Coding Conventions

- **Language**: TypeScript 5.8+ targeting ES2022 / NodeNext.
- **Dependencies**: Keep runtime dependencies strictly minimal. The SQLite engine uses native `bun:sqlite` or `node:sqlite`.
- **Typing**: Strict type safety. Always verify with `npx tsc --noEmit` before committing changes.
