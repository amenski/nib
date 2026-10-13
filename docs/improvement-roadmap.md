# Improvement Roadmap

**Status:** forward-looking roadmap · refreshed 2026-10-12 · not a spec — shipped items are marked ✅ with commit hashes; unshipped items are plans, not behavior.

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
**do-now / roadmap / reject**. Detailed per-PR analysis is in the [detail files](#detail-files); once an item
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

## 🆕 Newly-known items (surfaced during the wave)

Small, concrete follow-ons discovered while shipping the above. Not yet scheduled;
captured so they aren't lost:

| Item | What / why |
|---|---|
| ~~**`ThemeableStatic` + input-stall pair**~~ **half shipped** | The `<Static>` move landed (see the 08-02→08-08 wave in [roadmap/shipped.md](./roadmap/shipped.md)). What remains is only `ThemeableStatic`: re-mounting `<Static>` on theme change so a live `/theme` preview repaints existing scrollback. |
| **`/usage` command** | Provider-agnostic balance view via a `getBalance()` adapter method (see PR #216 in [roadmap/pr-reviews.md](./roadmap/pr-reviews.md)). **Confirmed still unbuilt** (no `getBalance` on any adapter, no `/usage` command); `/theme` established the bordered-view+Esc pattern it would reuse. |
| ~~**Exit-summary React view**~~ **obsolete** | `src/ui/exit-summary.ts` no longer exists — superseded by the exit-collapse-to-resume-hint change (`a61733b`), which removed the direct-`stdout.write` path entirely. The **telemetry accept/reject counters** still need a home; re-home them rather than reviving this. |
| **Audit refinements — remainder** | (a) **allow-by-posture emission** — the canonical decision value still isn't written by `agent.ts` (the audit closure lacks posture visibility; needs plumbing, deferred with the exit-summary wave). Color/label coverage for all canonical values + **double-row dedup** ✅ **shipped 2026-08-02**. |
| ~~**Doctor: `credentials.json` label**~~ ✅ **shipped 2026-08-02** | `doctor` diagnostics now print `credentials.yaml`, the real file. |
| ~~**`ansi-light` / `ansi-dark` presets**~~ ✅ **shipped 2026-08-02** | Both ANSI presets (base-16 only, "dumb-terminal" variants of dark/light) added in `ThemeDefinition` shape; `/theme` picker auto-adopts them. |
| ~~**Plan-mode research read**~~ ✅ **shipped 2026-08-02** | Plan mode now loads `.nib/research/**/*.md` (the `.deepcode/docs/research/` path from the original note is stale — the repo renamed its config namespace to `.nib`) and injects it into the volatile plan-mode context each turn. |
| **CodeArtifact-URL-in-git-history scrub — decision** | A CodeArtifact registry URL leaked into git history (via a lockfile now fixed forward in `e72047f`). Decide whether to history-scrub (rewrite) or leave-and-document; it is a URL, not a secret. Owner decision pending. |

---

## Detail files

| File | What's in it |
|---|---|
| [roadmap/shipped.md](./roadmap/shipped.md) | Shipped waves, 2026-07-31 → 0.6.1, with commit hashes |
| [roadmap/logging-plan.md](./roadmap/logging-plan.md) | PR #266 analysis: gap analysis, JSONL vs SQLite, data model, phased plan |
| [roadmap/pr-reviews.md](./roadmap/pr-reviews.md) | PR #263 (hooks etc.), #225 (login), #216 (/usage), #132 (themes) |
| [roadmap/dead-wiring-audit.md](./roadmap/dead-wiring-audit.md) | Keys, modules and settings parsed but consumed nowhere (resolved) |
