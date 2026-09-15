## 6. Failure Modes & Robustness

**Status:** current · verified 2026-08-13 · covers `src/agent.ts`, `src/providers/aisdk.ts`, `src/errorrecovery/`, `src/selfreflection/`

What happens when things break. Each policy lives here; the affected spec
(tool-spec, provider-spec) carries the matching contract.

### Provider failures

The AI SDK wrapper retries internally (`maxRetries: 3`,
`src/providers/aisdk.ts`). Beyond that, the loop classifies:

| Class | Examples | Policy |
|-------|----------|--------|
| Transient | ECONNRESET, "terminated", stream cut mid-response | Surfaced as a diagnostic (`connection lost: …`), turn ends `aborted`; the user can retry the prompt — no crash (`isTransientNetworkError`, `src/agent.ts`) |
| Fatal | 401/403 (bad key), 404 (bad model), invalid request | Fail immediately with the provider's message; headless prints one concise stderr line (`src/exec-runner.ts`) |

A mid-stream failure discards the partial turn. Safe because sessions
persist only completed turns (session-spec.md).

### Tool failures

- **Never throw** — handlers return `ToolOutput { content, error? }`
  (tool-spec.md §2).
- **Self-reflection** — a failed tool result triggers one reflection retry
  before the user sees it (`src/selfreflection/`); permission-denied errors
  are not retried.
- **Loop detection** — the identical failing call 4× trips loop detection;
  5 consecutive failures end the turn with a system note
  (`src/agent.ts`).
- **Malformed tool-call JSON** — `src/errorrecovery/` injects a correction
  prompt; with no recovery wired, raw args pass through as `_raw`.

### Stale-file detection

Edit tools refuse to write a file changed on disk since the model last read
it (`FILE_MODIFIED`, tool-spec.md §4) — the mechanical enforcement of
read-before-write.

### Degradation rules

- **One instance per repo.** Two concurrent nibs in one workingDir
  race on files and checkpoints; not detected in v1 (a lockfile is trivial
  later).
- **Platform: macOS/Linux.** `run_bash` assumes a POSIX shell; Windows is
  untested and out of scope until someone cares.

---

_Part of the [subsystems deep dive](../subsystems.md)._
