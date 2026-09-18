import { spawn, type ChildProcess } from "node:child_process";
import type { ToolOutput, ToolDef } from "../types.js";
import type { ToolHandler } from "./types.js";
import { ToolRegistry } from "./registry.js";
import { jobManager, killTree, appendCapped, DEFAULT_TIMEOUT_MS } from "./jobs.js";
import {
  buildSandboxProfile,
  isSandboxedLevel,
  sandboxEnvelopeHash,
  sandboxPrefix,
  validateCwdWithinTrustedRoot,
  type SandboxLevel,
} from "../sandbox/seatbelt.js";
import { containmentFailureError, spawnContained, type ReadinessOutcome, type SandboxFailureReason } from "../sandbox/launcher.js";
import { envelopeChangedError } from "../permissions/session-grant.js";
import { wrapUntrusted, sanitizeControlChars } from "./untrusted-content.js";

const RUN_BASH_TIMEOUT_MS = 120_000;
// run_bash keeps the most recent 512KB of output (the old exec maxBuffer
// contract); on overflow the tail is kept and a note is added instead of
// killing the process.
const MAX_BASH_OUTPUT_CHARS = 512 * 1024;

// F5 delta (2026-08-15): non-zero exits with non-empty stderr set `error`
// (so the reflector/streak/repeat guards engage) and the content gets a
// compact grepped <error_analysis> block — the last 20 stderr lines matching
// common error signatures, plus the exit line. Silent non-zero exits
// (grep -q / diff / test idioms) keep the old content-only shape.
const ERROR_LINE_RE = /error|failed|fatal|exception|undefined|no such|unable|cannot/i;
const MAX_ERROR_ANALYSIS_LINES = 20;

function buildErrorAnalysis(stderr: string, exitCode: number | null): string {
  const matched = stderr
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && ERROR_LINE_RE.test(line))
    .slice(-MAX_ERROR_ANALYSIS_LINES);
  if (matched.length === 0) return "";
  return `<error_analysis>\nExit code: ${exitCode}\n${matched.join("\n")}\n</error_analysis>\n`;
}

// Commands that look interactive — editors, pagers, monitors, and stdin-driven
// CLIs (git credential prompts, psql/mysql/sqlite3, sleep) — are killed on
// timeout instead of migrated to the background, where they would sit as a job
// waiting on input that never arrives. Bare shells and REPLs (bash, node,
// python…) kill only when invoked with no script operand: `node server.js` is
// a dev server and migrates like any other command, `node` is a REPL.
const ALWAYS_INTERACTIVE = new Set([
  "vim", "vi", "nano", "emacs", "less", "more", "htop", "top", "man", "watch",
  "psql", "mysql", "sqlite3", "git", "sleep",
]);
const REPLS = new Set([
  "bash", "sh", "zsh", "fish", "node", "python", "python3", "ipython", "irb", "bc",
]);

function looksInteractive(command: string): boolean {
  const tokens = command.trim().split(/\s+/);
  const first = tokens[0] ?? "";
  if (ALWAYS_INTERACTIVE.has(first)) return true;
  if (REPLS.has(first)) {
    const hasOperand = tokens.slice(1).some((t) => !t.startsWith("-"));
    return !hasOperand;
  }
  return false;
}

/**
 * commands.timeoutToBackground (plan §3, decision D — default ON): when
 * run_bash hits its timeout cap, move the process to JobManager instead of
 * killing it. `undefined` (key absent) means the default — ON.
 */
export function resolveTimeoutToBackground(v: boolean | undefined): boolean {
  return v !== false;
}

/**
 * Run a command with an explicit timeout, accumulating capped output. When the
 * timeout fires with `timeoutToBackground` true and the command does not look
 * interactive, the child is handed to JobManager instead of killed, and the
 * result tells the model to poll check_job. Exported for tests — the
 * registered handler passes the config-derived flag and the fixed 120s cap.
 *
 * `sandboxLevel` (permission-profile.md §8, phase (e)): when set, the child
 * spawns under a Seatbelt profile (`sandbox-exec -p <profile> /bin/sh -c …`)
 * enforcing the level's fs/network defaults mechanically. Sandboxing is a
 * spawn-time property — a timeout-migrated child keeps it because it is the
 * same process, already sandboxed.
 *
 * `trustedRoot` is the Seatbelt write-set root for sandboxed spawns — the
 * session workspace root fixed at startup (the handler's `ctx.workingDir`),
 * never the per-call cwd. A sandboxed spawn whose cwd realpath-resolves
 * outside it (item 8.6) is rejected before spawning: tool error, no spawn,
 * no profile.
 *
 * `writeRoots` is the configured `sandbox.writeRoots` list (docs/unified-
 * write-boundary.md), threaded from `ctx.writeRoots` so the Seatbelt
 * write-set for this spawn agrees with the file-tool containment check.
 *
 * `allowGitConfigWrite` is the approved-operation grant (release gate 2): it
 * comes from `exec.approvedGitConfigWrite`, which only agent.ts sets, and
 * only when the user approved *this* call at the prompt. It widens one spawn
 * — workspace-scoped `.git/config` writes — so an approved `git init` /
 * `remote add` / `config` works without re-opening the always-denied set.
 *
 * `onSandboxFailure` likewise comes from `exec`, and is set on every sandboxed
 * launch: a child that never confirmed its profile means the machine refused to
 * apply it, so the verdict is reported to the agent gate, which revokes any
 * session grant approved against that profile.
 */
export function runBashTimed(
  command: string,
  cwd: string,
  trustedRoot: string,
  timeoutMs: number,
  timeoutToBackground: boolean,
  sandboxLevel?: SandboxLevel,
  writeRoots?: string[],
  sessionTempDir?: string,
  allowGitConfigWrite?: boolean,
  onSandboxFailure?: (reason: SandboxFailureReason) => void,
): Promise<ToolOutput> {
  if (isSandboxedLevel(sandboxLevel)) {
    const checked = validateCwdWithinTrustedRoot(cwd, trustedRoot, writeRoots);
    if (!checked.ok) return Promise.resolve({ content: "", error: checked.error });
  }
  let proc: ChildProcess;
  let readiness: Promise<ReadinessOutcome>;
  try {
    const env = sessionTempDir ? { ...process.env, TMPDIR: sessionTempDir, TMP: sessionTempDir, TEMP: sessionTempDir, npm_config_cache: `${sessionTempDir}/npm-cache` } : undefined;
    const sandbox = sandboxPrefix(command, cwd, trustedRoot, sandboxLevel, writeRoots, sessionTempDir, allowGitConfigWrite);
    if (sandbox) {
      // Containment (docs/permission-ux-redesign.md): the readiness frame
      // wraps the same `/bin/sh -c <command>` argv this path has always
      // produced, so the command itself is unchanged — only the launcher in
      // front of it is new.
      const contained = spawnContained(sandbox, ["/bin/sh", "-c", command], { cwd, env, detached: true });
      proc = contained.proc;
      readiness = contained.readiness;
    } else {
      // No profile applies: exactly the previous spawn, with no frame and
      // nothing to wait for.
      proc = spawn(command, {
        cwd,
        shell: true,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env,
      });
      readiness = Promise.resolve({ ready: true });
    }
  } catch (err) {
    return Promise.resolve({ content: `Exit code: -1\nFailed to start: ${(err as Error).message}` });
  }

  return new Promise<ToolOutput>((resolve) => {
    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let settled = false;
    // The command's outcome is held until readiness settles, because a profile
    // that never applied must not be reported as an ordinary non-zero exit —
    // and both arrive as the same events. One decision point reads every
    // outcome, instead of separate handlers racing to resolve first.
    let read: ReadinessOutcome | undefined;
    let closeCode: number | null | undefined;
    let spawnError: Error | undefined;
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    const truncationNote = () =>
      stdoutTruncated || stderrTruncated ? "\n(output truncated — kept last 512KB)" : "";

    const finish = (): void => {
      const outcome = read;
      if (settled || outcome === undefined) return;
      if (!outcome.ready) {
        // Containment could not be confirmed, so the command never ran: there
        // is no output to interpret and nothing to retry outside the sandbox.
        // The raw sandbox-exec stderr below is supplementary detail — the
        // absent signal is the evidence, not a pattern match on stderr.
        settled = true;
        clearTimeout(timer);
        killTree(proc);
        onSandboxFailure?.("containment-not-applied");
        resolve({
          content: wrapUntrusted(`${containmentFailureError(outcome)}${stderr ? `\n${stderr}` : ""}`),
          error: "SANDBOX_NOT_APPLIED",
        });
        return;
      }
      if (closeCode !== undefined) {
        settled = true;
        clearTimeout(timer);
        if (closeCode === 0) {
          resolve({ content: wrapUntrusted(`${stdout || "(no output)"}${truncationNote()}`) });
        } else if (stderr.trim() !== "") {
          // F5 delta: real failure (non-zero + stderr) — set `error` so the
          // bounded auto-fix loop engages, and prepend the grepped
          // <error_analysis> block inside the untrusted delimiters (the matched
          // lines are still command output). The full stdout/stderr body is kept.
          const analysis = buildErrorAnalysis(stderr, closeCode);
          resolve({
            content: wrapUntrusted(`${analysis}Exit code: ${closeCode}\n${stdout}\n${stderr}${truncationNote()}`),
            error: `Exit code: ${closeCode}`,
          });
        } else {
          // Silent non-zero exit (empty stderr) — grep -q / diff / test idioms:
          // content only, no error, no analysis block.
          resolve({ content: wrapUntrusted(`Exit code: ${closeCode}\n${stdout}\n${stderr}${truncationNote()}`) });
        }
        return;
      }
      if (timedOut) {
        settled = true;
        if (timeoutToBackground && !looksInteractive(command)) {
          // The child keeps running; JobManager takes over its streams and the
          // model polls check_job for the rest of the output.
          const adopted = jobManager.adopt(proc, {
            command,
            cwd,
            timeoutMs: DEFAULT_TIMEOUT_MS,
            stdout,
            stderr,
          });
          if (adopted.ok) {
            resolve({
              content: `Command exceeded ${Math.ceil(timeoutMs / 1000)}s timeout — moved to background as job ${adopted.id}. Use check_job with job_id "${adopted.id}" to poll status and output; kill_job to terminate it.`,
            });
            return;
          }
          // Adoption failed (job cap) — fall through to the kill path.
        }
        killTree(proc);
        // Same shape the old exec-based handler produced on a timeout kill.
        resolve({ content: wrapUntrusted(`Exit code: null\n${stdout}\n${stderr}`) });
        return;
      }
      if (spawnError) {
        settled = true;
        clearTimeout(timer);
        resolve({ content: `Exit code: -1\nFailed to start: ${spawnError.message}` });
      }
    };

    // Terminal-control sanitization (T14) happens here, at the single choke
    // point where command output enters the buffers — before the T12 wrapper,
    // so model context and every display path get clean text. Sanitizing per
    // chunk is safe across chunk boundaries: ESC (0x1b) itself is stripped, so
    // a sequence split between chunks leaves only inert text fragments.
    proc.stdout?.on("data", (chunk: Buffer) => {
      if (settled) return;
      stdout = appendCapped(stdout, sanitizeControlChars(chunk.toString()), () => { stdoutTruncated = true; }, MAX_BASH_OUTPUT_CHARS);
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      if (settled) return;
      stderr = appendCapped(stderr, sanitizeControlChars(chunk.toString()), () => { stderrTruncated = true; }, MAX_BASH_OUTPUT_CHARS);
    });
    // Recorded rather than resolved on the spot: a child that never started
    // cannot have confirmed a profile, so the readiness outcome decides which
    // failure this is.
    proc.on("error", (err) => {
      spawnError = err;
      finish();
    });
    // 'close' rather than 'exit', same reasoning as jobs.ts (d864909): 'exit'
    // fires when the process terminates, before the stdout/stderr 'data'
    // handlers above have necessarily drained the pipes — so resolving there
    // can hand back an exit code with truncated or empty output. 'close' waits
    // for the stdio streams to close, so the buffers are complete.
    proc.on("close", (code) => {
      closeCode = code;
      finish();
    });

    timer = setTimeout(() => {
      timedOut = true;
      finish();
    }, timeoutMs);

    void readiness.then((outcome) => {
      read = outcome;
      finish();
    });
  });
}

const runBashHandler: ToolHandler = async (args, ctx, exec) => {
  const command = args.command as string;
  // The trusted root is the workspace fixed at startup (item 8.6): the
  // Seatbelt write-set root is ctx.workingDir, never a model-passed cwd.
  const root = ctx.workingDir || process.cwd();
  const cwd = (args.cwd as string) || root;
  // The session grant was consent for one envelope: this check launches nothing
  // unless the profile this call would run under is the profile that was
  // approved (docs/permission-ux-redesign.md — "actual child launch must use
  // the envelope that was approved"). The launch derives its profile from the
  // live context, so an envelope that drifted after consent — a changed write
  // root or level — is caught here rather than inheriting the old approval.
  if (exec?.envelopeHash !== undefined) {
    const live = isSandboxedLevel(ctx.sandboxLevel)
      ? sandboxEnvelopeHash(
          buildSandboxProfile(ctx.sandboxLevel, root, ctx.writeRoots, ctx.sessionTempDir, exec.approvedGitConfigWrite),
        )
      : null;
    if (live !== exec.envelopeHash) {
      exec.onSandboxFailure?.("envelope-changed");
      return { content: wrapUntrusted(envelopeChangedError()), error: "SANDBOX_ENVELOPE_CHANGED" };
    }
  }
  return runBashTimed(command, cwd, root, RUN_BASH_TIMEOUT_MS, resolveTimeoutToBackground(ctx.timeoutToBackground), ctx.sandboxLevel, ctx.writeRoots, ctx.sessionTempDir, exec?.approvedGitConfigWrite, exec?.onSandboxFailure);
};

const runBashDef: ToolDef = {
  name: "run_bash",
  description: "Execute a shell command. Returns stdout and stderr. Commands that exceed the 120s timeout are moved to the background and return a job id to poll with check_job (unless they look interactive, e.g. editors/sleep, or timeoutToBackground is disabled).",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "The command to execute" },
      cwd: { type: "string", description: "Working directory (optional)" },
    },
    required: ["command"],
  },
};

export function registerBash(registry: ToolRegistry): void {
  registry.register({ def: runBashDef, handler: runBashHandler, groups: ["command"] });
}
