## 2. Context Management — Beyond Token Counting

**Status:** current · verified 2026-09-14 · covers `src/compaction/{budget,compactor,context-editing}.ts`

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

### What to keep during compaction

| Tier | Content | Strategy |
|------|---------|----------|
| T0 | System prompt, mode, tool defs | **Never compact** |
| T1 | User's original task | **Compress, never delete** |
| T2 | Key decisions | **Extract to decision log** |
| T3 | File changes | **Extract to change log** |
| T4 | Errors + fixes | **Extract to error log** |
| T5 | Tool outputs (old) | **Prune, keep 1-sentence summary** |
| T6 | Tool outputs (recent) | **Keep verbatim** |
| T7 | Recent conversation | **Keep verbatim** |

### Structured compaction output

Compaction produces structured data, not prose:

```yaml
compacted:
  task: "Refactor auth module to use JWT"
  decisions:
    - what: "Use RS256 asymmetric signing"
      why: "Enables key rotation without shared secrets"
  files:
    - path: src/auth/jwt.ts
      action: created
      summary: "JWT sign/verify with RS256, 120 lines"
  errors_resolved:
    - error: "Type 'string' is not assignable to 'KeyLike'"
      fix: "Added type assertion for private key import"
  pending: []
```

The LLM reads the decision log, checks which files changed, and resumes
without re-deriving history.

### Fidelity check — don't trust the summary

A summary that silently drops an unresolved error or a changed file is worse
than no compaction. After generating, verify mechanically (no LLM call):

1. Every file path in the messages being compacted appears in `files[]`.
2. Every todo item not marked complete appears in `pending[]`
   (compaction-summary fidelity only — the live per-sub-turn view of the
   current list rides in the volatile prefix, not the summary; see
   tool-spec.md).
3. `task` is non-empty and derived from the original request.

On failure: regenerate once, naming the misses. On second failure: defer
compaction and keep the messages verbatim — a deferred compaction is
recoverable, a lossy one is not. Backstop: sessions are append-only
(session-spec.md), so compaction can only ever degrade the model's recall,
never destroy the transcript.

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

### Request-time tool-result editing

Tool outputs are the #1 source of token bloat:

When an assembled provider request reaches 100,000 estimated input tokens,
Nib creates a request-only copy that replaces the contents of older tool
results with an explicit cleared placeholder. The three newest consumed tool
uses/results remain verbatim, and every result from the immediately preceding
tool batch is protected too, so a newly produced result is always complete on
the immediately following provider request. Assistant tool-call records stay
in order, preserving strict provider tool-call/result pairing.

This is not compaction: `messages`, `newMessages`, the UI output, and the
append-only session transcript retain complete tool output. `/context` reports
both the 100,000-token editing trigger and the separate model-relative
compaction threshold.

---

_Part of the [subsystems deep dive](../subsystems.md)._
