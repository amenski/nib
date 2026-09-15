## 5. Session Lifecycle

**Status:** current · verified 2026-08-13 · covers `src/sessions/store.ts`, `src/cli.tsx`, `src/exec-runner.ts`

```
NEW SESSION
  │
  ├── Load config (~/.nib/settings.json + ./.nib/settings.json)
  ├── Load modes (~/.nib/modes/, ./.nib/modes/)
  ├── Load project memory (~/.nib/memory/<project-slug>/)
  │     └── Inject ≤1024-token memory block into the stable preamble
  ├── Build RepoMap snapshot (≤4 KB)
  │
  ▼
RUNNING
  │
  ├── User input → plan (update_todo_list) when multi-step
  ├── Execute plan (ReAct + Reflect loop, §3)
  ├── Compact when threshold trips (§2)
  ├── Checkpoint save at each turn start
  │
  ▼
END SESSION
  │
  ├── Session JSONL flushed (meta|message|state|compaction|permission|token records)
  ├── Append session summary to memory sessions.md (src/cli.tsx:322)
  └── Final checkpoint
```

### Storage

Per-session append-only JSONL at
`~/.nib/sessions/<slug>/<id>.jsonl` with a `sessions-index.json` cache.
Record types, secret redaction, torn-line → `failed` status, and resume
semantics: session-spec.md.

### Resuming a session

1. Load the session's records and replay compaction overlays
   (`loadEffective`, `src/sessions/store.ts`).
2. Present a load/compact choice before replaying the transcript.
3. The user continues or starts fresh (`-r`, `-c`, `/resume`, `/continue` —
   cli-spec.md).

---

_Part of the [subsystems deep dive](../subsystems.md)._
