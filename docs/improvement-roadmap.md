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
| ~~**PermissionProfile ACL model** (path/network/git sandbox)~~ ✅ **shipped 2026-08-13** (phases a–e; [permission-profile.md](./permission-profile.md)) | #263 | L | Parallel ACL model landed with the OS sandbox; see the spec for the reconcile decision. |
| ~~**Sub-task orchestration**~~ (`new_task` tool, `src/orchestrator/`) ✅ **wired 2026-08-11** · **design doc + tagged audit shipped 2026-08-13** | — | L | `new_task` is mounted in both the TUI (`cli.tsx:181–189`) and headless `-p` (`exec-runner.ts:141–150`) registries; sub-agents run a real `runAgent` turn in the target mode's toolset, inherit the parent's live permission engine (rules + approval posture, no escalation) and per-spawn provider factory (follows `/model` switches). Enforcement: depth cap 3, max 10 sub-agent turns. The inheritance/recursion design doc is [subsystems/orchestration.md](./subsystems/orchestration.md) §7; sub-agent audit/token rows now land in the parent session tagged `source: "subagent"` (session-spec.md). |
| ~~**Hierarchical project rules** (`.nib/rules/**`)~~ ✅ **shipped 2026-08-01** (`7290aab`) | #266 | M | Additive to `instructions.md`/`AGENTS.md`; landed — promoted to Do-now shipped list. |
| ~~**Auto error-fix loop + `<error_analysis>`**~~ ✅ **shipped 2026-08-15** | #266 | M | Audited → build-the-delta: `run_bash` non-zero+stderr exits now set `error` and prepend a grepped `<error_analysis>` block; retry-cap exhaustion fires an escalation diagnostic. |
| ~~**Lifecycle hooks** (shell on events)~~ ✅ **shipped 2026-08-13** (full event set; [hooks-spec.md](./hooks-spec.md), `src/hooks/`) | #263 | M | Opt-in, security-spec first; project hooks are trust-on-first-use. |
| ~~**Mid-turn steering**~~ ✅ **shipped 2026-08-13** (`pollSteeringMessage`; dev-todo #2) | local (usage) | M | Queued input is injected at the next decision point; Esc keeps the queue. |
| ~~**Background / streaming command output**~~ ✅ **shipped 2026-08-13** (`run_bash_background`, `check_job`, `/tasks`; `check_job` waits since 0.7.0) | local (usage) | M | Background jobs with a completion signal and live output. |
| ~~**`/usage` command**~~ ✅ **exists** (`src/ui/views/UsageView.tsx`, `cli.tsx` `/usage`) — only the provider balance (`getBalance()` adapter method) is unbuilt | #216 | M | Worth building only provider-agnostic, else a DeepSeek-only special case. |
| **React exit-summary view** | #132 | S–M | Robustness fix (survives scroll); orthogonal to everything else. |
| **SQLite log backend** | #266 | L | Only if JSONL logs prove they need cross-session SQL. Off-ethos (opaque binary sessions). |
| **Risk classifier: `shadow` → `enforce` default** | local (prompt-injection review, 2026-10-29) | S code, needs decision | `classifier.mode` defaults to `shadow` (`cli.tsx` turn wiring; [command-risk-classifier.md](./command-risk-classifier.md) §1), so outside auto posture a block-tier command an injected prompt asks for is labelled, not stopped — permission rules, Seatbelt and TOFU still apply. Shadow was the planned first stage (§2 step 1: collect data before enforcing). Decide from the shadow rows whether the false-positive rate allows flipping the default. **False positives cut 2026-11-02 (E14):** in one session 39 of ~100 bash commands were `confirm` only because of an `export PATH="$HOME/…:$PATH"` prologue (`shell.special-var` + `parse.partial`), and every `update_todo_list` / `attempt_completion` / `switch_mode` / `ask_user_question` / `check_job` call hit `parse.failed`; both now pass (trusted PATH exports are dropped before parsing, those five tools are `safe`; `kill_job` and unknown tools stay fail-closed). `eval` now has its own `shell.eval` confirm. **Measured 2026-11-02** (`npx tsx scripts/classifier-stats.ts`, last 14 days, 13,498 bash rows): 99.9% ran in auto posture, where the classifier already enforces, so only 11 rows are non-auto and an `enforce` default would change almost nothing for the daily driver. Classifier-caused **asks** 0 (target < 5%); classifier-caused **blocks** 40 (0.3% of rows), of which the user overrode 2 (5%, target < 10%); parse coverage 86% (target > 90%; 82% since E14, too few rows to trust). **Decision (owner, 2026-11-02): keep `shadow`**; re-run the script after two more weeks and decide with at least 200 non-auto rows, or sooner on an owner call. |

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
| ~~**CodeArtifact-URL-in-git-history scrub — decision**~~ ✅ **closed 2026-11-02, nothing to scrub** | A history-wide `git log --all -G` for the private registry host pattern (the one `.github/workflows/registry-guard.yml` blocks) finds no commit across all 664; the only commits that mention the registry at all, `6087d25` and `0a7ef2d`, are the guard hook's own text. The repo is public, so this was worth confirming. The pattern is not spelled out here because the guard fails any file that contains it. |

---

## Detail files

| File | What's in it |
|---|---|
| [roadmap/shipped.md](./roadmap/shipped.md) | Shipped waves, 2026-07-31 → 0.6.1, with commit hashes |
| [roadmap/logging-plan.md](./roadmap/logging-plan.md) | PR #266 analysis: gap analysis, JSONL vs SQLite, data model, phased plan |
| [roadmap/pr-reviews.md](./roadmap/pr-reviews.md) | PR #263 (hooks etc.), #225 (login), #216 (/usage), #132 (themes) |
| [roadmap/dead-wiring-audit.md](./roadmap/dead-wiring-audit.md) | Keys, modules and settings parsed but consumed nowhere (resolved) |
