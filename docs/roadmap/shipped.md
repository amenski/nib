# Roadmap — shipped waves

**Status:** split out of [improvement-roadmap.md](../improvement-roadmap.md) on 2026-10-13 · history; each item is ✅ with its commit hash.

## ✅ Shipped — the 2026-07-31 → 08-01 wave

The do-now list in [improvement-roadmap.md](../improvement-roadmap.md) is now mostly landed. Recording what shipped, with commit
handles, so this doc reflects reality rather than intent:

| Shipped item | Date | Commit(s) | Owning spec |
|---|---|---|---|
| `docs_search` tool (keyless official-API search; general web via MCP) | 07-31 | `1e33ff7` | [web-search-spec.md](../web-search-spec.md) — removed 2026-08-10, subsumed by `web_search` |
| `web_search` tool (general web search via Bing RSS; guarded-tier) | 08-10 | `9e23197` | [web-search-spec.md](../web-search-spec.md) |
| Theme foundation: real `detectSystemTheme` + gutter/prompt theme-slot contrast | 07-31 | `4b51424`, `854cd41` | [theme-spec.md](../theme-spec.md) |
| Theme presets (dracula, monokai, github-dark, github-light) | 07-31 | `c83f07c` | [theme-spec.md](../theme-spec.md) |
| `/theme` runtime switcher (live preview, Esc-revert, persist) | 08-01 | `341334c` | [theme-spec.md](../theme-spec.md) |
| Remaining hardcoded accents routed through theme slots (accent sweep) | 07-31 | `37875f0` | [theme-spec.md](../theme-spec.md) |
| **T11** — permission engine wired into headless exec mode | 07-31 | `9656e75` | [permission-spec.md](../permission-spec.md) |
| `strictMcpConfig` command allowlist + settings→`connectMCPServers` wiring | 07-31 | `3d5b6c4`, `21bb982` | [security-spec.md](../security-spec.md) |
| Auth ergonomics: masked key input, `--api-key`, piped-stdin | 07-31 | `66e1df6` | [provider-spec.md](../provider-spec.md) |
| Credentials fix — unify config read path with auth's `credentials.yaml` | 07-31 | `7840ba5` | [config-spec.md](../config-spec.md) |
| Hierarchical project rules (`.nib/rules/**`, recursive, scoped) | 07-31 | `7290aab` | [rules-spec.md](../rules-spec.md) |
| Session observability — permission audit trail + per-turn token-usage log | 08-01 | `78f3b01` | [session-spec.md](../session-spec.md) |
| QA wave B1–B6 + docs alignment (cli-spec / config-spec / README; `/new`+`/plan` routing; resume-by-ID; help/palette advertise only working commands; clean exec errors; `env.BASE_URL` override) | 07-31 | `04da259`, `5bd15e9`, `6e6e57e`, `4fe4275`, `4febc94`, `5ffb588` | cli-spec / config-spec |
| CI lockfile fix — regenerate against public npm registry | 08-01 | `e72047f` | — |

This closes **Phases 1–3** of the [logging plan](./logging-plan.md) (audit trail, token-usage
log, hierarchical rules) plus the entire `/theme` phasing from the #132 section.

## ✅ Shipped — the 2026-08-02 → 08-08 wave

The previous "in-flight" wave has landed in full, plus a second wave of local
findings. Verified against the code on 2026-08-08 (not from memory):

| Shipped item | Evidence |
|---|---|
| **Checkpoint git identity** | `-c user.name=nib` / `user.email=nib@local` in `src/checkpoints/index.ts:21-22`. |
| **Dist mode-YAML packaging** | `dist/builtin/*.yaml` present; `ModeLoader` resolves via `import.meta.url`, so the published bundle finds them. |
| **`notify`** | `fireNotify` called from both the interactive (`cli.tsx`) and headless (`exec-runner.ts`) completion boundaries. |
| **`statusline`** | `src/ui/statusline/` consumed by the TUI. |
| **Input-stall fix (`<Static>`)** | Committed output moved to Ink `<Static>` in `OutputArea.tsx` — closes the [input-stall-diagnosis.md](../input-stall-diagnosis.md) item. |
| **`ErrorRecovery` / `ErrorReflector` / `RepoMap`** | All three now constructed and threaded into the agent context — no longer orphan subsystems. |
| **Config keys wired** | `enabledSkills` (honored by `SkillLoader`), `compaction.auto` (gates auto-compaction, `cli.tsx:175`), `workflow.gitPollInterval` (read by the poller, `App.tsx:314`). |
| **`web_fetch` tool** | HTTPS-only fetch → Readability/Turndown markdown, SSRF guard re-run per redirect hop, control-char sanitization, untrusted-content wrapper, domain-scoped permissions. Specs: [tool-spec.md](../tool-spec.md), [security-spec.md](../security-spec.md) T13/T14. |
| **Compaction keep-boundary** | `keepBoundary()` shared by auto-compaction and `/compact`; stops the boundary splitting an assistant `tool_calls` message from its results (a hard 400 on strict providers). See [subsystems/context-management.md](../subsystems/context-management.md). |
| **CLI flag surface** | `--exec`→`-p/--print`, `--last`→`-c/--continue`, positional prompt, `auth`/`doctor` subcommands, `/compact`. **Breaking** for scripts. [cli-spec.md](../cli-spec.md). |
| **Word-level input navigation** | Option+←/→ and Option+Backspace; root cause was a dropped modifier param in the CSI parser, plus undecoded `ESC b`/`ESC f`. |
| **System-prompt fixes** | Duplicate identity line removed, untrusted-content rule added, structured compaction prompt, plan-mode tool filtering. [system-prompt.md](../system-prompt.md). |

### 🚧 Still in-flight

| Item | What it is | Notes |
|---|---|---|
| **Streaming-markdown refactor** | `src/ui/core/stream-blocks.ts` + `markdown-inline.ts`, rewriting `MarkdownText`/`App` streaming. | Started 2026-08-08. Must preserve two earlier fixes it supersedes: holding back a line whose inline span (`**`, `` ` ``, `~~`) hasn't closed yet, and keeping the block-start `●` out of the raw markdown so headings/lists still parse. |
| **Sessions index** | A queryable index over the JSONL session store (list/resume ergonomics, observability). | **✅ Shipped** — `sessions-index.json` (`src/sessions/store.ts`, `updateIndexEntry`/`rebuildIndex`), consumed by `list()`; verified 2026-08-13. Optional polish (search in the picker) is unplanned — see feature-plans.md §11. |

## ✅ Shipped — the 2026-10-11 → 10-12 wave (v0.6.0)

Released as v0.6.0 on GitHub, npm and Homebrew (`amenski/tap/nib`) on
2026-10-12. Items found from real use, not from the [borrow list](../improvement-roadmap.md):

| Shipped item | Evidence |
|---|---|
| ~~**`nib mcp add / list / remove`**~~ ✅ | Adds MCP servers without editing JSON; writes global settings (`216a4fa`). |
| ~~**Per-server MCP sandbox opt-out**~~ ✅ | `mcpServers.<name>.sandbox: false`, global-only; Playwright MCP aborts under Seatbelt, works with it (`216a4fa`). |
| ~~**MCP tools in Code mode**~~ ✅ | Code mode now grants the `mcp` tool group (`43493f3`). |
| ~~**Outbound network for sandboxed commands**~~ ✅ | On by default, IP-scoped; Unix sockets stay blocked (`edf3763`). |
| ~~**Draft survives a permission prompt**~~ ✅ | Composer suspended instead of unmounted; 0.5 s option-key guard over a draft (`6b8c597`). |
| ~~**`/skill` runs on Enter**~~ ✅ | Picker fills the input; Enter clears it and starts the skill (`c261ccd`). |
| ~~**`/clear` clears the screen; `/compact` shows progress**~~ ✅ | (`382362b`). |
| ~~**Readable tool names**~~ ✅ | `Update Todos`, `Fetch`, `server · tool`; PascalCase fallback (`624baa8`). |
| ~~**Transcript spacing**~~ ✅ | One blank row between blocks; gap above the todo list and queued stack (`efb8a40`, `382362b`). |
| ~~**Single dark theme, readable on light terminals**~~ ✅ | (`48ba4d7`, `0f5c72f`). |
| ~~**README refresh**~~ ✅ | 0.6.0 interface, sandbox, `nib mcp`, new screenshot (`596ec87`, `27fbdb2`). |

Fixed after the tag (Unreleased, ships in 0.6.1):

| Shipped item | Evidence |
|---|---|
| ~~**Declining folder trust exits**~~ ✅ | "No"/Esc quits instead of one prompt per skill (`00a41ca`). |
| ~~**Skills folder without `SKILL.md` skipped quietly**~~ ✅ | (`64c5e41`). |
| ~~**`web_search` / `web_fetch` network on by default**~~ ✅ | `workspace-write` was default-deny with an empty allowlist; a non-empty `allow` list still means only those hosts (`9d5c88d`). |
| ~~**Picking `/model` clears the typed command**~~ ✅ | The composer stays mounted behind modals, so the `model` menu branch needed its own `resetInput()` (`f9f7524`). |
| ~~**Typing guard sees a just-typed draft**~~ ✅ | `PromptInput` reports the draft synchronously from `updateBuffer`; the effect alone lagged Ink's paint (`02d1197`). |
