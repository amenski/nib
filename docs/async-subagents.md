# Async Sub-agent Execution — Design

**Status:** shipped 2026-08-16 (task registry, async spawn contract,
delivery + auto-wake, cap 3, die-on-exit · UI: running-task status-line
segments, `/tasks` view with stop, live sub-run text streaming).

**Problem (owner-reported):** `new_task` runs the sub-agent synchronously
inside the tool call (`src/orchestrator/index.ts:278`). The parent turn —
and therefore the whole chat — is hostage for the sub-run's full duration
(up to 10 sub-turns of provider latency). Typed input queues without
response, and only tool-name progress events render.

**Chosen direction (owner, 2026-08-16): B — true async spawn,
Claude-Code-style.** `new_task` returns immediately; the sub-agent runs in
the background; the summary arrives as a follow-up message that wakes the
parent model. This is a contract change to the orchestrator loop, not a UI
patch.

## 1. Contract changes

### new_task (tool)

- Returns **immediately** with `task <id> spawned — result will follow`
  (plus depth/concurrency info). The tool no longer blocks.
- The parent model **ends its turn** after spawning (orchestrator
  instructions updated: "spawn, then end the turn and await results").
- Result delivery is a **synthetic follow-up message** (see §2), never a
  tool result.

### Orchestrator prompt

- Orchestrator mode instructions gain the async contract: tasks run in
  parallel; results arrive as separate messages; do not poll; do not
  re-spawn a task that is still running.

## 2. Delivery & wake

- On completion (done/failed/aborted), the summary is formatted as a
  message: `Sub-agent result (task <id>): <summary>` and appended to the
  conversation + persisted like any user/assistant message (session
  records stay honest).
- **Wake rule (Q1):** if the app is idle (no active turn), a new turn
  starts automatically with the result as its prompt. If a turn is
  active, the result is injected via the existing steering mailbox path
  (decision-point injection, cli-spec §7) so the parent sees it before
  its next provider call. If the user is mid-typing, the wake waits for
  submission or queues behind it.

## 3. Runtime

- New `src/orchestrator/runner.ts` (or extension of the orchestrator):
  an in-memory task registry — `Map<taskId, { status, spawnedAt, depth,
  agentName, result?, error? }>`, plus the running sub-runs.
- **Concurrency cap (Q2):** max N concurrent sub-agents; beyond it,
  `new_task` returns a "queue full (N running)" tool error.
- **Lifetime (Q3):** in-memory only — `/exit` kills pending sub-runs
  (documented, like background jobs). Nothing persists; resume does not
  restore tasks.
- **Cancellation:** Esc/Ctrl+C aborts all running sub-runs (parent
  signal, as today); `/tasks` (Q4) lists tasks with status + stop action
  (JobManager panel pattern).
- Depth cap (3) and max sub-turns (10) unchanged. Permission/profile
  inheritance, tagged audit rows, audit-only store view, isolated todo
  stores: **unchanged** — the security envelope is not part of this
  change.
- Hooks: `SubagentStart` fires at spawn, `SubagentStop` at completion —
  now truly async (was: around the synchronous call).

## 4. UI

- Running tasks render as status-line segments (jobs pattern:
  `● task <id> running`) + a `/tasks` view with stop.
- Sub-agent streamed text renders live in the transcript as it runs
  (progress events extended with text deltas) — the sub-agent's work is
  visible even though the parent turn ended.
- Results render as normal messages when delivered.

UI shipped 2026-08-16, reworked 2026-10-16: a live row under the status line
(`⏵ 1 agent · <name>: <description> 12s · ↓ to view` —
`src/ui/core/background-items.ts`); the background panel shared with shell
jobs (`/jobs`, `/tasks` or ↓ on an empty prompt — `src/ui/views/BackgroundList.tsx`;
↑↓ selects, `x` stops the selected running task, Esc closes) via `Orchestrator.abortTask` (that task's own signal +
registry record, siblings untouched); and live sub-run text (`{kind:"text"}`
progress events from the sub-run's `onText`, coalesced at ~200 ms into dim
`[agent <name>]` transcript rows by the App's mount-time sink — registered
once, so text renders regardless of turn state).

## 5. Edge cases

- **Sub-agent spawns a sub-agent**: same async contract, depth cap
  applies; the child's result wakes ITS parent chain naturally (each
  wake targets the spawning conversation).
- **Wake while headless (`-p`)**: results are appended and the headless
  loop continues automatically (same wake rule; headless has no typing
  to race).
- **Multiple completions arriving together**: delivered in completion
  order, one wake per batch.
- **Session store races**: sub-runs append to the parent session file
  after the parent turn ended — append-only JSONL is safe; the audit-only
  view unchanged.

## 6. Out of scope

- Persistence/resume of running tasks.
- Parent-parallel work while tasks run (the parent turn ENDS; there is
  no parent activity during sub-runs — the chat is free because nothing
  is running, not because two things run at once). True parent+subagent
  parallelism (Claude Code's main-agent-continues-while-subagents-work
  model) is a later decision.
- Retry of failed tasks by the orchestrator is prompt-level (the model
  sees the failure and may re-spawn) — no automatic retries.

## 7. Verification

- Orchestrator integration: spawn returns immediately; sub-run completes
  in background; wake message delivered; parent continues in the next
  turn with the result.
- Concurrency cap enforced; `/tasks` shows + stops; Esc aborts all.
- Session records: tagged sub-agent rows + the delivered result message
  persist correctly.
- Orchestrator prompt changed → golden eval (G1-G6) still passes (prompt
  change protocol, system-prompt.md).

## Decisions (owner, 2026-08-16)

- **Q1 — auto-wake.** Idle app → new turn starts automatically with the
  result; active turn → steering-mailbox injection; mid-typing → waits
  for submission.
- **Q2 — cap 3** concurrent sub-agents; beyond it `new_task` errors
  "queue full".
- **Q3 — in-memory, die on exit.** Resume does not restore tasks.
- **Q4 — `/tasks` view** (list + stop, jobs-panel pattern) + status-line
  segments while running.
