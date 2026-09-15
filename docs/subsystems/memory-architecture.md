## 1. Memory Architecture

**Status:** current · verified 2026-08-13 · covers `src/memory/store.ts`

### Problem

An agent that forgets everything between sessions is a calculator, not an
assistant. It should remember: project conventions, past decisions, user
preferences, and common pitfalls.

### Options evaluated

| Approach | Pros | Cons | Used by |
|----------|------|------|---------|
| Vector DB (Chroma, LanceDB) | Semantic search, scales well | Complex, opaque, hard to debug | Cody, cursor |
| SQLite | Structured, queryable | Schema migrations, not human-readable | — |
| Markdown files (Obsidian) | Human-readable, portable, linkable | Manual search without embeddings | opencode |
| Hybrid: MD + embeddings | Best of both | Complexity, two sources of truth | — |

### Decision: Markdown files (+ optional embeddings later)

**Storage** (`src/memory/store.ts`): per-project dir
`~/.nib/memory/<project-slug>/` plus a global `MEMORY.md` index:

```
~/.nib/memory/
├── MEMORY.md              # Index: one line per memory file
└── <project-slug>/
    ├── sessions.md        # Rolling session log, newest first
    ├── decisions.md       # Key architectural decisions
    ├── patterns.md        # "This project uses X pattern"
    └── pitfalls.md        # "Don't edit this file, it's generated"
```

`appendSession()` prepends dated entries to `sessions.md` (called at session
end, `src/cli.tsx:322`); `writeFact()` appends to `decisions.md` /
`patterns.md` / `pitfalls.md`.

### Loading strategy

1. On session start: `getInjection()` builds a **≤1,024-token block** — the
   `MEMORY.md` index head (first 20 lines) plus per-file content with
   truncation — injected into the stable preamble (system-prompt.md §8).
2. Facts beyond the cap remain reachable by reading the memory directory
   directly.

### Write policy

- The user saying "remember X" is written immediately.
- Session summaries are appended at session end.
- Facts derivable from the repo (code structure, git history, anything in
  docs/) are skipped — memory holds what the repo cannot tell you.

### Future

Add LanceDB for semantic search when memory exceeds ~50 files. Start with
grep over markdown — it's fast enough for hundreds of files.

---

_Part of the [subsystems deep dive](../subsystems.md)._
