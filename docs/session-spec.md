# Session Storage Specification

**Status:** current · verified 2026-09-15 · covers `src/sessions/store.ts`, `src/sessions/redact.ts`, `src/checkpoints/index.ts`

## 1. Overview

Sessions persist the conversation to disk so work survives process exit and
can be resumed with `--continue`/`--resume`. Compaction and checkpoints both
reference session state.

## 2. Storage layout

```
~/.nib/sessions/
└── <project-slug>/
    ├── 20260728T142301-ab3f.jsonl
    ├── 20260728T191045-c81d.jsonl
    ├── sessions-index.json          ← rebuildable cache
    └── ...
```

- **project-slug**: the absolute working directory with every
  non-alphanumeric character replaced by `-` (e.g. `/Users/x/proj` →
  `-Users-x-proj`). Slug collisions are tolerable because the true `cwd` is
  stored in the meta record.
- **One file per session.** Append-only JSONL: crash-safe (a torn last line
  is dropped on load), streams without parsing the whole file, and diffs
  cleanly.

## 3. Session ID

`<UTC timestamp, compact ISO>-<4 hex chars>`, e.g. `20260728T142301-ab3f`.

- Sortable by creation time via plain string sort.
- Human-readable in `ls` output — no opaque UUIDs.
- The filename **is** the ID.

## 4. Record types

Each line is one JSON object with a `type` field. Seven types: `meta`,
`message`, `state`, `compaction`, `permission`, `token`, `todo`.

### `meta` — always the first line

```json
{"type":"meta","version":1,"id":"20260728T142301-ab3f",
 "cwd":"/Users/x/proj","createdAt":"2026-07-28T14:23:01Z",
 "provider":"deepseek","model":"deepseek-v4-pro","mode":"code"}
```

`version` gates format migrations. A loader that sees a higher version than
it knows refuses with a clear error instead of misparsing.

### `message` — one canonical Message per line

```json
{"type":"message","at":"2026-07-28T14:23:05Z",
 "message":{"role":"user","content":"refactor auth to JWT"}}
```

The `message` field is exactly the canonical `Message` type from
`src/types.ts` — no session-specific message format. Messages are implicitly
indexed by order of appearance (0-based); `compaction` records reference
these indices. Message content is secret-redacted on write.

### `state` — mid-session changes

```json
{"type":"state","at":"...","mode":"code","model":"deepseek/deepseek-v4-pro"}
```

Appended when the user runs `/mode` or switches models. All fields
optional; on load, later records override earlier ones. Keeps `meta`
immutable.

### `compaction` — summary marker

```json
{"type":"compaction","at":"...","replacesThrough":12,
 "summary":{"task":"...","decisions":[...],"files":[...],"errors_resolved":[...]}}
```

`summary` is the structured compaction object (subsystems.md §2).
`replacesThrough` is the index of the last message the summary covers.
**History is never rewritten** — compaction appends a marker; the full
transcript stays on disk for rewind and audit.

### `permission` — audit trail entry

```json
{"type":"permission","at":"...","toolCallId":"call_1","tool":"run_bash",
 "subject":"rm -rf /","decision":"deny-by-rule",
 "reason":"deny rule matched (builtin-destructive)",
 "winningRule":{...},
 "source":"subagent"}
```

One row per permission decision. The canonical agent-emitted `decision`
vocabulary (one value per resolution path in `agent.ts`):

| `decision` | Meaning |
|---|---|
| `allow-by-rule` | An allow rule matched; the call ran with no prompt. |
| `allow-by-posture` | Auto-approve posture let an ordinary ask through (UI-side only; agent-side surfaces as `ask-approved`). |
| `ask-approved` | An interactive prompt was answered yes. |
| `ask-denied` | An interactive prompt was answered no. |
| `deny-by-rule` | A deny rule matched (destructive / guarded / config). |
| `headless-deny` | Resolved to ask but no interactive prompter was available (headless / sub-agent). |
| `unresolved-ask` | A bash segment couldn't be safely classified; fail-closed to ask, then approved. |

`subject` and `reason` are both secret-redacted. `winningRule` is the rule
that produced the outcome, absent on `defaultMode` fallthrough.

**`source` — writer identity (decision H, subsystems.md §7).** Rows written
by sub-agents spawned via `new_task` carry `"source":"subagent"`; top-level
(parent) rows omit the field. Readers must tolerate both. Sub-agent rows
are written by `agent.ts` through the orchestrator's audit-only view of the
parent store — see subsystems.md §7 for what the view allows.

**Legacy / UI-side values.** The finer-grained `"once" | "session" |
"always" | "deny"` are still accepted on read and write: the TUI writes
them for an interactively-answered prompt (it alone knows which button was
pressed), and older sessions carry them. Readers must tolerate both sets.

**Write sites & the interactive-path caveat.** `agent.ts` writes exactly
one row for *every* path it resolves. On the interactive approval path
`App.tsx` *also* writes its own finer-grained row — so an
interactively-approved call produces two rows. Intentional: the agent
guarantees a row exists on approval paths the UI never logs (notably
auto-approve posture, where `App.tsx` writes nothing). Queried via
`SessionStore.queryPermissionHistory(sessionId)`; surfaced via
`/permissions`.

Permission records are ignored by `load()`/`loadEffective()` — they don't
appear in the conversation and don't affect message indexing.

### `todo` — todo-list snapshot

```json
{"type":"todo","at":"...","todos":[{"content":"Add F feedrate capture","status":"pending"}]}
```

One row per `update_todo_list` call, written by the tool handler via
`SessionStore.appendTodo` (content secret-redacted per item). Queried via
`SessionStore.queryTodos` (chronological); on resume, the last snapshot is
restored into the panel and the model's first turn context
(`src/ui/App.tsx`). Ignored by `load()`/`loadEffective()`. Sub-agents
(`new_task`) get the parent store behind an audit-only view (subsystems.md
§7): `appendTodo` is blocked on the view, so their plans stay ephemeral and
never pollute the parent's session.

### `token` — per-turn token-usage entry

```json
{"type":"token","at":"...","turnTokens":4210,"totalUsed":88123,"budgetMax":200000,
 "source":"subagent"}
```

One row per model turn, written by `agent.ts` after the turn's assistant
message is assembled (`SessionStore.appendToken`).

- `turnTokens` — provider-reported input + output tokens for that turn.
- `totalUsed` — current context occupancy, measured with the same
  `estimateTokens` used by compaction, so `remaining = budgetMax -
  totalUsed` agrees with the headroom compaction sees.
- `budgetMax` — the context-window ceiling (default `128000`).
- `source` — optional writer identity: `"subagent"` for rows written by a
  sub-agent (`new_task`, decision H — subsystems.md §7); absent for
  top-level (parent) rows. Readers must tolerate both.

`remaining` is **derived on read**, never stored. Queried via
`SessionStore.queryTokenUsage(sessionId)`. Like `permission` rows, `token`
rows are ignored by `load()`/`loadEffective()`.

## 5. Sessions index (`sessions-index.json`)

A per-project cache that makes `/sessions` and `--continue` list richly
(titles, status, activity time) without re-scanning every JSONL on every
open. **The JSONL files are the source of truth; the index is a rebuildable
cache** — nothing is lost if it is deleted or corrupted.

```json
{
  "version": 1,
  "sessions": [
    {
      "id": "20260728T142301-ab3f",
      "title": "refactor auth to JWT",
      "createdAt": "2026-07-28T14:23:01Z",
      "updatedAt": "2026-07-28T14:41:12Z",
      "status": "completed",
      "messageCount": 14,
      "totalUsed": 88123,
      "budgetMax": 200000
    }
  ]
}
```

| Field | Source |
|---|---|
| `id` | The session's `meta.id` (== filename). |
| `title` | First **user** message, secret-redacted, truncated to **≤100 chars**. Overwritten by `renameSession` and preserved across further appends. |
| `createdAt` | `meta.createdAt`. |
| `updatedAt` | `at` of the last record on disk (falls back to `createdAt`). |
| `status` | Derived — see below. |
| `messageCount` | Count of `message` rows. |
| `totalUsed` / `budgetMax` | From the **last** `token` row, if any. |

### Status derivation

Derived purely from what the JSONL can tell us:

| `status` | Condition |
|---|---|
| `completed` | The last `message` row is an `assistant` (or `tool`) message — the last turn resolved. |
| `interrupted` | The transcript ends on a `user` message (turn started, never finished), or has no messages yet. |
| `failed` | The file has a **torn/incomplete final line** — a write was cut off. |

### Maintenance & corruption tolerance

- **Incremental.** `create()` and every `append()` recompute that one
  session's entry and merge it into the index, written **atomically**
  (temp file + `rename`). Index-update failures are swallowed — a stale
  cache is repaired on the next `list()`.
- **Corruption-tolerant.** A missing or unparseable index is treated as a
  cache miss and **rebuilt from the JSONL scan** (`rebuildIndex`).
  User-set titles are preserved across a rebuild.
- **Freshness.** `list()` uses the index when its `id` set exactly matches
  the `*.jsonl` files on disk; otherwise it rebuilds.
- **Rename.** `renameSession(id, title)` sets a custom title (redacted +
  truncated) in the index. Returns `false` for an unknown session.
- **Delete.** `deleteSession` prunes the entry from the index
  (best-effort).

Both the incremental update and the full rebuild go through the **same**
`deriveEntry` scan, so the index can never disagree with a from-scratch
scan (a tested equivalence).

## 6. What is persisted vs. rebuilt

| Item | Persisted? | Why |
|------|-----------|-----|
| user / assistant / tool messages | Yes | The conversation itself |
| System prompt | **No** | Rebuilt on load from current config + mode + memory. Persisting it would freeze stale modes/skills into resumed sessions. |
| Tool definitions | No | Derived from active mode |
| Active mode / model | Yes (`meta` + `state`) | Sticky across resume |
| Compaction summaries | Yes | Resume must not re-summarize |

Writes happen **after each message is complete** (user input accepted,
assistant turn done, tool result returned) — never mid-stream. A crash
loses at most the in-flight turn.

## 7. Loading a session

1. Read all lines; skip a torn final line (incomplete JSON) with a warning.
2. First line must be `meta` with a known `version`.
3. Fold `state` records into meta (last wins) → active mode/model.
4. Collect `message` records in order.
5. If any `compaction` records exist, take the **last** one; the effective
   conversation = `[summary rendered as a user message] +
   messages[replacesThrough+1..]`. Otherwise, effective conversation = all
   messages.
6. Prepend a freshly built system prompt (system-prompt.md).
7. Print a one-line recap: `Resumed 20260728T142301-ab3f · 14 messages ·
   mode: code`.

## 8. Checkpoint interplay

Checkpoints live in the shadow Git repo, keyed by session ID
(`~/.nib/checkpoints/<sessionId>/`). Each checkpoint commit message
records the message index at checkpoint time. `restore full` truncates the
effective conversation to that index — implemented by appending a `state`
record `{"truncateAt": N}`, never by deleting lines.

### Resource bounds (`src/checkpoints/index.ts`)

The shadow repo is not allowed to grow without limit; two guards enforce that.

- **Entry cap.** `save()` counts `git status --porcelain -uall` and skips the
  checkpoint above `MAX_CHECKPOINT_ENTRIES` (5000), printing one stderr notice
  per session. `-uall` is load-bearing, not cosmetic: the default
  `--porcelain` collapses an untracked directory to one line, so `$HOME`
  reports 206 entries by default and 1,146,894 with `-uall` (this repo: 404).
  A cap on the default count would never have fired on the case it exists to
  prevent. A capped workspace simply has no checkpoints, so `/undo` reports
  nothing to undo rather than restoring partially.
- **No repacking.** `gc.auto=0` is applied to every shadow-repo git
  invocation, and `initialize()` sweeps any stranded `tmp_pack_*`. A killed
  `git repack` writes its output to `tmp_pack_<rand>` and only renames it on
  success, so an interrupted one leaves a full-size dead file that nothing
  would ever collect.

### Secret filename backstop

The shadow repository adds a defense-in-depth `.git/info/exclude` backstop
even when the workspace has no `.gitignore`. It excludes common environment
files, private-key and keystore extensions, package/repository credential
files (`.npmrc`, `.netrc`, `.pypirc`, `.git-credentials`), Docker/Kubernetes/
cloud credential paths, Terraform state and credential files, Vault tokens,
and service-account JSON. The list is intentionally finite and filename/path
based: it is not content scanning and cannot identify a secret stored under an
unfamiliar name or inside an ordinary file. The workspace `.gitignore` remains
the primary control. Resumed shadow repos are brought up to date with the
backstop; if it cannot be read or written, checkpointing fails closed. Existing
shadow history is not rewritten or scrubbed.

Incident 2026-08-17: two sessions whose cwd was `$HOME` (235 GB) hit both gaps
at once — `git add -A` staged 14 GB, and an interrupted repack stranded
14.5 GB and 12.4 GB `tmp_pack` files, 26 GB total. Neither had any bound before
this.

## 9. CLI surface

| Command | Behavior |
|---------|----------|
| `nib` | New session |
| `nib --continue` / `-c` | Resume the most recent session for this cwd |
| `nib --resume [id]` / `-r` | Resume a specific session (or open the picker) |
| `/sessions` | List this project's sessions from the index: status marker, title, relative activity time, message count. Ctrl+R renames; Del deletes. |
| `/new` | Save current, start fresh |

Session titles default to the first user message, secret-redacted and
truncated to 100 chars — no LLM call — and are user-renamable.

Retention: keep everything. Sessions are small text files; pruning is
post-MVP.

## 10. Design decisions

1. **JSONL append-only vs. rewrite-on-save JSON.** Append is crash-safe and
   O(1) per message; rewriting a growing file every turn is O(n²) and can
   corrupt on crash. Decision: JSONL.
2. **System prompt rebuilt, not persisted.** A resumed session should get
   current modes, skills, and memory — not a snapshot from last week.
   Tradeoff: prompt changes between sessions can shift behavior mid-task.
   Acceptable.
3. **Compaction as marker, not rewrite.** Preserves the audit trail, makes
   checkpoints' `restore full` possible, and keeps writes append-only.
4. **Per-project directories vs. one flat pool.** Listing "sessions for
   this repo" is the common query; the filesystem is the index. Matches
   the memory architecture's per-project layout (subsystems.md §1).
