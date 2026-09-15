# Nib — Code Conventions

## TypeScript

### Module system
- ESM only (`"type": "module"` in package.json)
- All relative imports use `.js` extension: `import { foo } from "./bar.js"`
- `import type` for type-only imports

### Types
- Never use `any`. Use `unknown` and narrow.
- Canonical types in `src/types.ts` never import from any provider SDK.
- Provider-specific types stay inside `src/providers/<name>.ts`.
- Prefer interfaces for objects, `type` for unions and primitives.

### Naming
- Files: kebab-case (`tool-registry.ts`, `apply-diff.ts`)
- Types/interfaces: PascalCase (`ToolDef`, `Message`)
- Functions/variables: camelCase (`executeTool`, `pendingCalls`)
- Constants exported from modules: UPPER_SNAKE only if truly constant primitive values

### Functions
- Pure functions preferred. Side effects (I/O, stdout) at the edges.
- No default exports. Named exports only.
- Functions under 40 lines. If longer, extract.

### Error handling
- Never throw in tool handlers — return `ToolOutput` with `error` field.
- `try/catch` around any `JSON.parse` of LLM output.
- Provider errors: surface to agent loop, don't crash the CLI.

### Comments
- None by default. Code should be self-documenting.
- Only add comments for non-obvious design decisions (tradeoffs, gotchas).

### File structure
- One concept per file. If a file exceeds 200 lines, split it.
- `index.ts` files only re-export — no logic.

## Documentation Workflow

- `todo.md` is **untracked** working state (gitignored): checkmarks, audit
  findings, acceptance-criteria drafts, agent instructions. Append to it;
  never regenerate it wholesale.
- `dev-todo.md` is the same class of file — the gitignored dev-agent
  handoff queue (one item per feature: checkboxes, anchors, verify line).
  Planner-owned; parallel dev agents are told not to edit it.
- `docs/` is the committed record. When a phase completes, promote what
  matters: implementation decisions → the relevant spec (with a line in its
  changelog/design-decisions section), AC tables → test descriptions.
  Findings and checkmarks are ephemeral — they die with the todo.
- Nothing in `docs/` may require reading `todo.md` to understand.
- `docs/README.md` is the canonical doc index. Every current doc carries a
  status line in the format defined there; new or moved docs update the
  index in the same change. Superseded/historical material moves to
  `docs/archive/` — never delete, and nothing in the live set may link
  into it.

## Git

### Commits
- `feat:` — new feature or phase
- `fix:` — bug fix
- `refactor:` — restructuring without behavior change
- `docs:` — documentation only
- `chore:` — tooling, config, deps

### Branches
- `main` — always working, always compiles
- Feature branches for multi-commit work

## Testing

### Framework
Vitest (decided 2026-07-28): ESM-native (matches `"type": "module"`),
zero-config TypeScript, watch mode. `npm test` runs `vitest run`.

### TUI tests (App-level)
- Drive real keypresses as stdin bytes (`"\x1b"` for Esc, `"\x0f"` for
  Ctrl+O). A fake `runAgentTurnCore` plus the shared `AbortController`
  returned by `ctx.provideAbortController` lets a test observe a real
  mid-turn abort — that is how `App.streaming.test.tsx` proves
  Esc-interrupt and queue survival end-to-end.
- Fake ctx objects must `typeof`-guard optional stores
  (`sessionStore.queryTodos` etc.) — App's mount effect reads them, and an
  unguarded fake crashes every mount.

### Unit tests (from Phase 2)
Highest-value targets, in priority order:
1. **Edit strategies** — each of the 6 tools against fixture files: clean
   match, no match, count mismatch, multi-file patch atomicity (tool-spec.md).
2. **Permission engine** — rule resolution (most-restrictive-wins,
   specificity tiers, glob patterns; permission-spec.md).
3. **ToolRegistry** — mode gating returns exactly the allowed tool subset.
4. **Compaction budget** — threshold math, tier classification, fidelity check.
5. **Session loader** — torn last line, state-record folding, compaction
   reconstruction.

Provider adapters and the agent loop are covered by golden tasks, not unit
tests — mocking an LLM tests the mock.

### Golden tasks (agent-level evals)
Small end-to-end tasks under `fixtures/`, re-run after any prompt or loop
change (see system-prompt.md, "Changing the Prompt"). The runner is
`scripts/eval.ts` (`npm run eval`) — see eval-harness.md for the cases it
covers (currently G2/G3/G5) and its known breakage.

| # | Task | Verifies |
|---|------|----------|
| G1 | "What does src/agent.ts do?" in ask mode | read-only gating, no writes |
| G2 | Fix a planted failing test in `fixtures/calc` | ReAct edit + verify cycle |
| G3 | Add a `--json` flag to `fixtures/cli` | multi-step feature, edit-tool selection |
| G4 | Rename a function used across 3 files | apply_patch / cross-file edits |
| G5 | "Why does `fixtures/leaky` grow memory?" | search + read diagnosis, no edits |
| G6 | Task long enough to trigger compaction, then finish | compaction fidelity (Phase 4+) |

Pass = correct outcome **and** no out-of-scope file modified.

## Tool design
- Every tool returns `ToolOutput`, never throws.
- Tool schemas (JSON Schema for LLM) live alongside the handler.
- Prefer explicit parameters over flexible ones (e.g., `path: string` not `args: string`).
