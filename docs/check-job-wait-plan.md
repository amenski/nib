# check_job Wait Plan

**Status:** implemented · 2026-10-25 · steps 1–5 done, live acceptance (§6) not run.
Covers `check_job` blocking until a background job finishes, so the model
stops polling it in a loop.

## 1. Goal

Stop the model from calling `check_job` back-to-back while a background job
(usually a build) is still running. One call should cover the wait.

This changes the `check_job` tool and its descriptions only. It does not
change how jobs start, run, time out, or report to the UI and notify hook.

## 2. Evidence

Session `~/.nib/sessions/-Users-amanuel-Documents-prg-proj-vault/2026-10-20T0845-9f6c.jsonl`
(one full day, deepseek-flash):

- 149 `check_job` calls over 14 jobs; **141 returned `Status: running`**.
- Up to 30 consecutive calls on one job, with no other tool call between.
- The jobs were almost all `flutter build apk|appbundle`, plus one
  `python3 -m http.server`.
- The polls carried ~46M context tokens (~3.7% of the day's input). Mostly
  cache hits, so ~$0.15–0.20 (estimate, ~2–3% of the day's cost). Each poll
  is also a full model round trip; wall-clock cost is unmeasured because the
  session log timestamps are written in batches.

## 3. Root cause

1. `checkJobHandler` (`src/tools/jobs.ts`) returns the current status
   immediately.
2. Both tool texts tell the model to poll: the `run_bash_background` result
   ("Use check_job … to poll status") and the `run_bash_background`
   description ("use check_job to poll status").
3. Job completion reaches the UI (`src/ui/App.tsx`, `jobManager.onCompleted`)
   and the notify hook (`src/cli.tsx`), never the model. Polling is the
   model's only way to learn a job ended.

## 4. Decisions

1. **`check_job` waits; nothing is pushed into the conversation.** Injecting
   a completion message (option B) would let the model keep working, but an
   idle model would need nib to start a turn on its own, which the
   "UI actions must not start turns" rule forbids. Revisit only if logs show
   the model idling while it waits.
2. **`wait_seconds` parameter, default 30, clamped to 0–300.** The call
   returns as soon as the job leaves `running`, so a short job costs no extra
   time. 0 keeps today's instant behaviour, for servers that never exit.
3. **Esc cancels the wait.** The wait listens on `ctx.signal`
   (`src/tools/index.ts`) and returns the current status when aborted.
4. **The job is never touched by the wait.** Timing out the wait does not
   kill or time out the job; the job keeps its own `timeoutMs`.

## 5. Steps

Sonnet implements, Opus reviews each diff.

1. `JobManager.waitFor(id, ms, signal): Promise<void>` in `src/tools/jobs.ts`.
   Resolves when the job leaves `running` (via `onCompleted`, filtered by id),
   after `ms`, or on abort. Resolves at once for an unknown or finished job.
   Always unsubscribes and clears its timer.
   → verify: unit tests (step 4).
2. `checkJobHandler` reads `wait_seconds` (default 30, clamp 0–300, non-number
   → default), calls `waitFor`, then builds the report as today, with one
   added line `Waited: Xs`.
   → verify: a 2 s job returns `done` in ~2 s, not 30.
3. Tool texts:
   - `check_job` description and a `wait_seconds` property: waits up to 30 s
     for the job to finish; do not call it back-to-back; pass 0 for servers.
   - `run_bash_background` description and result text: replace "poll".
   → verify: tool-definition assertion in tests.
4. Tests in `src/tools/jobs.test.ts`: returns early on completion; times out
   with `running`; `wait_seconds: 0` returns immediately; abort returns
   quickly; unknown id still errors. Poll to a deadline instead of fixed
   sleeps.
   → verify: `npx tsc --noEmit` and the full vitest suite green.
5. `docs/tool-spec.md` (check_job section) and `CHANGELOG.md` Unreleased.

## 6. Acceptance

- Live: headless `nib -p` asked to run `sleep 45 && echo ok` with
  `run_bash_background` and report when done. The session log shows
  **≤ 2** `check_job` calls (expected today: ~30 or more).
- A dev server started in the background can still be checked instantly
  with `wait_seconds: 0`.

## 7. Out of scope

- Pushing job completion into the conversation (option B, §4.1).
- Streaming partial job output to the model.
- Changing job timeouts, the job cap, or output buffering.
