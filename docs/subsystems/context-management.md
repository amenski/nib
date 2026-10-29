## 2. Context Management — Beyond Token Counting

**Status:** current · verified 2026-10-10 · covers `src/compaction/{budget,compactor,context-editing}.ts`

### Problem

Naive context management — "count chars/4, compact when over threshold" —
loses important information and keeps irrelevant noise.

### The token budget model

```
┌──────────────────────────────────────────────────┐
│  Context Window (e.g., 128K tokens)              │
│                                                  │
│  ┌──────────────┐  ┌──────────────────────────┐ │
│  │ Immutable    │  │ Conversation             │ │
│  │ Prefix       │  │                          │ │
│  │              │  │ System prompt            │ │
│  │ System       │  │ Mode definition          │ │
│  │ prompt       │  │ RepoMap context          │ │
│  │ Tool defs    │  │ Skill context            │ │
│  │              │  │ Conversation history     │ │
│  │              │  │ Tool outputs             │ │
│  └──────────────┘  └──────────────────────────┘ │
│                         ┌──────────┐ ┌────────┐ │
│                         │ Output   │ │Safety  │ │
│                         │ Reserve  │ │Buffer  │ │
│                         └──────────┘ └────────┘ │
└──────────────────────────────────────────────────┘
```

Token estimation uses chars/4 (`src/compaction/budget.ts`); the trigger is
`shouldCompact`: compaction fires when estimated tokens exceed
`threshold × contextWindow` (threshold default 0.7, config-spec.md §11),
plus `estimateOverheadTokens` (tool schemas + volatile prefix) so the meter,
the /context display, and compaction all measure the same payload. The check
runs **before each provider call** so an oversized request never goes out.

### What compaction keeps — actual behavior

| Tier | Content | What the code does |
|------|---------|----------|
| T0 | System prompt | Reinserted after compaction (`agent.ts` `maybeCompact`) |
| T1 | Original task | Preserved in the summary's `## Task` (the prompt asks for the latest user instruction verbatim) |
| T2 | Key decisions | Prose under `## Decisions` |
| T3 | File changes | Prose under `## Files`; also the fidelity check's input (`compactor.ts` `trackFiles`) |
| T4 | Errors + fixes | Prose under `## Errors` |
| T5–T6 | Tool outputs | Flattened to `[tool result: first 200 chars]` inside the conversation handed to the summarizer |
| T7 | Recent conversation | Last 4+ messages kept verbatim (`keepBoundary`) |

### Structured compaction output

The summary is **heading-structured prose**, not YAML — the persisted
`CompactionSummary` (`sessions/store.ts` `appendCompaction`) carries the
prose `task`, a `files[]` list (from the fidelity tracker, not parsed out of
the prose), and empty `decisions`/`errors_resolved` buckets kept for format
compatibility:

```
## Task …
## Decisions …
## Files …
## Errors …
## Pending …
```

The LLM reads the prose summary and resumes without re-deriving history.

### Fidelity check — don't trust the summary

Files the session wrote are tracked (`compactor.ts` `trackFiles`) and checked
mechanically after summarizing (no LLM call): every tracked path must appear
in the summary text. On failure: regenerate once. On second failure: defer
compaction and keep the messages verbatim — a deferred compaction is
recoverable, a lossy one is not. Backstop: sessions are append-only
(session-spec.md), so compaction can only ever degrade the model's recall,
never destroy the transcript.

There is no todo/pending parsing: the live todo list is re-injected every
sub-turn from the TodoStore (`formatTodoBlock`), so the summary never needs
to carry it.

### Keep-boundary invariant (`keepBoundary`, compactor.ts)

Compaction keeps the last 4 messages verbatim — but the boundary must
**never land between an assistant `tool_calls` message and its `tool`
results**. A kept tail starting with a `tool` message is a hard 400 on
strict providers ("Messages with role 'tool' must be a response to a
preceding message with 'tool_calls'") and corrupts the in-memory history.

`keepBoundary(messages)` widens the keep count past any leading `tool`
messages. It is **exported and shared** by auto-compaction and the
`/compact` handler in cli.tsx: the manual path originally re-derived its own
slice and reintroduced the bug on a path the compactor's tests didn't cover.
Any new code choosing a compaction boundary must call `keepBoundary` rather
than slicing directly.

`/compact` must also **preserve the system message** it slices off before
summarizing — dropping it strips the agent's rules for the remainder of the
session (the auto path reinserts the stable preamble for the same reason).

### When to compact

1. **Threshold:** `threshold × contextWindow` is exceeded — checked before
   each provider call (default 0.7).
2. **User-driven:** `/compact` command.
3. **Resume-time:** the session-resume offer summarizes before replay.
4. `compaction.auto: false` disables only the automatic path.

### Request-time tool-result editing — off by default (2026-10-10)

Tool outputs are the #1 source of token bloat, so Nib has an editing pass that
replaces the contents of older tool results in a request-only copy: the three
newest consumed tool uses/results stay verbatim, every result from the
immediately preceding tool batch is protected too, and assistant tool-call
records stay in order (strict provider tool-call/result pairing).

**It is disabled unless `AgentOptions.contextEditing` is set, and nothing in
production sets it.** The edit costs more than it saves: the provider's prefix
cache ends at the first changed message, so rewriting the 4th-newest result on
every request made the three newest results re-pay uncached each time —
measured in onramp 2026-10-10, 1.16M of a session's 1.49M missed tokens (78%),
~76% cache hits against Claude Code's 99%, while cached input is ~50× cheaper
than uncached ($0.003 vs $0.15 per million). The module and its unit tests are
kept intact for a batched (`clear_at_least`-style) re-enable.

This is not compaction either way: `messages`, `newMessages`, the UI output,
and the append-only session transcript always retain complete tool output, and
compaction (`contextWindow × 0.7`) is the only size control in force. `/context`
reports `Context editing off (compaction only)` alongside the compaction
threshold.

---

_Part of the [subsystems deep dive](../subsystems.md)._
