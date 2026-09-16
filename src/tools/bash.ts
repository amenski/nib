import { spawn, type ChildProcess } from "node:child_process";
import type { ToolOutput, ToolDef } from "../types.js";
import type { ToolHandler } from "./types.js";
import { ToolRegistry } from "./registry.js";
import { jobManager, killTree, appendCapped, DEFAULT_TIMEOUT_MS } from "./jobs.js";
import {
  isSandboxedLevel,
  sandboxPrefix,
  validateCwdWithinTrustedRoot,
  type SandboxLevel,
} from "../sandbox/seatbelt.js";
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
): Promise<ToolOutput> {
  if (isSandboxedLevel(sandboxLevel)) {
    const checked = validateCwdWithinTrustedRoot(cwd, trustedRoot, writeRoots);
    if (!checked.ok) return Promise.resolve({ content: "", error: checked.error });
  }
  let proc: ChildProcess;
  try {
    const sandbox = sandboxPrefix(command, cwd, trustedRoot, sandboxLevel, writeRoots, sessionTempDir);
    const env = sessionTempDir ? { ...process.env, TMPDIR: sessionTempDir, TMP: sessionTempDir, TEMP: sessionTempDir, npm_config_cache: `${sessionTempDir}/npm-cache` } : undefined;
    if (sandbox) {
      proc = spawn(sandbox.file, sandbox.args, {
        cwd,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env,
      });
    } else {
      proc = spawn(command, {
        cwd,
        shell: true,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env,
      });
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
    const truncationNote = () =>
      stdoutTruncated || stderrTruncated ? "\n(output truncated — kept last 512KB)" : "";

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
    proc.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ content: `Exit code: -1\nFailed to start: ${(err as Error).message}` });
    });
    // 'close' rather than 'exit', same reasoning as jobs.ts (d864909): 'exit'
    // fires when the process terminates, before the stdout/stderr 'data'
    // handlers above have necessarily drained the pipes — so resolving there
    // can hand back an exit code with truncated or empty output. 'close' waits
    // for the stdio streams to close, so the buffers are complete.
    proc.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve({ content: wrapUntrusted(`${stdout || "(no output)"}${truncationNote()}`) });
      } else if (stderr.trim() !== "") {
        // F5 delta: real failure (non-zero + stderr) — set `error` so the
        // bounded auto-fix loop engages, and prepend the grepped
        // <error_analysis> block inside the untrusted delimiters (the matched
        // lines are still command output). The full stdout/stderr body is kept.
        const analysis = buildErrorAnalysis(stderr, code);
        resolve({
          content: wrapUntrusted(`${analysis}Exit code: ${code}\n${stdout}\n${stderr}${truncationNote()}`),
          error: `Exit code: ${code}`,
        });
      } else {
        // Silent non-zero exit (empty stderr) — grep -q / diff / test idioms:
        // content only, no error, no analysis block.
        resolve({ content: wrapUntrusted(`Exit code: ${code}\n${stdout}\n${stderr}${truncationNote()}`) });
      }
    });

    const timer = setTimeout(() => {
      if (settled) return;
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
    }, timeoutMs);
  });
}

const runBashHandler: ToolHandler = async (args, ctx) => {
  const command = args.command as string;
  // The trusted root is the workspace fixed at startup (item 8.6): the
  // Seatbelt write-set root is ctx.workingDir, never a model-passed cwd.
  const root = ctx.workingDir || process.cwd();
  const cwd = (args.cwd as string) || root;
  return runBashTimed(command, cwd, root, RUN_BASH_TIMEOUT_MS, resolveTimeoutToBackground(ctx.timeoutToBackground), ctx.sandboxLevel, ctx.writeRoots, ctx.sessionTempDir);
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
