# Documentation

**Status:** index · verified 2026-08-18

## Purpose

This is the canonical index of nib's documentation — the definitive
reference for developers, maintainers, and new contributors. Start here,
then follow the reading paths below.

## How this set is organized

- **`*-spec.md` files are reference contracts** — each documents a shipped
  subsystem's behavior, schema, or surface and carries a status line under
  the title.
- **`subsystems/*.md` are design deep dives** with stable § numbers
  (`## 1.` … `## 6.`). **Never renumber them** — other specs cite them as
  "subsystems.md §1", "§3", etc.
- **Historical material lives in [`docs/archive/`](./archive/README.md)**:
  superseded designs, completed task briefs, release notes. Nothing there
  is required reading, and no current doc may link into it.
- Root `todo.md` is the untracked scratch tracker (gitignored). Nothing in
  `docs/` requires it to understand (conventions.md).

## Doc conventions

- **Status line** — every current doc carries one under its title, in one
  of these forms:
  - `**Status:** current · verified <date> · covers src/<module>`
  - `**Status:** partially implemented · verified <date>`
  - `**Status:** forward-looking …` / `**Status:** research essay …`
    (planning docs)
  - `**Status:** historical …` (archive only)
- **Code wins.** When a doc and the code disagree, the code is right —
  fix the doc.
- **Anchors are hints, contracts are normative.** `src/file:line`
  references are navigational and drift; the behavioral contract in a spec
  is what must hold.
- New or moved docs update this index in the same change (conventions.md).

## Index

### Start here

| Doc | Covers |
|-----|--------|
| [README.md](../README.md) | Install, quickstart, feature overview, FAQ |
| [troubleshooting.md](./troubleshooting.md) | FAQ + common pitfalls, sourced from code |
| [architecture.md](./architecture.md) | The 7 layers, one-turn data flow, sequence diagram, file manifest, tradeoffs |

### Architecture & deep dives

| Doc | Covers |
|-----|--------|
| [subsystems.md](./subsystems.md) | Index of the six subsystems deep dives (§-stable) |
| [subsystems/memory-architecture.md](./subsystems/memory-architecture.md) | §1 Markdown memory store, injection cap |
| [subsystems/context-management.md](./subsystems/context-management.md) | §2 Token budget, compaction, request-time tool-result editing, `keepBoundary` invariant |
| [subsystems/react-loop.md](./subsystems/react-loop.md) | §3 ReAct + Plan + Reflect, todo mechanics |
| [subsystems/token-optimization.md](./subsystems/token-optimization.md) | §4 Prefix caching, mode-gated tools, caps |
| [subsystems/session-lifecycle.md](./subsystems/session-lifecycle.md) | §5 Session flow, resume |
| [subsystems/failure-modes.md](./subsystems/failure-modes.md) | §6 Retry policy, stale-file detection, degradation |

### Reference specs

| Doc | Covers |
|-----|--------|
| [tool-spec.md](./tool-spec.md) | All 20 tools: params, limits, error behavior |
| [system-prompt.md](./system-prompt.md) | Prompt assembly: stable preamble + volatile context |
| [mode-spec.md](./mode-spec.md) | Mode schema, tool groups, built-ins, custom modes |
| [config-spec.md](./config-spec.md) | settings.json schema, credentials, env vars |
| [cli-spec.md](./cli-spec.md) | Flags, slash commands, keybindings, headless, exit codes |
| [session-spec.md](./session-spec.md) | Session JSONL format, index, resume |
| [provider-spec.md](./provider-spec.md) | Provider contract, catalog, key resolution |
| [permission-spec.md](./permission-spec.md) | Rules, normalization, resolution, posture, audit trail |
| [security-spec.md](./security-spec.md) | Threat model T1–T16, verified-fixed items |
| [security-architecture-plan.md](./security-architecture-plan.md) | Implemented security phases and open macOS adversarial release gates |
| [security-destructive-matching.md](./security-destructive-matching.md) | Destructive-matching hardening research (closed) |
| [skill-spec.md](./skill-spec.md) | Agent Skills loading, trigger, trust |
| [rules-spec.md](./rules-spec.md) | `.nib/rules/` + research notes |
| [notify-spec.md](./notify-spec.md) | notify hook env contract |
| [hooks-spec.md](./hooks-spec.md) | Lifecycle hooks contract: events, payload, exit codes, trust model |
| [web-search-spec.md](./web-search-spec.md) | Bing RSS search tier + anti-drift rules |
| [theme-spec.md](./theme-spec.md) | Theme engine, presets, detection |
| [mcp-spec.md](./mcp-spec.md) | MCP stdio protocol, tool registration, strictMcpConfig |
| [eval-harness.md](./eval-harness.md) | Golden-task runner (fixed 2026-08-13: correct entry, injected permissions, isolated home) |

### Ops

| Doc | Covers |
|-----|--------|
| [input-stall-diagnosis.md](./input-stall-diagnosis.md) | Freeze taxonomy (resolved; reference) |
| [releasing.md](./releasing.md) | npm Trusted Publishing and Homebrew tap release procedure |

### Roadmaps & research

| Doc | Covers |
|-----|--------|
| [claude-code-parity.md](./claude-code-parity.md) | Gap analysis vs Claude Code (forward-looking) |
| [permission-profile.md](./permission-profile.md) | PermissionProfile ACL design (draft): schema, evaluation order, Seatbelt phase |
| [async-subagents.md](./async-subagents.md) | Async sub-agent execution design: spawn-return-immediately, auto-wake, cap 3, /tasks |
| [unified-write-boundary.md](./unified-write-boundary.md) | Unified write boundary design: one shared write-set across Seatbelt + file tools; global-only `sandbox.writeRoots` (approved 2026-08-17, not yet built) |
| [feature-plans.md](./feature-plans.md) | Per-feature plans for the remaining roadmap: SOTA research, current state, design, decisions |
| [model-catalog-plan.md](./model-catalog-plan.md) | Models.dev-backed catalog: snapshot, overrides, update contract, and delivery slices |
| [improvement-roadmap.md](./improvement-roadmap.md) | Roadmap with shipped/unshipped waves |
| [agent-memory-that-evolves.md](./agent-memory-that-evolves.md) | Memory-design research essay (context only) |

### Development

| Doc | Covers |
|-----|--------|
| [conventions.md](./conventions.md) | Code + doc conventions |
| [../CONTRIBUTING.md](../CONTRIBUTING.md) | Setup, PR checklist, code map |

### Historical

| Doc | Covers |
|-----|--------|
| [archive/README.md](./archive/README.md) | Superseded designs and completed task briefs |

## Reading paths

- **New contributor:** README → troubleshooting → architecture →
  tool-spec → conventions.
- **Maintainer:** architecture → subsystems → the spec of whatever
  subsystem you're touching.
- **User:** README → troubleshooting → config-spec → cli-spec.
- **Core-system tour:** README → architecture → mode-spec → system-prompt →
  subsystems/react-loop → permission-spec → tool-spec → session-spec.

## Known gaps & unverified assumptions (as of 2026-08-13)

1. ~~**`NIB_HOME` is only partially honored.**~~ **Resolved 2026-08-13**:
   `resolveHome()` is now the single source of truth and every subsystem
   (credentials, sessions, checkpoints, memory included) routes through
   it.
2. **Model catalog IDs are catalog-relative, not canonical.**
   `src/providers/models.json` ships sandbox IDs (`deepseek-v4-pro`,
   `gpt-5.6-sol`, …). Docs cite them as-is because they are what the
   product ships; older docs may show retired IDs. `--model` takes
   `provider/model`, split on the first slash.
3. **Default pairing is deepseek/deepseek-v4-pro**, except the default
   `general` mode, which pairs deepseek/deepseek-v4-flash at low reasoning
   effort (mode-spec.md §5); the anthropic API type is supported via the AI
   SDK but has no bundled preset.
4. **Previously uncovered areas, now documented (2026-08-13):**
   [eval-harness.md](./eval-harness.md),
   [mcp-spec.md](./mcp-spec.md). Still thin: memory-injection mechanics
   beyond the ≤1024-token cap, and the theme ansi ×2 preset follow-on
   (noted in theme-spec.md §2). The eval runner was broken as written
   (deleted entry, nonexistent flag, stdin hang, global-MCP blocking) —
   **fixed 2026-08-13**; it now needs only a provider key to run real
   evals.
5. **Anchors vs contracts.** `src/file:line` references are navigational
   hints verified on 2026-08-13; they drift as code moves. Treat spec
   *contracts* as normative, anchors as hints. Tool error codes are
   content strings, not a formal enum — new handlers may add codes without
   a spec change.
6. **`run_bash` has a fixed 120 s cap and no timeout parameter** — long
   commands belong in `run_bash_background`. Re-verify this spec if a
   timeout param is ever added.
7. **Archived docs are records, not truth.** `docs/archive/` may contain
   dead links, retired IDs, and known-false claims (e.g. REDESIGN.md's
   `credentials.json`); do not treat them as current.
