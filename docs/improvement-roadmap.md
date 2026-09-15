# Improvement Roadmap

**Status:** forward-looking roadmap · refreshed 2026-08-08 · not a spec — shipped items are marked ✅ with commit hashes; unshipped items are plans, not behavior.

> **Remaining items now have detailed plans.** The open items below were
> researched against Claude Code, Codex, Gemini CLI, aider, and opencode on
> 2026-08-13 and written up feature-by-feature with designs and decision
> points in [feature-plans.md](./feature-plans.md) — that doc is the current
> work queue; this one records history and the borrowed-idea backlog.


Status (**refreshed 2026-08-08**): **the entire do-now tier and the whole
in-flight wave have shipped.** What remains is the design-first tier — items
that need a decision or a design doc before any code, plus a handful of small
follow-ons. This started as a review of several `lessweb/deepcode-cli` PRs for
ideas worth bringing into Nib, adapted to its architecture and ethos.
**We are not doing all of this** — the table below sorts each idea into
**do-now / roadmap / reject**. Detailed per-PR analysis follows; once an item
is picked up and built, its behavior moves into the matching subsystem spec
(e.g. [session-spec.md](./session-spec.md),
[permission-spec.md](./permission-spec.md)).

> **Blind spot worth naming.** This doc was derived from reviewing *other
> people's PRs*, so it tracks what deepcode-cli built — not what Nib's own
> use surfaces. Two of the highest-value gaps found from real usage appear
> nowhere below: **mid-turn steering** (inject a message into a running turn
> instead of losing it to Esc) and **background/streaming command output** (a
> dev server or long test run currently ties up the tool call). Treat the
> roadmap tier as "ideas borrowed", not "everything worth doing".

PRs reviewed: [#266](https://github.com/lessweb/deepcode-cli/pull/266) ·
[#263](https://github.com/lessweb/deepcode-cli/pull/263) ·
[#225](https://github.com/lessweb/deepcode-cli/pull/225) ·
[#216](https://github.com/lessweb/deepcode-cli/pull/216) ·
[#132](https://github.com/lessweb/deepcode-cli/pull/132)

---

## TL;DR — the borrow list, ranked

Recurring theme: these PRs are worth mining for **ideas**, rarely for **code** —
several put keys in config or data in SQLite/plaintext in ways that cut against
Nib's stated ethos, and a few duplicate things Nib already does
better. Pick the small, high-value, on-ethos wins first; park the big
architectural swings on the roadmap; drop the rest.

### ✅ Do now — small, high-value, on-ethos

| Item | Source | Effort | Why now |
|---|---|---|---|
| ~~**`/theme` command** (live preview, Esc-revert, persist)~~ ✅ **shipped 2026-08-01** | #132 | S–M | Runtime switcher with live preview + persist landed (`341334c`); mirrors the `/model` dropdown. |
| ~~**Fix `detectSystemTheme` stub**~~ ✅ **shipped 2026-08-01** | #132 | S | COLORFGBG + macOS `AppleInterfaceStyle` detection, injectable + tested; `auto` works. |
| ~~**Permission audit trail** (JSONL sidecar)~~ ✅ **shipped 2026-08-01** | #266 | S | Every allow/deny/ask + reason recorded to the session store (`78f3b01`). Core of "permission saving." |
| ~~**Masked key input + `--api-key`/piped stdin** for `auth`~~ ✅ **shipped 2026-08-01** | #225 | S | Masked entry, `--api-key`, and piped-stdin all landed (`66e1df6`); key still → `credentials.yaml`, never config. |
| ~~**`strictMcpConfig`** MCP command allowlist~~ ✅ **shipped 2026-08-01** | #263 | S | Allowlist + settings wiring into `connectMCPServers` (`3d5b6c4`, `21bb982`). |
| ~~**Token-usage log + in-memory metrics**~~ ✅ **shipped 2026-08-01** (log); metrics counters remain | #266, #263 | S | Per-turn token-usage log landed with the audit trail (`78f3b01`); the accept/reject counters + exit-summary surfacing are the remaining slice — see newly-known. |
| ~~**Extra theme presets** (dracula, monokai, github, ansi)~~ ✅ **shipped 2026-08-01** (dracula/monokai/github ×2); ansi ×2 pending | #132 | S | dracula, monokai, github-dark, github-light re-expressed in `ThemeDefinition` shape (`c83f07c`); `ansi-light`/`ansi-dark` still to add — see newly-known. |
| ~~**Gutter/prompt contrast fix**~~ ✅ **shipped 2026-08-01** | local | S | Gutter + permission/ask prompts routed through tuned theme slots (dark 39/33, light 26/27); border-focus bug fixed. Remaining `#229ac3` in menus/PromptInput listed for a follow-up pass. |
| ~~**Long→short flag map** for destructive rules~~ ✅ **shipped 2026-08-02** | local | S | `rm` map landed in the prior wave; this wave extended it to `git` (`--force`/`--directory`/`--ignored`), closing the `git clean --force -dx` escape. See [security-destructive-matching.md](./security-destructive-matching.md). |
| ~~**`docs_search` tool**~~ ✅ **shipped 2026-08-01** | local | M | Keyless official-API search, live-smoke verified; general web via MCP. Spec: [web-search-spec.md](./web-search-spec.md). **Removed 2026-08-10 — subsumed by `web_search`.** |
| ~~**`web_search` tool**~~ ✅ **shipped 2026-08-10** | local | M | Built-in general web search via Bing `format=rss` (keyless, one pinned host); guarded-tier permission, headless-deny. Spec: [web-search-spec.md](./web-search-spec.md). |
| ~~**Hierarchical project rules** (`.nib/rules/**`)~~ ✅ **shipped 2026-08-01** | #266 | M | Recursively-loaded scoped rule sections injected alongside `instructions.md`/`AGENTS.md` (`7290aab`). Promoted from Roadmap. |

> **Local (non-borrow) findings** also tracked in their own docs, with priorities:
> the two rows above are the do-now items; the input-stutter fix
> ([input-stall-diagnosis.md](./input-stall-diagnosis.md), move committed output
> to Ink `<Static>`) is a medium roadmap item; an OS sandbox
> ([security-destructive-matching.md](./security-destructive-matching.md)) is the
> large, model-changing one.

### 🗺️ Roadmap — valuable but bigger / needs its own decision

| Item | Source | Effort | Why later |
|---|---|---|---|
| **PermissionProfile ACL model** (path/network/git sandbox) | #263 | L | A *parallel* permission architecture to the current rule engine — needs its own design doc + a reconcile-or-migrate decision. |
| ~~**Sub-task orchestration**~~ (`new_task` tool, `src/orchestrator/`) ✅ **wired 2026-08-11** · **design doc + tagged audit shipped 2026-08-13** | — | L | `new_task` is mounted in both the TUI (`cli.tsx:181–189`) and headless `-p` (`exec-runner.ts:141–150`) registries; sub-agents run a real `runAgent` turn in the target mode's toolset, inherit the parent's live permission engine (rules + approval posture, no escalation) and per-spawn provider factory (follows `/model` switches). Enforcement: depth cap 3, max 10 sub-agent turns. The inheritance/recursion design doc is [subsystems/orchestration.md](./subsystems/orchestration.md) §7; sub-agent audit/token rows now land in the parent session tagged `source: "subagent"` (session-spec.md). |
| ~~**Hierarchical project rules** (`.nib/rules/**`)~~ ✅ **shipped 2026-08-01** (`7290aab`) | #266 | M | Additive to `instructions.md`/`AGENTS.md`; landed — promoted to Do-now shipped list. |
| ~~**Auto error-fix loop + `<error_analysis>`**~~ ✅ **shipped 2026-08-15** | #266 | M | Audited → build-the-delta: `run_bash` non-zero+stderr exits now set `error` and prepend a grepped `<error_analysis>` block; retry-cap exhaustion fires an escalation diagnostic. |
| **Lifecycle hooks** (shell on events) | #263 | M | Powerful but another untrusted-exec surface — opt-in + security-spec first. Highest-leverage of the remaining roadmap tier. |
| **Mid-turn steering** | local (usage) | M | Inject a message typed during a running turn into the live agent loop, instead of the user losing the turn to Esc. Pairs with input queueing (buffer a message typed mid-turn, send it next). Not from any PR — surfaced by real use. |
| **Background / streaming command output** | local (usage) | M | Long `run_bash` calls (test suites, builds, dev servers) need live output in the transcript and a background+poll mode; today a dev server ties up or times out the tool call. Not from any PR — surfaced by real use. |
| **`/usage` balance command** (generalized adapter method) | #216 | M | Only worth it provider-agnostic (`getBalance()` on the adapter), else DeepSeek-only special-case. |
| **React exit-summary view** | #132 | S–M | Robustness fix (survives scroll); orthogonal to everything else. |
| **SQLite log backend** | #266 | L | Only if JSONL logs prove they need cross-session SQL. Off-ethos (opaque binary sessions). |

### ❌ Reject — importing would be a downgrade or off-ethos

| Item | Source | Why not |
|---|---|---|
| PR's `ThemeTokens` model / `resolver.ts` | #132 | Nib's theme model is **strictly richer** and already integrated. |
| `buildLoginSettings` writing the key into `settings.json` | #225 | Nib keeps keys out of config (`credentials.yaml`, chmod 600). Take the ergonomics, not this. |
| Wholesale cherry-pick of #263 | #263 | Branch has a **literal unresolved Git merge-conflict marker** in `permissions.ts`. Reimplement ideas, don't lift. |
| `job-queue.ts`, `skill-parser.ts` | #263 | Out of scope for these goals (background exec / skill-frontmatter tied to PermissionProfile). |
| Vendored `cli.js` blob, Python skill templates, prompt-text | #266/#263 | Noise / go through Nib's own system-prompt change protocol. |

---

## ✅ Shipped — the 2026-07-31 → 08-01 wave

The do-now list above is now mostly landed. Recording what shipped, with commit
handles, so this doc reflects reality rather than intent:

| Shipped item | Date | Commit(s) | Owning spec |
|---|---|---|---|
| `docs_search` tool (keyless official-API search; general web via MCP) | 07-31 | `1e33ff7` | [web-search-spec.md](./web-search-spec.md) — removed 2026-08-10, subsumed by `web_search` |
| `web_search` tool (general web search via Bing RSS; guarded-tier) | 08-10 | `9e23197` | [web-search-spec.md](./web-search-spec.md) |
| Theme foundation: real `detectSystemTheme` + gutter/prompt theme-slot contrast | 07-31 | `4b51424`, `854cd41` | [theme-spec.md](./theme-spec.md) |
| Theme presets (dracula, monokai, github-dark, github-light) | 07-31 | `c83f07c` | [theme-spec.md](./theme-spec.md) |
| `/theme` runtime switcher (live preview, Esc-revert, persist) | 08-01 | `341334c` | [theme-spec.md](./theme-spec.md) |
| Remaining hardcoded accents routed through theme slots (accent sweep) | 07-31 | `37875f0` | [theme-spec.md](./theme-spec.md) |
| **T11** — permission engine wired into headless exec mode | 07-31 | `9656e75` | [permission-spec.md](./permission-spec.md) |
| `strictMcpConfig` command allowlist + settings→`connectMCPServers` wiring | 07-31 | `3d5b6c4`, `21bb982` | [security-spec.md](./security-spec.md) |
| Auth ergonomics: masked key input, `--api-key`, piped-stdin | 07-31 | `66e1df6` | [provider-spec.md](./provider-spec.md) |
| Credentials fix — unify config read path with auth's `credentials.yaml` | 07-31 | `7840ba5` | [config-spec.md](./config-spec.md) |
| Hierarchical project rules (`.nib/rules/**`, recursive, scoped) | 07-31 | `7290aab` | [rules-spec.md](./rules-spec.md) |
| Session observability — permission audit trail + per-turn token-usage log | 08-01 | `78f3b01` | [session-spec.md](./session-spec.md) |
| QA wave B1–B6 + docs alignment (cli-spec / config-spec / README; `/new`+`/plan` routing; resume-by-ID; help/palette advertise only working commands; clean exec errors; `env.BASE_URL` override) | 07-31 | `04da259`, `5bd15e9`, `6e6e57e`, `4fe4275`, `4febc94`, `5ffb588` | cli-spec / config-spec |
| CI lockfile fix — regenerate against public npm registry | 08-01 | `e72047f` | — |

This closes **Phases 1–3** of the logging plan below (audit trail, token-usage
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
| **Input-stall fix (`<Static>`)** | Committed output moved to Ink `<Static>` in `OutputArea.tsx` — closes the [input-stall-diagnosis.md](./input-stall-diagnosis.md) item. |
| **`ErrorRecovery` / `ErrorReflector` / `RepoMap`** | All three now constructed and threaded into the agent context — no longer orphan subsystems. |
| **Config keys wired** | `enabledSkills` (honored by `SkillLoader`), `compaction.auto` (gates auto-compaction, `cli.tsx:175`), `workflow.gitPollInterval` (read by the poller, `App.tsx:314`). |
| **`web_fetch` tool** | HTTPS-only fetch → Readability/Turndown markdown, SSRF guard re-run per redirect hop, control-char sanitization, untrusted-content wrapper, domain-scoped permissions. Specs: [tool-spec.md](./tool-spec.md), [security-spec.md](./security-spec.md) T13/T14. |
| **Compaction keep-boundary** | `keepBoundary()` shared by auto-compaction and `/compact`; stops the boundary splitting an assistant `tool_calls` message from its results (a hard 400 on strict providers). See [subsystems/context-management.md](./subsystems/context-management.md). |
| **CLI flag surface** | `--exec`→`-p/--print`, `--last`→`-c/--continue`, positional prompt, `auth`/`doctor` subcommands, `/compact`. **Breaking** for scripts. [cli-spec.md](./cli-spec.md). |
| **Word-level input navigation** | Option+←/→ and Option+Backspace; root cause was a dropped modifier param in the CSI parser, plus undecoded `ESC b`/`ESC f`. |
| **System-prompt fixes** | Duplicate identity line removed, untrusted-content rule added, structured compaction prompt, plan-mode tool filtering. [system-prompt.md](./system-prompt.md). |

### 🚧 Still in-flight

| Item | What it is | Notes |
|---|---|---|
| **Streaming-markdown refactor** | `src/ui/core/stream-blocks.ts` + `markdown-inline.ts`, rewriting `MarkdownText`/`App` streaming. | Started 2026-08-08. Must preserve two earlier fixes it supersedes: holding back a line whose inline span (`**`, `` ` ``, `~~`) hasn't closed yet, and keeping the block-start `●` out of the raw markdown so headings/lists still parse. |
| **Sessions index** | A queryable index over the JSONL session store (list/resume ergonomics, observability). | **✅ Shipped** — `sessions-index.json` (`src/sessions/store.ts`, `updateIndexEntry`/`rebuildIndex`), consumed by `list()`; verified 2026-08-13. Optional polish (search in the picker) is unplanned — see feature-plans.md §11. |

## 🆕 Newly-known items (surfaced during the wave)

Small, concrete follow-ons discovered while shipping the above. Not yet scheduled;
captured so they aren't lost:

| Item | What / why |
|---|---|
| ~~**`ThemeableStatic` + input-stall pair**~~ **half shipped** | The `<Static>` move landed (see the 08-02→08-08 wave). What remains is only `ThemeableStatic`: re-mounting `<Static>` on theme change so a live `/theme` preview repaints existing scrollback. |
| **`/usage` command** | Provider-agnostic balance view via a `getBalance()` adapter method (see PR #216 section). **Confirmed still unbuilt** (no `getBalance` on any adapter, no `/usage` command); `/theme` established the bordered-view+Esc pattern it would reuse. |
| ~~**Exit-summary React view**~~ **obsolete** | `src/ui/exit-summary.ts` no longer exists — superseded by the exit-collapse-to-resume-hint change (`a61733b`), which removed the direct-`stdout.write` path entirely. The **telemetry accept/reject counters** still need a home; re-home them rather than reviving this. |
| **Audit refinements — remainder** | (a) **allow-by-posture emission** — the canonical decision value still isn't written by `agent.ts` (the audit closure lacks posture visibility; needs plumbing, deferred with the exit-summary wave). Color/label coverage for all canonical values + **double-row dedup** ✅ **shipped 2026-08-02**. |
| ~~**Doctor: `credentials.json` label**~~ ✅ **shipped 2026-08-02** | `doctor` diagnostics now print `credentials.yaml`, the real file. |
| ~~**`ansi-light` / `ansi-dark` presets**~~ ✅ **shipped 2026-08-02** | Both ANSI presets (base-16 only, "dumb-terminal" variants of dark/light) added in `ThemeDefinition` shape; `/theme` picker auto-adopts them. |
| ~~**Plan-mode research read**~~ ✅ **shipped 2026-08-02** | Plan mode now loads `.nib/research/**/*.md` (the `.deepcode/docs/research/` path from the original note is stale — the repo renamed its config namespace to `.nib`) and injects it into the volatile plan-mode context each turn. |
| **CodeArtifact-URL-in-git-history scrub — decision** | A CodeArtifact registry URL leaked into git history (via a lockfile now fixed forward in `e72047f`). Decide whether to history-scrub (rewrite) or leave-and-document; it is a URL, not a secret. Owner decision pending. |

---

## Where the ideas came from

PR #266 in `deepcode-cli` bundles a lot of unrelated things (a 105k-line
vendored `cli.js` blob, a set of Python "skill" templates). Ignore those. The
genuinely reusable core is five concepts, all in
`packages/core/src/common/session-log.ts` and the `session.ts` diff:

| # | Concept | Summary |
|---|---------|---------|
| 1 | **Structured session log** | Per-session store of typed events (`agentMessage`, `toolCall`, `permission`, `system`), queryable. |
| 2 | **Permission audit trail** | Every allow/deny/ask decision recorded with tool, scopes, decision, reason — plus a history query. |
| 3 | **Token-budget audit** | Per-turn token rows (`turn`, `total`, `max`, `remaining`); "budget left" query. |
| 4 | **Auto error-fix loop** | On tool failure, inject a "don't move on — fix it" reminder; retry ≤3× then escalate. Bash output gets a grepped `<error_analysis>` header. |
| 5 | **Hierarchical project rules** | `.nib/rules/**/*.md` recursively loaded, injected as scoped rule sections. |

The PR's original design persists all of this to a **SQLite database** (`sql.js`,
pure-WASM) with tables `session_logs`, `token_budget`, `permission_audit`,
`checkpoints`, 30s auto-save, and 7-day auto-cleanup.

---

## What Nib already has (gap analysis)

| PR concept | Nib today | Actual gap |
|---|---|---|
| Session log | Append-only **JSONL** per session — `SessionStore`, `~/.nib/sessions/<slug>/<id>.jsonl`, records typed `meta \| message \| state \| compaction` (`src/sessions/store.ts`). | Not the *store* — the **queryability** and the *event types* (permission, token). |
| Permission saving | Approved rules **persist** to `.nib/settings.json` via atomic write (`engine.ts: approveAlways → persist`). | No **audit trail**: denies, one-time allows, and the *reason* a decision was made are never recorded. |
| Token budget | `estimateTokens` / `shouldCompact` drive compaction (`src/compaction/budget.ts`). | Usage is **never recorded** per turn; no history, no "remaining" surfaced. |
| Auto error-fix | `src/errorrecovery/` + `src/selfreflection/` already exist. | Possible **overlap** — must audit before porting, or we duplicate. |
| Project rules | Single `.nib/instructions.md` / `AGENTS.md`. | No **directory of scoped rules**. Additive. |

Net: the two things you specifically asked for — **session-log saving** and
**permission saving** — are *partly* already present. The new value is the
**audit trails** (permission decisions + token usage) and, optionally,
**queryability**.

---

## The gating decision: SQLite vs. JSONL

Everything downstream depends on this. Nib's README promises "no magic,
every layer independently readable and replaceable" and "sessions are plaintext
files under `~/.nib/`." Adopting SQLite pushes against that.

### Path A — Keep JSONL, add typed sidecar logs  ← **recommended**

- New event types written to the existing session JSONL (or sibling
  `permission-audit.jsonl` / `token-usage.jsonl` files).
- Everything stays grep-able plaintext.
- "Query" = read the file + filter in JS. Fine at single-user, few-hundred-turn
  scale.
- **No new dependency**, on-ethos, low risk.
- Adopt the PR's **table schemas as the data model** — the columns are
  well-designed — just serialize each row as one JSON line instead of a SQL row.

### Path B — Adopt `sql.js` (as the PR does)

- Real SQL: `json_extract`, indices, computed `remaining` column, cross-session
  queries.
- **Costs:** a WASM dependency; session data becomes an opaque binary `.db`
  (breaks the plaintext promise in `security-spec.md`); a save / WAL / lifecycle
  layer with a `process.on("exit")` flush; 7-day auto-deletion of history.
- Higher risk, off-ethos. Buys queryability that single-user scale may never
  need.

**Recommendation: Path A.** Take the PR's data model, not its storage engine.
Revisit Path B only if #1–#3 prove a real need for cross-session SQL. The rest
of this plan assumes Path A.

---

## Proposed data model (Path A serialization)

One JSON object per line. Reuse the existing `SessionRecord` envelope
(`{ type, at, ... }`) so these ride in the session JSONL, or split into sidecar
files keyed by session id — decide per phase.

**Permission decision**
```jsonc
{ "type": "permission", "at": "<iso>",
  "toolCallId": "…", "tool": "run_bash",
  "subject": "rm -rf build",          // the literal command / path matched
  "decision": "deny",                 // "allow" | "deny" | "ask-once" | "session" | "always"
  "winningRule": { "tool": "…", "kind": "exact", "pattern": "…", "origin": "…" },
  "reason": "user denied at prompt" }
```

**Token usage (per turn)**
```jsonc
{ "type": "token", "at": "<iso>",
  "turnTokens": 4210, "totalUsed": 88123, "budgetMax": 200000 }
// remaining is derived (budgetMax - totalUsed), not stored
```

---

## Phased plan (each phase independently shippable + verifiable)

### Phase 1 — Permission audit trail  *(highest value, smallest surface)* — ✅ shipped 2026-08-01 (`78f3b01`)
- Emit a `permission` record at every decision point in
  `src/permissions/engine.ts` (`resolve` + the `approveForSession` /
  `approveAlways` / deny / one-time paths).
- Add a read-side query (`queryPermissionHistory(sessionId)`) and a
  `/permissions history` view in the TUI.
- **Verify:** deny, always-allow, session-allow, and one-time each produce one
  correct row with the right `decision` and `winningRule`.

### Phase 2 — Token-usage log — ✅ shipped 2026-08-01 (`78f3b01`)
- After each turn in `src/agent.ts`, record `{ turnTokens, totalUsed,
  budgetMax }` (reuse `estimateTokens`).
- Surface "remaining" in the status bar and/or a query.
- **Verify:** rows accumulate per turn; remaining math agrees with the value
  compaction already computes.

### Phase 3 — Hierarchical project rules — ✅ shipped 2026-07-31 (`7290aab`)
- Loader for `.nib/rules/**/*.md`, recursively, scoped by subdirectory
  (mirror the PR's `loadProjectRules`), injected alongside the existing
  `instructions.md` / `AGENTS.md`.
- **Verify:** a nested rule file (`rules/api/naming.md`) appears as a scoped
  section in the system prompt.

### Phase 4 — Auto error-fix + `<error_analysis>` — ✅ shipped 2026-08-15 (build-the-delta)
- **Audit verdict (2026-08-15): build-the-delta** — ~70% overlap. Already
  present and threaded into the loop: the ≤3 retry cap and the tool-error
  fix-reminder (`src/selfreflection/`) plus the loop guards
  (5-consecutive-failure, identical-call). The gap: `run_bash` non-zero exits
  only set `content`, never `error` — so none of that machinery engaged for
  the most common failure class — and no `<error_analysis>` header existed.
- **Delta shipped:** (1) `run_bash` non-zero exits **with non-empty stderr**
  now set `error: "Exit code: N"` and prepend a compact grepped
  `<error_analysis>` block (last ≤20 stderr lines matching
  `error|failed|fatal|exception|undefined|no such|unable|cannot`, plus the
  exit line; omitted when nothing matches) — silent non-zero exits
  (`grep -q`/`diff`/test idioms) stay content-only, no error; (2) when the
  reflector's retry cap is exhausted, the agent fires
  `onDiagnostic("retry cap exhausted — escalating")`.
- **Verify:** tsc clean; a failing bash command triggers exactly one
  fix-retry cycle, not an infinite loop; escalates after the cap
  (bash.test.ts + agent.test.ts).

### Phase 5 — SQLite (optional, deferred)
- Only if #1–#3 demonstrate a real need for cross-session SQL queries. Adopt
  `sql.js` with the PR's four-table schema. Treat as a separate, opt-in storage
  backend behind the same read/write API, so JSONL stays the default.

---

## Sequencing & caveats

- **Separate workstream** from the in-flight README / CI / LICENSE changes
  currently uncommitted in the tree.
- `src/ui/App.tsx` is mid-refactor (permission-prompt model). Phase 1 touches
  permission code — land after App.tsx settles to avoid collisions.
- Your explicit ask was **session-log saving + permission saving** → **Phases 1
  and 2 are the core.** Phases 3–5 are optional follow-ons.
- Each phase, once built, updates its owning spec
  ([session-spec.md](./session-spec.md) / [permission-spec.md](./permission-spec.md))
  per the repo's one-spec-per-subsystem convention.

---

## PR #263 additions

#263 is titled "structured telemetry metrics, strict MCP config mode, and
PermissionDecision types," but the diff carries **more than the title admits**.
Ignoring the shared noise (blob + Python skills + the duplicate `session-log.ts`),
here's everything genuinely new, sorted by whether it's worth taking.

### ⚠ First, a health warning on the PR itself

`packages/core/src/common/permissions.ts` in this PR contains a **literal
unresolved Git merge-conflict marker** (`>>>>>>> ea93ba2 (…)`) left in the
source. So #263 is not a clean, mergeable branch — treat it as a **grab-bag of
ideas to reimplement**, never as something to cherry-pick wholesale.

### New modules and how they map to Nib

| Module (in #263) | What it is | Verdict for Nib |
|---|---|---|
| **`permission-profile.ts`** (+335) | A structured, ACL-style permission model (Codex "PermissionProfile"): `unrestricted \| legacy \| managed`, path-level `read/write/deny` entries with glob matching, plus network + git sub-permissions and preset profiles (`STRICT_SANDBOX`, `DEFAULT_DEV`). Self-contained glob engine, no deps. | **Strongest idea in the PR.** But it's a *parallel* permission system to Nib's existing rule engine (`src/permissions/engine.ts`), not a drop-in. Adopting it is a **permission-model redesign**, not an add-on — big decision, own workstream. See below. |
| **`telemetry.ts` metrics** (+87) | In-memory per-session counters: permission accept/reject counts, and `ToolUsageMetrics` (cost USD, API duration, lines added/removed, tool calls). Get/reset API. | **Cheap and useful.** Pure in-memory, no deps, no storage. Pairs naturally with Phase 2 (token log) — surface in an exit summary / status line. Nib already has `src/ui/exit-summary.ts` to extend. |
| **`strictMcpConfig`** (mcp-manager +29, settings +32) | A `--strict-mcp-config`-style flag: when on, MCP servers may only launch from an allowlisted command (`npx`, `node`, `python3`, `uvx`, `bun`, `deno`, `go`, `java`); anything else is blocked with a descriptive error. | **Take it — small, real security win.** Nib has `src/mcp/` and treats MCP tools as untrusted (per security-spec). A command allowlist is a clean, low-risk hardening. ~30 lines + a settings key. |
| **`hooks.ts`** (+76) | A lifecycle-hook dispatcher: user-configured shell commands fired on events (`beforeWrite`, `afterWrite`, `beforeCommand`, `onError`, `onSessionStart`, `onCompact`, …) with `{placeholder}` substitution. | **Attractive but security-sensitive.** This runs arbitrary shell on agent events — powerful (formatters, notifiers) but it's another untrusted-execution surface. Only behind explicit opt-in config, and document it in security-spec. Defer past the core phases. |
| **`compact.ts`** (+245) | A runtime content-compressor: smart JSON tool-result truncation (shrinks only the `output` field), binary detection, plain-text capping, plus lossy message-history summarization. | **Partial overlap** with Nib's `src/compaction/` + tool-result truncation in `src/tools/`. Mine it for the *smart-JSON-truncation* idea specifically; don't wholesale-import a second compaction path. |
| **`skill-parser.ts`** (+313) | Extended `SKILL.md` frontmatter parser: `agent.dependencies`, `agent.interface` (default prompt, brand color, screenshots), `agent.policy` (required permissions, allowed/denied paths → a PermissionProfile). Uses `gray-matter`. | **Only relevant if** the PermissionProfile model is adopted (its payoff is `skillPolicyToProfile`). Nib already parses Agent Skills (`src/skills/`); this is a superset tied to the profile system. Defer with it. |
| **`job-queue.ts`** (+361) | A generic child-process job queue: 3-phase spawn protocol, exponential-backoff retry, timeout, concurrency cap, event callbacks. | **Out of scope for the session-log goal.** Solves background/parallel task execution, unrelated to logging or permission saving. Note it exists; don't pull it in for this workstream. |
| **`AGENTIC_BEHAVIOR_PROMPT` / `TOOL_CHAINING_PROMPT`** (prompt.ts) | System-prompt text: the plan→execute→verify→auto-fix discipline, and a tool-chaining efficiency pattern. | **Compare, don't copy.** Nib has its own `src/prompt.ts` + `docs/system-prompt.md` with a change protocol. If any of this is wanted, it goes through that protocol, not a paste. |

### What this changes about the plan

- **Take now, cheap & on-goal:** `strictMcpConfig` (allowlist) and the
  **telemetry counters** (accept/reject + tool-usage). Both are small, dep-free,
  and reinforce Phases 1–2. Fold them in as **Phase 2.5**.
- **Big separate decision — PermissionProfile.** `permission-profile.ts` is the
  most valuable idea here, but it's an *alternative* permission architecture
  (path-level ACL + sandbox profiles) sitting beside Nib's rule-engine +
  approval-posture model. Choosing it means reconciling two models (or
  migrating). That deserves its **own design doc and its own decision**, not a
  bolt-on. Flagged, not scheduled.
- **Defer, security-sensitive:** `hooks.ts` (arbitrary shell on events) — only
  behind explicit opt-in, documented in security-spec.
- **Mine, don't import:** `compact.ts` (smart-JSON truncation idea only).
- **Out of scope here:** `job-queue.ts`, `skill-parser.ts` (unless
  PermissionProfile is adopted), prompt-text changes.

### Revised phase ordering (incorporating #263)

1. Permission audit trail *(#266)*
2. Token-usage log *(#266)*
2. **2.5 — `strictMcpConfig` allowlist + in-memory telemetry counters** *(#263, cheap wins)*
3. Hierarchical project rules *(#266)*
4. Auto error-fix + `<error_analysis>` *(#266)*
5. *(separate doc)* PermissionProfile ACL model — decide vs. current rule engine *(#263)*
6. *(deferred)* Lifecycle hooks *(#263)*; SQLite backend *(#266, optional)*

---

## PR #225 — login command

Unrelated to session logging. A small (515-line), **clean** PR — no vendored
blob, no merge markers — adding a `deepcode login` command that saves an API key
(and a ready-to-use default config) to `~/.nib/settings.json`.

### This is mostly overlap, not gap

Nib **already has** an auth flow: `auth` (interactive wizard), `auth list`,
`auth logout <provider>` in `src/auth/wizard.ts`, saving keys to
`~/.nib/credentials.yaml` (chmod 600). So #225 is not a missing feature —
but it does three things better than Nib's current wizard:

| #225 idea | Nib today | Take it? |
|---|---|---|
| **Non-interactive `--api-key` flag + piped-stdin fallback** | `authWizard` is interactive-only (`rl.question`); can't script or pipe a key. | **Yes** — real win for CI / headless / scripting. Small. |
| **Hidden, masked key input** (raw-mode `*`, Backspace / Ctrl+U / Ctrl+C aware, non-TTY fallback) | Key is typed in **plaintext** via `rl.question` — visible on screen and in scrollback. | **Yes** — genuine secret-handling improvement. `readHiddenLine` is a clean, dep-free reference. |
| **Seed a ready-to-use default config on login** (`buildLoginSettings` merges defaults, preserves existing fields) | `auth` writes only the credential; a brand-new user still has an empty `settings.json`. | **Partial** — take the *seed-defaults* idea, **not** the mechanism (see conflict below). |

### ⚠ Ethos conflict — do NOT copy the storage mechanism

#225 writes the API key **into `settings.json`** as `env.API_KEY`. Nib
deliberately does the opposite — the README states **"Keys never go in config —
env vars or the `auth`-managed credentials file"**, and keys live in
`credentials.yaml` (chmod 600), separate from config. Copying `buildLoginSettings`
verbatim would put a secret into a non-secret, potentially-committed file.

**So:** adopt the *ergonomics* (`--api-key`, piped stdin, masked input, "you're
ready to go" confirmation), keep Nib's *separation* (key → `credentials.yaml`;
optionally seed a minimal `settings.json` with **model/baseURL only, never the
key**).

### Not copy-pasteable

`login.ts` imports `writeStdout`/`writeStderrLine` from a pre-existing
`../utils/stdio-helpers` and uses their core `readSettings`/`writeSettings`/
`getUserSettingsPath`. It's a **pattern to reimplement** against Nib's
`src/config/credentials.ts` + `src/config/loader.ts`, not a file to lift.

### Proposed (small, self-contained — not part of the phase sequence above)

- **Enhance `src/auth/wizard.ts`:** add masked input (port `readHiddenLine`), a
  non-interactive `--api-key` / piped-stdin path, and a post-save "run
  `nib` to start" confirmation.
- **Optionally** seed a minimal project/global `settings.json` (model + baseURL
  for the chosen provider) on first login — **key stays in `credentials.yaml`.**
- **Verify:** `nib auth --api-key sk-… ` (no TTY) writes the credential;
  interactive entry is masked; existing config fields are preserved; the key
  never lands in `settings.json`.

---

## PR #216 — /usage command

Unrelated to logging/auth. Small (122-line), **clean** PR: a `/usage` slash
command that queries `GET api.deepseek.com/user/balance` and renders the credit
balance / availability in a bordered Ink view (`Esc` to close), gated on
`baseURL.includes("api.deepseek.com")`.

### The UI pattern fits Nib perfectly; the data does not

- **Pattern — reusable as-is.** The bordered-view + `useInput(Esc→close)` +
  slash-command-registry approach is exactly how Nib already does `/mcp`
  (`src/ui/views/McpStatusList.tsx`, `showMcpStatus` routing in `App.tsx`,
  `slash-commands.ts`). Adding a `/usage` view is low-friction structurally.
- **Data — provider-specific.** The `GET /user/balance` endpoint and the
  `balance_infos` (`total/granted/topped_up`) shape are **proprietary to
  DeepSeek**. Nib is provider-agnostic (Anthropic, OpenAI, DeepSeek,
  OpenRouter, Groq, Ollama). Most of those have **no balance endpoint**, or a
  completely different one (e.g. OpenRouter has `GET /credits`; Anthropic/OpenAI
  expose usage via dashboards/other APIs; Ollama is local — no balance at all).

### Verdict

**Take it only if generalized, or scope it honestly.** Two options:

1. **Provider-agnostic `/usage`** — add an optional `getBalance()` to the
   provider adapter contract (`src/providers/`), implement it for the providers
   that have an endpoint (DeepSeek `/user/balance`, OpenRouter `/credits`, …),
   and have `/usage` show "not supported for <provider>" otherwise. This is the
   on-ethos version but a bigger job (touches the adapter contract).
2. **DeepSeek-only `/usage`** — port it nearly verbatim, gated on the DeepSeek
   base URL, and clearly a single-provider convenience. Cheap, but adds a
   provider-specific special-case to a codebase that otherwise keeps providers
   behind a uniform adapter.

**Recommendation:** if wanted, do **option 1** (adapter method) — it's the small
extra cost that keeps Nib's provider-agnostic promise intact. Low priority
relative to the logging/permission work; it's a convenience, not a capability
gap.

---

## PR #132 — theme system

Large (3968-line) PR adding a full theme system: `ThemeTokens` (13 semantic
tokens), a `resolveTheme` resolver (preset / overrides / tokens), 8 presets
(light, dark, github-light/dark, monokai, dracula, ansi-light/dark), a `/theme`
dropdown with live preview, a `ThemeableStatic` component, a system light/dark
detector (with 318 lines of tests), and a React-rendered exit summary.

### Key finding: Nib's theme *model* is already ahead — the *machinery* is what's missing

Nib already has a wired-up theme system in `src/ui/theme.ts`:
- **A richer token model than the PR** — ~20 semantic slots **plus** a full
  `SyntaxColors` set (19 syntax colors) **plus** a `statusBar` sub-palette,
  versus the PR's 13 flat tokens.
- `resolveTheme(config)` with `mode: dark | light | auto` + shallow overrides —
  already used in `cli.tsx`.
- A `ThemeContextValue` class + `useTheme` context consumed across ~10 UI
  components (`StatusBar`, `MarkdownText`, `OutputArea`, `SyntaxHighlighter`, …).
- A `theme` config key already parsed by the loader (`theme.mode` / `name` /
  `overrides`).

So **do NOT adopt the PR's `ThemeTokens` model or `resolver.ts`** — that would be
a *downgrade* and a large, invasive rewrite of already-working code. The value is
in four things Nib is **missing**:

| #132 piece | Nib today | Take it? |
|---|---|---|
| **`/theme` command — live preview + `Esc` reverts** | **No `/theme` command at all** (slash set is clear/continue/exit/help/mcp/model/new/plan/raw/resume/skills/undo). Theme is only set via config file. | **Yes — the headline win.** A `/theme` picker (mirroring the existing `/model` dropdown + `/mcp` view patterns) that previews live and persists to settings on confirm. |
| **More presets** (github-light/dark, monokai, dracula, ansi ×2) | Only `dark`, `light`, `high-contrast`. | **Yes, cheap** — but *re-express them in Nib's richer `ThemeDefinition` shape*, don't import the PR's thinner token objects. Pure data. |
| **Real system light/dark detection** (`detect-system-theme.ts`, 204 lines + 318 test lines: parses macOS `AppleInterfaceStyle`, terminal `COLORFGBG`, env hints) | `detectSystemTheme()` in `theme.ts` is a **weak stub** — the `matchMedia` branch never fires in a terminal, and it just checks whether `~/.config/dconf/user` exists, else returns `"dark"`. `mode: "auto"` is effectively "always dark." | **Yes — real bug fix.** Port the detector (especially `COLORFGBG` + macOS `defaults read`) so `auto` actually works. Comes with a ready test suite to adapt. |
| **`ThemeableStatic`** — re-mount Ink `<Static>` on theme change so scrollback recolors | Uses raw Ink `<Static>` in `OutputArea.tsx`; a live theme switch would leave already-printed lines in the old palette. | **Only needed if** live-preview `/theme` is added — it's what makes preview actually repaint history. Take it together with the `/theme` command. |
| **React-rendered exit summary** (`ExitSummaryView` replacing `process.stdout.write`) | `src/ui/exit-summary.ts` writes directly to stdout. | **Optional / independent.** A nice robustness fix (survives terminal scroll) but orthogonal to theming — evaluate separately. |

### Verdict

**The one to actually build here is the `/theme` command** — Nib has all
the theming infrastructure and zero user-facing way to switch at runtime. Bundle
it with: (a) the extra presets re-expressed in `ThemeDefinition` shape, (b) the
real system-theme detector (fixes the broken `auto` mode), and (c)
`ThemeableStatic` so live preview repaints scrollback.

Explicitly **reject** the PR's token model / `resolver.ts` — Nib's is
strictly richer and already integrated. This is the clearest "borrow the
*feature*, keep our *architecture*" case of all the PRs reviewed.

### Rough phasing (independent of the logging phases)

1. Extra presets in `BUILTIN_THEMES` (data only) → *verify:* each resolves and
   renders.
2. Replace the `detectSystemTheme` stub with a real detector + tests → *verify:*
   `mode:"auto"` picks light on a light terminal (`COLORFGBG`/macOS).
3. `/theme` dropdown (reuse `/model` + `/mcp` patterns) with live preview + Esc
   revert + persist-on-confirm; add `ThemeableStatic` → *verify:* preview
   recolors history, Esc restores prior theme, confirm writes `theme` to
   settings.

---

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
| ~~**`Orchestrator`** subsystem~~ ✅ **wired 2026-08-11** · **design doc + tagged audit 2026-08-13** | `src/orchestrator/index.ts` (`Orchestrator` class, `OrchestratorOptions`, `new_task` tool def) | **Resolved.** `new_task` is registered by both the TUI (`cli.tsx:181–189`) and headless (`exec-runner.ts:141–150`) registries; sub-agents run a real `runAgent` turn with the parent's live permission engine and a per-spawn provider. Design doc: [subsystems/orchestration.md](./subsystems/orchestration.md) §7 (2026-08-13); sub-agent audit/token rows tagged `source: "subagent"` in the parent session (2026-08-13). | **Wired + documented.** Enforcement: depth cap 3 / max 10 sub-turns. |
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
