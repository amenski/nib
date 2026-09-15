# Feature Plans

**Status:** forward-looking plan · researched 2026-08-13 · not a spec — none of
this behavior exists until built; anchors verified against src/ on 2026-08-13.

How the remaining roadmap items were planned: each entry below states what the
state-of-the-art CLIs do (Claude Code, OpenAI Codex, Gemini CLI, aider, opencode
— researched 2026-08-13 from official docs and repos), what nib has today,
the proposed design, and any decision the owner needs to make. Once an item is
built, its behavior moves into the owning `*-spec.md` and this entry is struck.

**Priority order** — all items shipped 2026-08-13 (§1-§11 complete); this
doc is now the design record for the wave. Unshipped remaining work lives
in dev-todo.md.

---

## ~~1. Parallel tool calls — mixed batches + parity (todo.md 25.3)~~

**✅ shipped 2026-08-13** — partition + original-order replay + fast-path
audit parity landed in `src/agent.ts`; behavior now lives in permission-spec.md §11.

### SOTA

- **Claude Code** documents tool-call *batches* (a `PostToolBatch` hook fires
  when a batch of parallel calls resolves) but does not specify concurrency
  semantics per call. Permission dialogs for several pending tools render as
  *tabs* — one approval surface, navigate left/right.
- **Gemini CLI** is building exactly this: epic
  [google-gemini/gemini-cli#17120](https://github.com/google-gemini/gemini-cli/issues/17120)
  — reads parallelize freely, writes are staged/sequential via dependency
  analysis.
- **Codex CLI** is serial by default; parallel is opt-in per MCP server
  (`supports_parallel_tool_calls`), and it has known lost-event bugs there.
- **aider** gates parallel function calling on per-model capability metadata.

### Current state

`src/agent.ts:409-483` — the fast path fires only when *every* call in the
batch is a read (`allReads` gate); a mixed batch falls back to fully
sequential. The path also diverges from the sequential loop:
- no `appendPermission` audit rows (`agent.ts:493-544` are sequential-only);
- `failedStreak` incremented (`:471-474`) but never acted on;
- no `errorReflector` retry, repeat-call warning, or loop detection.

### Proposed design

1. **Partition, don't bail.** Pre-resolve all calls (existing `:414-422`).
   Partition into `allow`-reads / everything-else. Execute the reads via the
   existing `Promise.allSettled` path; then process writes-and-asks
   sequentially in *original call order* (writes stay strictly ordered; a
   `ask` in the batch never double-prompts because each is resolved once).
2. **Original-order replay.** Tool results must be pushed back in the
   assistant's original `toolCalls` order (the provider contract requires
   it) — collect into a map, then emit in order.
3. **Parity sweep on the fast path** — port from the sequential loop:
   `appendPermission` for deny-by-rule / allow-by-rule / ask-denied;
   act on `failedStreak` (5-consecutive escalation); repeat-call detection.
4. **Tests** (`src/agent.test.ts`): mixed batch = reads overlap in time,
   writes sequential after; results replay in original order; a deny in the
   batch records an audit row; askUser in the batch forces reads-first-then-
   ask without double-prompting.

### Open decisions

- None material. Dependency analysis (Gemini's write-dependency staging) is
  deliberately out of scope — writes stay sequential in call order.

---

## ~~2. Mid-turn input & steering~~

**✅ shipped 2026-08-13** — `AgentOptions.pollSteeringMessage` mailbox +
App queue wiring landed (decisions A/B/C as locked below); behavior now
lives in `cli-spec.md` §7 and `subsystems/react-loop.md`.

**Priority:** P1 (daily-driver UX) · **Effort:** M–L

### SOTA

- **Claude Code:** typing during a turn is *queued*; the docs say the model
  "reads it as soon as the current action completes and adjusts before
  deciding its next step" — i.e. injection at the next decision point,
  mid-turn. Esc interrupts; partial work stays. Known regressions in this
  area (dropped queued messages, Esc disabled while a queue exists —
  [anthropics/claude-code#52509](https://github.com/anthropics/claude-code/issues/52509),
  [#16905](https://github.com/anthropics/claude-code/issues/16905)).
- **Codex CLI:** Enter *steers* (injects into the running turn) and Tab
  *queues* for the next turn — the most aggressive model.
- **Gemini CLI:** shipped "Message Queuing" v0.2.1 — Tab queues, Enter steers
  (interrupt-style).
- **opencode:** sending while running interrupts; queuing is plugin-only.
  **aider:** nothing — input only after the turn.

### Current state

Queueing already exists: `App.tsx:265-287` (`messageQueueRef`/`turnActiveRef`)
drains FIFO at turn end (`:926-934`). What we don't have is *mid-turn
injection*: the queued message waits for the whole turn to finish.

The machinery for injection already exists elsewhere: `runAgent` injects
volatile context + the todo block into the trailing user message before every
provider call via `withVolatilePrefix` (`src/agent.ts`). A steering message is
one more block in that prefix.

### Proposed design

1. **Mailbox on the loop.** `AgentOptions` gains an optional
   `pollSteeringMessage: () => string | null`. Before each provider call in
   the sub-turn loop, poll it; a hit is injected as
   `"User message (typed mid-turn): …"` in the volatile prefix of that call
   (and then persisted as a real user message, so the session record stays
   honest). Injection happens at decision points only — never mid-stream —
   matching Claude Code.
2. **UI wiring.** App's existing queue becomes the mailbox; Enter while a
   turn runs enqueues as today, but the loop consumes the head before its
   next provider call instead of waiting for turn end. Esc keeps
   interrupt semantics (abort current call, discard partial, return to
   prompt; queued input survives into the next turn — Claude Code's
   dropped-message regressions are exactly what we avoid by keeping the
   queue explicit).
3. **No new chords.** Enter=queue-and-inject needs no new keybinding and no
   conflict with Tab (which owns completion here). The Codex-style
   steer-vs-queue split is rejected: our Tab already means completion.

### Decisions (2026-08-13)

- **A — inject at the next decision point** (Claude Code model). Chosen.
- **B — Esc keeps queued input** for the next turn (never silently dropped —
  Claude Code's regression class, avoided by design).
- **C — persist as a normal user message.** Chosen; a `steered: true` flag
  is a possible later refinement, not planned.

---

## ~~3. Background commands — live output + completion signal~~

**✅ shipped 2026-08-13** — JobManager completion/output events, the TUI
status segment + notify job payload, and the run_bash timeout→background
migration landed (decisions D/E as locked below); behavior now lives in
tool-spec.md §2/§5, config-spec.md §13, and notify-spec.md §3-4.

**Priority:** M (user runs dev servers/tests daily) · **Effort:** M

### SOTA

- **Claude Code:** `run_in_background: true` or Ctrl+B; returns a task ID
  immediately; output goes to a working file; `/tasks` lists and can stop
  tasks; a completion notification fires. Notable: a foreground command that
  hits its timeout is **moved to the background instead of killed** (except
  sleep/git/unparseable compounds). Caps: 5 GB output auto-terminate;
  memory-pressure reaps idle ≥30 min tasks.
- **Codex/Gemini:** no native background tool; completion *notifications*
  (terminal bell / desktop notify) are the convention.
- **opencode:** plugin-based only.

### Current state

`src/tools/jobs.ts` — `JobManager` with start/check/kill/list, capped
accumulating stdout/stderr (1 MB), MAX_JOBS 10. Output surfaces only when the
model polls `check_job`; no UI subscription, no completion signal. `notify.ts`
fires a script at turn boundaries only.

### Proposed design

1. **Completion notification.** On job end, surface a TUI status line
   segment (`● job 3a2f done (exit 0) · 42 lines`) and fire the existing
   notify hook (same payload builder) so desktop notifications work.
2. **Live output.** `JobManager` gains a per-job `EventEmitter` (or a
   `subscribe(jobId, cb)`); App subscribes for running jobs and appends
   chunks to the transcript as dim rows (respecting the Static-epoch
   rendering model, capped to avoid re-render storms — coalesce at ~200 ms).
3. **Timeout→background migration** (Claude Code behavior): when `run_bash`
   hits the 120 s cap, instead of killing, move the process to `JobManager`,
   return `{ jobId, note }` so the model can `check_job` it. Config knob
   `commands.timeoutToBackground` (default on?). Keep the kill-on-timeout
   behavior for commands that look interactive.
4. **Tests:** job completion emits + notify payload built; subscription
   receives appended chunks; timeout migration preserves output continuity.

### Open decisions

- **D — timeout→background:** default on (recommended) or opt-in config?
- **E — live output in transcript:** stream only for the job the model
  started (recommended) or all jobs?

---

## ~~4. Lifecycle hooks — full event set~~

**✅ shipped 2026-08-13** — full 15-event set implemented against
hooks-spec.md (`src/hooks/`, deny-only power, TOFU trust, redacted
payloads); behavior now lives in hooks-spec.md + config-spec.md §14;
security review of T15 pending.

**Priority:** M · **Effort:** L · **Security-sensitive**

### SOTA

- **Claude Code** has the richest model: ~20 events (PreToolUse, PostToolUse,
  PostToolBatch, UserPromptSubmit, Notification, PreCompact, SessionStart/End,
  …), matchers with exact-name lists or unanchored regex, JSON on stdin,
  exit-code contract (0 = pass, **2 = block**, other nonzero = non-blocking
  error), exit-0 JSON can override decisions (`permissionDecision`,
  `updatedInput`), `disableAllHooks` master switch.
- **Gemini CLI:** same contract, smaller event set (Before/AfterTool,
  BeforeToolSelection, Before/AfterModel, PreCompress, Notification,
  SessionStart/End), 60 s default timeout, tiered config layers.
- **opencode:** narrow pre/post-tool hooks via plugins only.

### Current state

No hook dispatcher exists. Only `src/notify.ts` (completion-boundary script,
already spec'd). Security posture in the roadmap explicitly deferred hooks
until a security-spec treatment exists.

### Decision (2026-08-13)

**F — full Claude-Code event set**, not a two-event phase 1. The surface
below is the target; it still lands incrementally (block-able events first,
then feedback/notification events) because each event needs a dispatch point
spliced into the loop.

### Proposed design

1. **Event set** (adapted from Claude Code's, mapped onto nib's loop):
   - Block/decide: `SessionStart`, `UserPromptSubmit`, `PreToolUse`
     (tool events only), `PermissionRequest` — can deny/rewrite.
   - Feedback: `PostToolUse`, `PostToolUseFailure`, `PostToolBatch`,
     `PreCompact`, `PostCompact`, `MessageDisplay` — stdout may be injected
     as context (like Claude's UserPromptSubmit stdout-as-context).
   - Signal: `Notification`, `Stop`, `SubagentStart`, `SubagentStop`,
     `SessionEnd`.
2. **Config:** `hooks: { <Event>: [{ matcher?, command }] }` in settings
   (project > global merge like permissions). Matchers: exact tool-name
   lists and unanchored regex (Claude's dual syntax, since the full set
   needs it); `*`/omitted = all.
3. **Contract:** JSON on stdin (`{hook_event_name, session_id, cwd,
   permission_mode, tool_name?, tool_input?}`, input redacted per
   secret-hygiene rules); exit code 0 = pass (stdout to debug log, or
   context on the context-accepting events), **2 = block**, other nonzero =
   non-blocking error, timeout (30 s default) never blocks. Exit-0 JSON may
   carry `{decision: "allow"|"deny"}` on PreToolUse/PermissionRequest and
   `updatedInput` on UserPromptSubmit — but a `deny` routes through the
   permission engine as deny-by-rule (audit row + PERMISSION_DENIED to the
   model), and `allow` is advisory-only (**G**, decided: hooks never
   *upgrade* a rule-derived `ask`; deny-absolute holds).
4. **Guards:** hooks run only when explicitly configured (no defaults); a
   global `disableAllHooks` escape hatch; `ask`-tier trust-on-first-use the
   first time a project config declares hooks (mirroring skill trust);
   a security-spec section documents the whole contract before it ships.
5. **Out of scope (phase 2):** non-command handler types (HTTP, MCP-tool,
   prompt, agent handlers), managed-policy layers, matcher `if` permission
   filters.

### Verification

Per-event unit tests with a fake dispatcher + script fixtures: exit-2 blocks
PreToolUse and feeds PERMISSION_DENIED; PostToolUseFailure stdout reaches the
transcript; Notification fires at turn completion; disableAllHooks silences
everything; trust prompt appears exactly once per project.

---

## ~~5. Completion & @-mention guardrails (todo.md 25.5 remainder)~~

**✅ shipped 2026-08-13** — `ctx.completer` is now wired into prompt Tab
(slash commands at line start, @-picker precedence, mid-word path
completion), @-mentions resolve read rules before injection (denied →
not-injected note), and headless `/sessions` lists the cwd's sessions;
behavior now lives in cli-spec.md §5.

**Priority:** P3 · **Effort:** S–M

### SOTA

- **Claude Code:** `@` → file-path autocomplete, content injected into the
  prompt, and mentions are subject to **Read permission rules** (a denied
  path is not injected — best-effort). Tab also drives slash-menu and
  prompt-suggestion completion.
- **aider:** prompt_toolkit completion (files, commands) with known
  over-completion bugs.

### Current state

`FileMentionMenu` is rendered (`PromptInput.tsx:514-521`); `ctx.completer`
(`ui/types.ts:134`, impl `cli.tsx:808-844`) handles slash commands, `/mode`
slugs, and `@` paths but **no consumer exists** — the field is dead. Also:
headless `handleSlashCore` advertises `/sessions` (`cli.tsx:822`) but has no
case for it.

### Proposed design

1. **Wire the completer** into PromptInput: bare Tab at line start completes
   slash commands; after `@`, the existing menu (already handles insertion)
   takes precedence; mid-word Tab falls back to `ctx.completer` (path
   completion for tokens containing `/`).
2. **Permission-gate @-mentions** (Claude Code behavior): `processAtMentions`
   resolves each mentioned path through the permission engine's read rules
   before injection; a denied path is replaced with a `[not injected: denied
   by permissions]` note instead of silently dropping.
3. **Headless `/sessions`**: add the missing case (list recent sessions for
   the cwd, matching the TUI output shape).
4. **Tests:** PromptInput completion flow; mention injection respects a deny
   rule; headless `/sessions` prints and exits 0.

### Open decisions

- None material.

---

## ~~6. Permission audit completion~~

**✅ shipped 2026-08-13** — `allow-by-posture` is now agent-emitted (posture
visibility plumbed via `askUser` resolving `"posture"`); parallel-path audit
rows landed with §1. Decision H stays open (dev-todo.md) for §10.

### SOTA

- **Claude Code:** `/permissions` is an interactive rule manager; recent
  auto-mode denials are reviewable; "don't ask again" persists to
  settings. The audit *reason* for every decision is a first-class concern.

### Current state

`engine.ts:100-110` returns the canonical decision; agent-side writes exist
for the sequential path (`agent.ts:493-544`); UI writes once/session/always/
deny (`App.tsx:1270-1280`). Two gaps: `allow-by-posture` is in the type union
(`store.ts:49`) but **never emitted** (posture approvals surface as
`ask-approved`), and the parallel path (§1) emits nothing.

### Proposed design

1. Emit `allow-by-posture` wherever posture upgrades an ask→allow (the
   decision point needs posture visibility — the known plumbing gap, now
   scheduled).
2. Parallel-path audit rows land with §1's parity sweep.
3. Sub-agent audit rows (see §10) — decide there.

### Open decisions

- **H — sub-agent audit rows:** write them into the parent session JSONL
  tagged `source: "subagent"` (recommended, debuggability) or keep sub-agents
  audit-silent (current isolation stance)?

---

## ~~7. Usage & balance display (`/usage`)~~

**✅ shipped 2026-08-13** — `getBalance?()` on the Provider interface
(deepseek `/user/balance` USD entry, openrouter `/credits`, null elsewhere),
`/usage` bordered view + headless variant, live query per open (decision I);
behavior now lives in provider-spec.md §2.1 and cli-spec.md §5.

**Priority:** P3 · **Effort:** S–M

### SOTA

- **Claude Code:** `/cost` ≡ `/usage` — session totals, per-model token
  counts, lines added/removed; a `statusLine` JSON feed is the extensibility
  surface.
- **Codex:** `/usage` with token counts and pricing tables (LiteLLM JSON).
- **Gemini:** tokens only, no cost (open feature request). **opencode:**
  `opencode stats` aggregates SQLite across sessions (per-model/tool).
- **Balance APIs exist** — DeepSeek `GET /user/balance`, OpenRouter
  `GET /api/v1/credits` — but no major CLI queries them natively; community
  status-bar tools do.

### Current state

`Provider` interface = `name` + `streamChat` only (`src/providers/types.ts:29-36`);
usage arrives as a `StreamEvent` variant. `/cost` already prints session
totals from `queryTokenUsage`.

### Proposed design

1. **Optional adapter method** `getBalance?(): Promise<{currency, total, granted} | null>`
   implemented for deepseek (`/user/balance`) and openrouter (`/credits`),
   `null` elsewhere (on-ethos generalization — no provider special-cases in
   the CLI).
2. **`/usage`** (bordered view, Esc close — the `/theme` pattern): balance
   block where supported + "not supported for <provider>" otherwise, plus
   per-model token breakdown from the existing token records.
3. **Tests:** adapter mocks; `/usage` view renders both blocks.

### Open decisions

- **I — persist balances?** Query live each time (recommended, no state) vs.
  cache with mtime in the session index?

---

## 8. Theme repaint (ThemeableStatic)

**Priority:** P3 · **Effort:** S–M · Ink-specific (no SOTA analog — other
CLIs don't use Ink's Static flush model)

### Current state

`OutputArea.tsx:212-214` renders committed lines once through
`<Static>` (flush-once, never repainted; remount via `staticEpoch`, bumped
only on `/clear`/`/new` at `App.tsx:505-514`). ANSI colors are baked into
line strings at push time — a theme change repaints the live frame only;
existing scrollback keeps old colors.

### Proposed design

1. **Accepted limitation (recommended):** document that `/theme` applies to
   new output and the live frame; past scrollback keeps its colors until
   `/clear` or session restart. Note it in theme-spec §2.
2. **Optional real fix:** store committed lines as semantic records (raw text
   + kind) and re-render colors at render time, then bump `staticEpoch` on
   theme confirm. Cost: duplicates the line-type registry used by OutputLine;
   risk: re-printing large histories re-triggers the input-stall problem
   `<Static>` was adopted to fix — needs a viewport-only repaint strategy.

### Decision (2026-08-13)

- **J — accepted limitation.** Documented in theme-spec §2; no repaint work.

---

## ~~9. PermissionProfile — full parallel ACL model (design-first, L)~~

**✅ fully shipped 2026-08-13** — all phases (a)-(e): approved design,
schema + validation, `authorize()` evaluation, loop/UI/headless wiring,
and the flag-gated macOS Seatbelt sandbox (`src/sandbox/seatbelt.ts`,
T16). Follow-ups closed: mentions gate through `authorize()`. Behavior
now lives in permission-profile.md, permission-spec.md, config-spec.md,
security-spec.md.

### SOTA

- **Codex CLI** is the reference: `sandbox_mode` levels (read-only /
  workspace-write / danger-full-access) enforced by real OS sandboxes
  (macOS Seatbelt, Linux Landlock/seccomp/bubblewrap, Windows AppContainer);
  PermissionProfile adds path-based fs rules (`**/*.env = "deny"`) and
  network domain rules, superseding the legacy approval modes.
- **Claude Code:** no OS sandbox; posture modes + rule engine (deny→ask→allow
  precedence) + guarded circuit breakers — the same architecture family as
  nib.
- The deepcode PR #263 analysis (improvement-roadmap.md) already identified
  `permission-profile.ts` as the strongest borrowable idea and a *parallel*
  permission architecture — "own design doc + reconcile-or-migrate decision."

### Current state

Nib's rule engine + posture + guarded tiers (security-spec) is the
Claude Code architecture. OS sandboxing is already flagged in
security-destructive-matching.md as the large, model-changing item.

### Decision (2026-08-13)

**K — build the full parallel ACL model** (Codex-style PermissionProfile as
a second permission architecture beside the rule engine). This is a
workstream, not a feature: design doc first, then phased build.

### Proposed design (sketch — the design doc is step 1)

1. **Profile schema** (config `permissionProfile:`): fs rules as
   gitignore-style path globs with `read | write | deny` actions
   (`.git/** = "deny"`, `**/*.env = "deny"`), network domain rules
   (`allow: ["api.deepseek.com"]`, `deny: ["*"]`), and preset levels
   `strict-sandbox | workspace-write | unrestricted` in Codex's shape.
2. **Reconciliation with the rule engine** (the design doc's core problem):
   tentative model — profile evaluates first as a coarse *gate* (a denied
   path/domain never executes, full stop); surviving calls flow into the
   existing rule engine for fine-grained policy; posture overlays apply on
   top; `deny` from either layer is absolute. Migration path: existing
   rules are expressible as profiles, so one may eventually subsume the
   other — decide in the doc, don't assume.
3. **OS sandboxing** lands as a later phase: macOS Seatbelt profile per
   level (matching Codex's seatbelt backend), flag-gated, with the
   security-spec T-item for it. Rules-first, sandbox-second.
4. **Sequencing:** (a) design doc (permissions/security appendix) —
   (b) profile schema + config validation — (c) evaluation layer + tests —
   (d) posture/prompt integration — (e) Seatbelt phase.

### Decisions (2026-08-13)

- **L** and **M** settled and **approved by the owner**: profile-gate →
  rules → posture with deny-absolute proved per layer (§4); both systems
  kept permanently behind one `authorize()` surface with the two
  consolidations (§5). Bash-limitation honesty accepted; level names
  Codex-compatible (`workspace-write` default). Full record:
  [permission-profile.md](./permission-profile.md) §11. Phase (b) is
  unblocked.

---

## ~~10. Orchestrator design doc + sub-agent audit~~

**✅ shipped 2026-08-13** — design doc at subsystems/orchestration.md §7;
sub-agent audit/token rows tagged `source: "subagent"` in the parent
session via the audit-only `subagentAuditStore` wrapper (decision H);
behavior in session-spec.md.

**Priority:** P3 · **Effort:** S (doc) · closes the roadmap slice

### Current state

Enforcement exists: parent `PermissionEngine` passed straight through
(`src/orchestrator/index.ts:161`), depth cap 3, max 10 sub-turns;
sub-agents get `sessionStore: undefined` → they write nothing to disk.

### Proposed design

1. Write the design doc (subsystems or security-spec appendix): inheritance
   semantics, recursion limits, and the sub-agent audit decision H.
2. Consider lifting `sessionStore` to a shared store with
   `source: "subagent"` tags on audit/token records (todoStore isolation
   stays as-is).

### Open decisions

- H (above) — the only fork.

---

## 11. Items closed by this research (no work needed)

- **Sessions index** — already shipped: `sessions-index.json`
  (`src/sessions/store.ts:10`, `updateIndexEntry`/`rebuildIndex`, consumed by
  `list()`). Roadmap "in-flight" row is stale. Optional polish: search in the
  `/sessions` picker (Claude Code's resume picker has it) — unplanned.
- **Input queueing** — already shipped (`App.tsx` messageQueueRef); §2 is
  about *injection*, not queueing.
- **FEATURES.md** — deleted; todo.md 25.6 is moot.
- **Streaming-markdown refactor** — landed (`src/ui/core/stream-blocks.ts`,
  commit `72823fc`).

---

## Follow-on backlog (planned 2026-08-15)

The wave above shipped in full; these are the remaining code items, planned
in the same format. Priorities: F1-F3 are one small wave; F4-F5 are
medium, each its own.

### F1. ansi ×2 theme presets — S

**State:** `BUILTIN_THEMES` carries dark/light/high-contrast/dracula/
monokai/github-dark/github-light; theme-spec's open item (code-verified
2026-08-13) is the ansi pair — base-16-only "dumb-terminal" variants of
dark/light (no 256-color, no truecolor). improvement-roadmap's "shipped
2026-08-02" claim for these is stale — theme-spec is authoritative.

**Design:** add `ansi-dark`/`ansi-light` in `ThemeDefinition` shape using
only the 8+8 basic ANSI codes; syntax colors map to base colors (bright
variants for emphasis). `/theme` picker adopts them automatically
(existing mechanism).

**Verify:** both resolve; picker lists them; existing ansi-notes tests.

### F2. doctor SearXNG healthz probe — S

**State:** `runDoctor()` (`src/cli.tsx`) prints config diagnostics;
`webSearch.searxngUrl` is parsed. No runtime view of instance health.

**Design:** when `searxngUrl` is configured, `doctor` GETs `{url}/healthz`
(3 s timeout, no retries — diagnostics, not the tool path) and prints
`SearXNG: ok (N ms)` or `SearXNG: unreachable — searches will fall back
to Bing.`

**Verify:** runDoctor test with a stubbed healthz; unreachable case.

### F3. T14 residual — bash output control-char sanitization — M (security)

**State:** `sanitizeControlChars` strips C0/C1 except `\n`/`\t` and is
applied to web_fetch/enrichment content only. `run_bash` output is
unsanitized — terminal-control injection (spoofed UI, cursor games, OSC
52 clipboard writes) remains open for command output, both in the TUI
display and headless stdout (security-spec T14 residual).

**Design:** sanitize at the single choke point — the bash tool handler,
before the T12 untrusted wrapper — so model context AND every display
path get clean text in one place. Background job output (`check_job`)
gets the same treatment. Tests: OSC 52 / cursor-movement / spoofed-UI
escapes stripped, `\n`/`\t` preserved. T14 row → fixed.

**Decisions:** none — security-default, aligned with the existing
mitigation.

### F4. Agent definitions (frontmatter subagents) — M

**SOTA:** Claude Code subagents = frontmatter files (name, description,
model, tools) in `.claude/agents/`, discovered and listed; opencode =
markdown frontmatter in `.opencode/agents/` with mode + tool permissions.
**State:** nib's `new_task` takes a *mode*; sub-agents run the
target mode's toolset with parent permission/profile inheritance (depth
3, max 10 sub-turns, tagged audit). No per-subagent definition surface.

**Design:** `.nib/agents/<name>.md` with frontmatter
(`name`, `description`, `mode`, `model?`, `instructions`) resolved
project > global like modes; `new_task` gains an `agent?: string`
parameter; startup loads + indexes defs (description lines into the
orchestrator's system prompt section); a sub-agent run uses the def's
mode/model/instructions, falling back to the call's mode when `agent` is
absent. Permission inheritance, depth caps, audit tagging unchanged.

**Decisions (owner, 2026-08-15):** D1 — file-based only. D2 — per-agent
`model` overrides allowed (absent = inherit parent's model). D3 —
`.nib/agents/`, project > global resolution.

### F5. Auto error-fix loop audit — M (audit-first, no code until verdict)

**State:** `src/errorrecovery/` + `src/selfreflection/` both exist and
are threaded into the loop (wired 2026-08-08); the roadmap's Phase-4
borrow is a bounded fix-reminder (≤3 retries) + grepped `<error_analysis>`
header on failing bash output.

**Design:** read-only audit mapping each Phase-4 component against the
existing subsystems; verdict = overlap (skip) / partial (build only the
delta) / gap (build). Deliverable: a short findings doc + a dev-todo
build-or-reject entry. No code until the verdict is reviewed.

**Audit result (2026-08-15): build-the-delta.** ~70% overlap — the ≤3
retry cap and the tool-error fix-reminder exist; the gap is that bash
non-zero exits never set `error` (so the reminder and the loop guards
never engage for the most common failure class) and no
`<error_analysis>` header exists. Delta: set `error` on the non-zero
bash branch (gated on exit code AND non-empty stderr to spare
`grep -q`/`diff` idioms), prepend a grepped error block, optional
cap-exhaustion diagnostic. Tracked as dev-todo item 15.

### F6. Housekeeping — no code

Delete the merged `feature/searxng-web-search` branch; SecondBrain
session log for 2026-08-13 → 15 at wrap-up.

---

## Sources

Claude Code: code.claude.com/docs (hooks, permissions, interactive-mode,
sessions, costs, statusline, context-window, how-claude-code-works).
Codex: github.com/openai/codex docs/sandbox.md, PR #22795 (PermissionProfile),
PR #17667 (parallel MCP), #36410 (queue/steer). Gemini: geminicli.com/docs
(hooks, session-management, auto-memory), PR #695 (approval modes), #17120
(parallel scheduler), #24052 (message queuing). aider: aider.chat
(repomap blog, options), issue #5255. opencode: deepwiki.com/sst/opencode,
issues #5333/#20849, PR #3832 (stats). Balance APIs:
api-docs.deepseek.com/api/get-user-balance, openrouter.ai (credits endpoint).
Mid-turn regressions: anthropics/claude-code #52509, #16905.
