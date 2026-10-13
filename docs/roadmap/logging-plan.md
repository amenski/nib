# Roadmap — logging and data-model plan

**Status:** split out of [improvement-roadmap.md](../improvement-roadmap.md) on 2026-10-13 · the deepcode-cli PR #266 analysis: gap analysis, the JSONL-vs-SQLite decision, the data model and the phased plan.

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
  ([session-spec.md](../session-spec.md) / [permission-spec.md](../permission-spec.md))
  per the repo's one-spec-per-subsystem convention.
