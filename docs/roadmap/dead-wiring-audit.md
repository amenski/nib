# Roadmap — dead-wiring audit

**Status:** split out of [improvement-roadmap.md](../improvement-roadmap.md) on 2026-10-13 · audit 2026-07-31, resolved 2026-08-08.

## Dead wiring — audit findings (2026-07-31, resolved 2026-08-08)

> **Status: this sweep is closed.** Every "being wired / being resolved
> (in-flight)" verdict below has since landed — re-verified against the code on
> 2026-08-08: `ErrorRecovery`, `ErrorReflector`, and `RepoMap` are all
> constructed and threaded into the agent context; `enabledSkills`,
> `compaction.auto`, and `workflow.gitPollInterval` all have real consumers;
> `notify` and `statusline` are wired. The tables are kept as a record of the
> audit method and its findings, **not** as an open work list. The last
> deferred item — the `Orchestrator` / `new_task` subsystem — was wired on
> 2026-08-11 (see the Roadmap tier), closing the sweep.

This repo had a recurring disease: config keys, modules, and whole subsystems
that were **declared/parsed/plumbed but consumed by nothing**. This section is a
full sweep. Already found + fixed elsewhere (not re-listed as new):
`webSearchTool` (deprecated with a warning), `notify` + `statusline` (activated),
`setConfigProviders` (dead helper — imported into `cli.tsx:9` but never called).

Method: for each candidate, grep past the declaration/parse site for a real
consumer. "Dead-wired" = the value is set/plumbed but read by nothing (or the
read is behind a field no caller ever populates).

### (a) `loader.ts` `KNOWN_KEYS` — keys parsed but consumed nowhere

| Key | Declared | Evidence nothing consumes it | Recommend |
|---|---|---|---|
| `enabledSkills` | `loader.ts:68,172,519–536` (parsed into `config.enabledSkills`) | No reader anywhere — `grep enabledSkills src` hits only `loader.ts`. `src/skills/` never consults it; every skill loads unconditionally. | **Being resolved (in-flight)** — wire vs. deprecate decision landing with the config-keys wave (prefer wire; skills loader should honor it). |
| `debugLogEnabled` | `loader.ts:71,173,540–545` | Debug logging is gated by the **`--debug` CLI flag** (`cli.tsx:168 enableDebug(sessionId)`), never by this key. Zero readers of `config.debugLogEnabled`. | **Being resolved (in-flight)** — lean deprecate (the `--debug` flag is the real path); resolving with the config-keys wave. |
| `telemetryEnabled` | `loader.ts:72,174,549–554` | Zero readers. No telemetry subsystem consults it (`grep -i telemetry src` outside loader = nothing). | **Being resolved (in-flight)** — deprecate until a telemetry consumer exists (pairs with the exit-summary counters); resolving with the config-keys wave. |
| `notify` | `loader.ts:60,170,498–503` | Parse-only today. *(Being activated by the in-flight wave — listed for completeness.)* | **Wire** (in progress). |
| `webSearchTool` | `loader.ts:64,171,507–515` | Parse-only; already emits a deprecation warning. | **Deprecate** (done). |

Sub-key findings inside otherwise-live keys:

| Sub-key | Declared | Evidence | Recommend |
|---|---|---|---|
| `compaction.auto` | `loader.ts:100` (type + parse) | Only `compaction.threshold` is read (`cli.tsx:123` → `Compactor`). `compaction.auto` has no reader — auto-compaction is unconditional. | **Being resolved (in-flight)** — wire (gate auto-compaction on it) vs. deprecate decision landing with the config-keys wave. |
| `workflow.*` (`gitStatus`, `gitPollInterval`, `gitCommands`, `detectBuildTools`) | `loader.ts:93–98`; assembled into `workflowConfig` at `cli.tsx:308–312` and set on `appCtx.workflowConfig` (`cli.tsx:432`) | **`workflowConfig` has zero readers.** It's a field on `AppContext` (`ui/types.ts:161`) and in `AppProps`, but `App.tsx` never destructures or reads it; `ctx.workflowConfig` is referenced nowhere. The git poller **hardcodes `30000`** (`App.tsx:259`), ignoring `gitPollInterval`; `gitStatus`/`gitCommands`/`detectBuildTools` gates are never consulted. | **Being resolved (in-flight)** — wire the subtree (poller reads `gitPollInterval`, honor the gates) vs. delete decision landing with the config-keys wave. |

Keys confirmed **live** (traced to a real consumer): `env`, `model`,
`thinkingEnabled`, `reasoningEffort`, `permissions`, `mcpServers`,
`strictMcpConfig`, `temperature`, `provider`, `theme`, `keybindings`,
`compaction.threshold`, `contextWindow`.

### (b) Orphan modules / barrel exports (zero product consumers)

| Symbol / module | Where declared | Evidence | Recommend |
|---|---|---|---|
| ~~**`Orchestrator`** subsystem~~ ✅ **wired 2026-08-11** · **design doc + tagged audit 2026-08-13** | `src/orchestrator/index.ts` (`Orchestrator` class, `OrchestratorOptions`, `new_task` tool def) | **Resolved.** `new_task` is registered by both the TUI (`cli.tsx:181–189`) and headless (`exec-runner.ts:141–150`) registries; sub-agents run a real `runAgent` turn with the parent's live permission engine and a per-spawn provider. Design doc: [subsystems/orchestration.md](../subsystems/orchestration.md) §7 (2026-08-13); sub-agent audit/token rows tagged `source: "subagent"` in the parent session (2026-08-13). | **Wired + documented.** Enforcement: depth cap 3 / max 10 sub-turns. |
| **`ErrorRecovery`** subsystem | `src/errorrecovery/index.ts` | Only `agent.ts:8` imports it, as `type`, for the optional field `errorRecovery?` (`agent.ts:64`). The field **is** read (159/236/418) but **no caller of `runAgent` ever sets it** (`cli.tsx`, `exec-runner.ts`, `orchestrator`) and there is no `new ErrorRecovery`. Always `undefined`. | **Being wired (in-flight)** — parallel agent is instantiating + threading it in. |
| **`ErrorReflector`** subsystem | `src/selfreflection/index.ts` | Same shape: `agent.ts:7` `type`-imports it for `errorReflector?` (`:63`); read at 159/336/338/340 but never populated; no `new ErrorReflector`. Always `undefined`. | **Being wired (in-flight)** — parallel agent owns activation (see errorrecovery). |
| **`RepoMap`** subsystem | `src/repomap/index.ts` (~470 lines) | `type`-imported by `agent.ts:10` + `prompt.ts:3`; `prompt.ts:78` calls `ctx.repomap.getMap(...)` — but no caller ever sets `repomap`, so it is always `undefined` and the ~470-line impl never executes. | **Being wired (in-flight)** — parallel agent is constructing a `RepoMap` into the agent ctx. |
| **`src/ui/statusline/`** subsystem | `manager.ts`, `types.ts`, `sanitize.ts`, `index.ts` | Nothing outside the dir imports any of it; the `StatusSegment` used in `cli.tsx` comes from `ui/types.ts`, not here. *(Being activated by the in-flight wave.)* | **Wire** (in progress). |
| `src/config/validate.ts` — `validateModeYaml` | standalone | Zero importers anywhere; no test. | **Deleted (2026-07-31)** — re-verified zero importers, then removed. |
| `src/ui/ChatInput.tsx` — `ChatInput` | standalone component | Zero importers anywhere. Superseded by `PromptInput`/`ChatInput` was likely replaced. | **Deleted (2026-07-31)** — dead component, re-verified zero importers. |
| `src/ui/hooks/cursor.ts` — `usePromptTerminalCursor`, `visualWidth`, `strWidth`, `cursor*`, `bracketedPaste*`, `getPromptCursorPlacement` | standalone | Nothing imports `hooks/cursor`. (`visualWidth` exists again as a separate local def in `MarkdownTable.tsx` — not this module.) | **Deleted (2026-07-31)** — re-verified zero importers. |
| `src/ui/core/loading-text.ts` — `buildLoadingText`, `LoadingTextInput` | standalone | Reachable only via the dead `core/index.ts` barrel wildcard; no direct importer. | **Deleted (2026-07-31)** — removed together with the dead barrel. |
| **Dead barrels** (re-export shells nothing imports through): `src/ui/core/index.ts`, `src/ui/hooks/index.ts` | barrels | Every underlying module is imported by its **direct path**, never via the barrel; nothing imports `core/index.js` or `hooks/index.js`. | **Deleted (2026-07-31)** — both barrels removed; underlying modules with direct consumers kept. |
| `src/ui/components/index.ts` — partial | barrel | Only `ModelsDropdown` is consumed via the barrel (`App.tsx:51`). `DropdownMenu`/`DropdownMenuItem`, `SkillsDropdown`/`SkillInfo`, `FileMentionMenu`, `MessageView`/`MessageItem` have **no barrel consumer** (the components are imported directly from their own dirs where used). | **Pruned (2026-07-31)** — unused re-exports removed; only the `ModelsDropdown` line kept. |
| `src/permissions/index.ts` — `RuleOrigin` (type) | barrel re-export of `engine.js` | Only its definition (`rules.ts:11`) + two re-export lines reference it; imported by nothing. | **Deleted (2026-07-31)** — dropped the `RuleOrigin` re-export from `index.ts`. |

Barrels/modules confirmed **live**: `src/tools/index.ts`, `src/checkpoints/index.ts`,
`src/skills/index.ts`, `src/diagnostics/` (`DiagnosticRunner` instantiated at
`cli.tsx:171`), and the consumed permissions symbols (`PermissionEngine`,
`PermissionAction`, `PermissionConfig`, `PermissionRule`, `PatternKind`).

### (c) Documented-but-dead settings (`docs/config-spec.md`)

The example config block (`config-spec.md:80–90`) presents these as functional,
but per (a) they are consumed nowhere: `enabledSkills` (`:81`),
`compaction.auto` (`:85`), `workflow.gitCommands`/`gitStatus` (`:87`), `notify`
(`:88`), `debugLogEnabled` (`:89`), `telemetryEnabled` (`:90`). **Recommend:**
once each is wired or deprecated per (a), sync `config-spec.md` to match — either
mark them in the Deprecated-Keys table or document the now-real behavior. Don't
leave the doc advertising no-ops.

### (d) UI props/state set-but-never-read (spot check)

- **`AppContext.workflowConfig`** — the standout: assembled from four config
  keys, set on ctx, threaded through `AppProps`, and read by **nothing** (covered
  in (a)). This is the clearest set-but-never-read case in the UI.

*(Spot check only, per scope — not an exhaustive prop-level sweep.)*
