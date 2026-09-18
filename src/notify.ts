import { redactSecrets } from "./sessions/redact.js";
import {
  buildChildEnvironment,
  containmentFailureError,
  prepareSandboxedCommand,
  spawnContained,
  unrefContained,
  type SandboxedShellOptions,
} from "./sandbox/launcher.js";

export type NotifySpawnOptions = SandboxedShellOptions;

// ── Notify hook ──
//
// Activates the `notify` config key (path to a notification script). When a
// turn/task completes or fails, the configured script is executed
// fire-and-forget with an injected env contract (see docs/notify-spec.md).
//
// SECURITY: `scriptPath` is user-config — it comes from settings.json and
// carries exactly the same trust level as the rest of that file (it can run
// arbitrary commands as the user). We never derive it from model output. The
// script is spawned with shell:false and an explicit argv, so nothing here
// interpolates untrusted text into a shell line; BODY/TITLE/FAIL_REASON reach
// the script only as environment variables (already secret-redacted for BODY).

const TITLE_MAX = 120;

export interface NotifyInput {
  /** "completed" for a normal turn end, "failed" when the turn threw,
   *  "job_done" when a background job finished (notify-spec.md §3). */
  status: "completed" | "failed" | "job_done";
  /** Turn duration in milliseconds; coerced to whole seconds. */
  durationMs: number;
  /** Raw text of the last assistant reply (redacted here). For "job_done",
   *  the tail of the job's accumulated output. */
  body: string;
  /** Session title, or the first-prompt prefix when there is no title. For
   *  "job_done", the job's command. */
  title: string;
  /** Failure reason text — only meaningful when status is "failed". */
  failReason?: string;
  /** User `env` block from settings (e.g. SLACK_WEBHOOK_URL), passed through. */
  passthroughEnv?: Record<string, string | undefined>;
  /** Background-job payload — present only when status is "job_done". */
  job?: { id: string; command: string; exitCode: number | null };
}

/**
 * Pure builder for the notify script's environment. Deterministic and
 * side-effect free so it can be unit-tested without spawning anything.
 *
 * - DURATION is a whole-second integer string.
 * - STATUS is "completed" | "failed" | "job_done".
 * - FAIL_REASON is present only on failure (and only when non-empty).
 * - BODY is the last assistant reply, secret-redacted (for "job_done", the
 *   tail of the job's output).
 * - TITLE is the session title / first-prompt prefix (for "job_done", the
 *   job's command), trimmed to a sane length.
 * - JOB_ID / JOB_COMMAND / JOB_EXIT are present only when status is
 *   "job_done"; JOB_COMMAND is secret-redacted (commands can carry inline
 *   secrets, e.g. curl -H "Authorization: Bearer …"), JOB_EXIT is omitted
 *   when the exit code is unknown (a killed job).
 * - The user `env` block is spread in first so our contract vars always win.
 */
export function buildNotifyEnv(input: NotifyInput): Record<string, string> {
  const env: Record<string, string> = {};

  // Pass through the user's env block (drop undefined values).
  for (const [k, v] of Object.entries(input.passthroughEnv ?? {})) {
    if (typeof v === "string") env[k] = v;
  }

  env.STATUS = input.status;
  env.DURATION = String(Math.max(0, Math.round(input.durationMs / 1000)));
  env.BODY = redactSecrets(input.body ?? "");
  env.TITLE = (input.title ?? "").slice(0, TITLE_MAX);

  if (input.status === "failed" && input.failReason) {
    env.FAIL_REASON = input.failReason;
  }

  if (input.status === "job_done" && input.job) {
    env.JOB_ID = input.job.id;
    env.JOB_COMMAND = redactSecrets(input.job.command ?? "").slice(0, TITLE_MAX);
    if (input.job.exitCode !== null) env.JOB_EXIT = String(input.job.exitCode);
  }

  return env;
}

/**
 * Fire the configured notify script, non-blocking. Never throws, never delays
 * the caller: a spawn failure or a non-zero exit degrades to at most a single
 * debug-level stderr line (only when `debug` is set). Detached + unref'd so the
 * script's lifetime is not tied to ours.
 */
export function fireNotify(
  scriptPath: string | undefined,
  input: NotifyInput,
  opts: { debug?: boolean; spawn?: NotifySpawnOptions } = {},
): void {
  if (!scriptPath) return;

  const notifyEnv = buildNotifyEnv(input);
  const spawnOptions = opts.spawn;

  try {
    // Keep the public helper's legacy behavior for callers that do not have a
    // session containment context yet. All production call sites pass the
    // session options below, which switch to the shared launcher and minimal
    // environment.
    const prefix = spawnOptions ? prepareSandboxedCommand(scriptPath, [], spawnOptions) : null;
    const contained = spawnContained(prefix, [scriptPath], {
      cwd: spawnOptions?.cwd ?? process.cwd(),
      env: {
        ...(spawnOptions ? buildChildEnvironment(spawnOptions.sessionTempDir) : process.env),
        ...notifyEnv,
      },
      // Fire-and-forget: no output stream is handed to a caller, and an
      // undrained pipe could block a chatty script.
      stdio: { stdout: "ignore", stderr: "ignore" },
      detached: true,
    });
    const child = contained.proc;
    // A notification must never hold the CLI open: the child and its pipes
    // (including the readiness pipe) are unref'd. Same swallow-on-throw
    // contract as before: an unapplied profile means the notification did not
    // fire, which is a debug-log fact, not a toast.
    unrefContained(contained);
    void contained.readiness.then((outcome) => {
      if (!outcome.ready && opts.debug) {
        process.stderr.write(`notify: ${containmentFailureError(outcome)}\n`);
      }
    });
    // Errors (e.g. ENOENT for a bad path) arrive asynchronously on 'error';
    // swallow them so an unhandled event never crashes the app.
    child.on("error", (err) => {
      if (opts.debug) process.stderr.write(`notify: spawn failed: ${err.message}\n`);
    });
  } catch (err) {
    if (opts.debug) {
      process.stderr.write(`notify: spawn failed: ${(err as Error).message}\n`);
    }
  }
}
