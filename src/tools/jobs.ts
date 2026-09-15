import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import type { ToolDef, ToolOutput } from "../types.js";
import type { ToolHandler } from "./types.js";
import { ToolRegistry } from "./registry.js";
import {
  isSandboxedLevel,
  sandboxPrefix,
  validateCwdWithinTrustedRoot,
  type SandboxLevel,
} from "../sandbox/seatbelt.js";
import { wrapUntrusted, sanitizeControlChars } from "./untrusted-content.js";

// Background jobs can produce unbounded output (dev servers, tail -f); holding
// it all in memory would leak. Each stream keeps the most recent 1MB and flags
// the truncation so check_job can say so.
const MAX_STREAM_CHARS = 1024 * 1024;
/** Default per-job timeout (run_bash_background default; also what a run_bash
 *  timeout-migrated job gets). */
export const DEFAULT_TIMEOUT_MS = 300_000; // 5 minutes
const MAX_JOBS = 10;
const COMPLETED_JOB_TTL_MS = 5 * 60_000; // 5 minutes

export type JobStatus = "running" | "done" | "failed" | "killed";

export interface Job {
  id: string;
  command: string;
  proc: ChildProcess;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  status: JobStatus;
  exitCode: number | null;
  startTime: number;
  endTime: number | null;
  timeoutMs: number;
  /** Live-output events fire only for jobs started with `stream: true` (via
   *  the run_bash_background tool — plan §3 decision E: no global telemetry).
   *  Timeout-migrated jobs are tracked but never stream. */
  stream: boolean;
}

export interface JobStatusReport {
  id: string;
  command: string;
  status: JobStatus;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  runningMs: number;
}

// Timeout handles live on the side (not on Job) so the plan's Job shape stays
// clean — they are bookkeeping, not job state.
const jobTimeouts = new WeakMap<Job, ReturnType<typeof setTimeout>>();

/**
 * Terminate the whole process tree. `detached: true` makes the spawned shell a
 * process-group leader (setsid on POSIX), so killing -pid reaches the shell and
 * every child it started — a plain proc.kill() would orphan grandchildren.
 * SIGTERM first, SIGKILL fallback for processes that ignore it. Exported for
 * run_bash's kill-on-timeout path.
 */
export function killTree(proc: ChildProcess): void {
  if (proc.pid === undefined) return;
  const signalTree = (signal: NodeJS.Signals): void => {
    try {
      if (process.platform === "win32") {
        proc.kill();
      } else {
        process.kill(-proc.pid!, signal);
      }
    } catch {
      // ESRCH: already exited. Nothing to kill.
      try { proc.kill(); } catch { /* already dead */ }
    }
  };
  signalTree("SIGTERM");
  const fallback = setTimeout(() => signalTree("SIGKILL"), 1500);
  fallback.unref();
}

/**
 * Module-level singleton (plan §3: "state survives across tool calls within a
 * session"). One CLI process runs one agent at a time, so a module singleton is
 * safe. A session resume loses the in-memory map — documented behavior: the OS
 * processes keep running, but job tracking does not survive a restart.
 */
export type JobCompletionListener = (report: JobStatusReport) => void;
export type JobOutputListener = (jobId: string, chunk: string) => void;

export class JobManager {
  private jobs = new Map<string, Job>();
  private completionListeners = new Set<JobCompletionListener>();
  private outputListeners = new Set<JobOutputListener>();

  /**
   * Subscribe to job-completion events — fired exactly once per job when its
   * status leaves "running" (done/failed/killed), with the same report shape
   * check_job returns. Returns an unsubscribe function.
   */
  onCompleted(cb: JobCompletionListener): () => void {
    this.completionListeners.add(cb);
    return () => { this.completionListeners.delete(cb); };
  }

  /**
   * Subscribe to live output chunks. Fires only for jobs started with
   * `stream: true` (the run_bash_background tool — plan §3 decision E); a
   * subscriber never sees output from non-streamable jobs (e.g. timeout
   * migrations). Returns an unsubscribe function.
   */
  onOutput(cb: JobOutputListener): () => void {
    this.outputListeners.add(cb);
    return () => { this.outputListeners.delete(cb); };
  }

  private emitCompleted(job: Job): void {
    if (this.completionListeners.size === 0) return;
    const report = this.buildReport(job);
    for (const cb of this.completionListeners) {
      try { cb(report); } catch { /* a listener must never break job tracking */ }
    }
  }

  private emitOutput(job: Job, chunk: string): void {
    if (!job.stream || this.outputListeners.size === 0) return;
    for (const cb of this.outputListeners) {
      try { cb(job.id, chunk); } catch { /* a listener must never break job tracking */ }
    }
  }

  private buildReport(job: Job): JobStatusReport {
    return {
      id: job.id,
      command: job.command,
      status: job.status,
      exitCode: job.exitCode,
      stdout: job.stdout,
      stderr: job.stderr,
      stdoutTruncated: job.stdoutTruncated,
      stderrTruncated: job.stderrTruncated,
      runningMs: Date.now() - job.startTime,
    };
  }

  start(
    command: string,
    cwd: string,
    timeoutMs: number,
    opts?: { stream?: boolean; sandboxLevel?: SandboxLevel; trustedRoot?: string; writeRoots?: string[] },
  ): { ok: true; id: string } | { ok: false; error: string } {
    // Make room first: drop completed jobs past the TTL, then enforce the cap.
    this.cleanup();
    const runningCount = [...this.jobs.values()].filter((j) => j.status === "running").length;
    if (runningCount >= MAX_JOBS) {
      return { ok: false, error: `Too many background jobs (max ${MAX_JOBS}). Wait for one to finish or kill it first.` };
    }
    if (!fs.existsSync(cwd)) {
      return { ok: false, error: `Working directory does not exist: ${cwd}` };
    }

    // trustedRoot (item 8.6): the Seatbelt write-set root for sandboxed jobs
    // — the session workspace root fixed at startup, passed by the tool
    // handler from ctx.workingDir (defaults to process.cwd() for direct
    // callers). A sandboxed job whose cwd realpath-resolves outside it is
    // rejected before spawning, same rule as run_bash.
    const trustedRoot = opts?.trustedRoot ?? process.cwd();
    if (isSandboxedLevel(opts?.sandboxLevel)) {
      const checked = validateCwdWithinTrustedRoot(cwd, trustedRoot, opts?.writeRoots);
      if (!checked.ok) return { ok: false, error: checked.error };
    }

    const id = randomUUID();
    let proc: ChildProcess;
    try {
      // sandboxLevel (permission-profile.md §8, phase (e)): background jobs
      // spawn under the same Seatbelt profile as run_bash children.
      const sandbox = sandboxPrefix(command, cwd, trustedRoot, opts?.sandboxLevel, opts?.writeRoots);
      if (sandbox) {
        proc = spawn(sandbox.file, sandbox.args, {
          cwd,
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } else {
        proc = spawn(command, {
          cwd,
          shell: true,
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
      }
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }

    const job: Job = {
      id,
      command,
      proc,
      stdout: "",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      status: "running",
      exitCode: null,
      startTime: Date.now(),
      endTime: null,
      timeoutMs,
      stream: opts?.stream ?? false,
    };
    this.jobs.set(id, job);
    this.track(job);

    return { ok: true, id };
  }

  /**
   * Take over an already-spawned detached child (run_bash timeout migration).
   * Pre-migration output is seeded into the capped buffers so check_job shows
   * the whole run, not just what the background phase produced. The adopted
   * job is NOT streamable (plan §3 decision E — only jobs started via the
   * run_bash_background tool stream live output).
   */
  adopt(
    proc: ChildProcess,
    opts: { command: string; cwd: string; timeoutMs: number; stdout?: string; stderr?: string },
  ): { ok: true; id: string } | { ok: false; error: string } {
    this.cleanup();
    const runningCount = [...this.jobs.values()].filter((j) => j.status === "running").length;
    if (runningCount >= MAX_JOBS) {
      return { ok: false, error: `Too many background jobs (max ${MAX_JOBS}). Wait for one to finish or kill it first.` };
    }
    if (!fs.existsSync(opts.cwd)) {
      return { ok: false, error: `Working directory does not exist: ${opts.cwd}` };
    }

    const id = randomUUID();
    const job: Job = {
      id,
      command: opts.command,
      proc,
      stdout: "",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      status: "running",
      exitCode: null,
      startTime: Date.now(),
      endTime: null,
      timeoutMs: opts.timeoutMs,
      stream: false,
    };
    // run_bash's foreground buffers are already capped below MAX_STREAM_CHARS,
    // but cap defensively in case a future caller passes more.
    if (opts.stdout) {
      job.stdout = appendCapped("", opts.stdout, () => { job.stdoutTruncated = true; });
    }
    if (opts.stderr) {
      job.stderr = appendCapped("", opts.stderr, () => { job.stderrTruncated = true; });
    }
    this.jobs.set(id, job);
    this.track(job);

    return { ok: true, id };
  }

  /**
   * Wire a job's process to the capped buffers, status transitions, timeout,
   * and the completion/output events. Shared by start() and adopt().
   */
  private track(job: Job): void {
    job.proc.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      job.stdout = appendCapped(job.stdout, text, () => { job.stdoutTruncated = true; });
      this.emitOutput(job, text);
    });
    job.proc.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      job.stderr = appendCapped(job.stderr, text, () => { job.stderrTruncated = true; });
      this.emitOutput(job, text);
    });
    job.proc.on("error", (err) => {
      job.stderr += (job.stderr ? "\n" : "") + `[nib] failed to start: ${err.message}`;
      job.exitCode = -1;
      job.endTime = Date.now();
      if (job.status === "running") {
        job.status = "failed";
        this.emitCompleted(job);
      }
      clearJobTimeout(job);
    });
    // 'close' rather than 'exit': 'exit' fires as soon as the process itself
    // terminates, which can race ahead of the stdout/stderr 'data' handlers
    // above still draining buffered pipe output. 'close' only fires once the
    // child's stdio streams have also closed, so job.stdout/stderr are
    // guaranteed complete by the time the completion report is built.
    job.proc.on("close", (code) => {
      job.exitCode = code;
      job.endTime = Date.now();
      if (job.status === "running") {
        job.status = code === 0 ? "done" : "failed";
        this.emitCompleted(job);
      }
      clearJobTimeout(job);
    });

    const timeout = setTimeout(() => this.timeoutJob(job.id), job.timeoutMs);
    timeout.unref();
    jobTimeouts.set(job, timeout);
  }

  check(jobId: string): JobStatusReport | null {
    const job = this.jobs.get(jobId);
    if (!job) return null;
    return this.buildReport(job);
  }

  kill(jobId: string): { ok: boolean; error?: string } {
    const job = this.jobs.get(jobId);
    if (!job) return { ok: false, error: `Unknown job: ${jobId}` };
    if (job.status !== "running") return { ok: true }; // no-op success, already finished
    job.status = "killed";
    job.endTime = Date.now();
    killTree(job.proc);
    clearJobTimeout(job);
    // Fired here rather than on the process 'exit' (which still arrives, but
    // after the status is already "killed" — the running-guard prevents a
    // double emit), so listeners see the kill promptly.
    this.emitCompleted(job);
    return { ok: true };
  }

  /** Kill every tracked job — used by tests and available for shutdown paths. */
  killAll(): void {
    for (const id of this.jobs.keys()) this.kill(id);
  }

  list(): Array<{ id: string; command: string; status: JobStatus; exitCode: number | null; runningMs: number }> {
    return [...this.jobs.values()].map((j) => ({
      id: j.id,
      command: j.command,
      status: j.status,
      exitCode: j.exitCode,
      runningMs: Date.now() - j.startTime,
    }));
  }

  /** Remove completed jobs older than 5 minutes (plan §3: auto-cleanup). */
  cleanup(): void {
    const now = Date.now();
    for (const [id, job] of this.jobs) {
      if (job.status !== "running" && job.endTime !== null && now - job.endTime > COMPLETED_JOB_TTL_MS) {
        clearJobTimeout(job);
        this.jobs.delete(id);
      }
    }
  }

  private timeoutJob(jobId: string): void {
    const job = this.jobs.get(jobId);
    if (!job || job.status !== "running") return;
    job.stderr += (job.stderr ? "\n" : "") + `[nib] timed out after ${job.timeoutMs}ms — process killed`;
    job.status = "failed";
    job.endTime = Date.now();
    killTree(job.proc);
    this.emitCompleted(job);
  }
}

/** Keep the most recent `maxChars` (default MAX_STREAM_CHARS) of a stream, flagging the truncation. */
export function appendCapped(buf: string, chunk: string, onTruncate: () => void, maxChars: number = MAX_STREAM_CHARS): string {
  if (!chunk) return buf;
  let next = buf + chunk;
  if (next.length > maxChars) {
    next = next.slice(-maxChars);
    onTruncate();
  }
  return next;
}

function clearJobTimeout(job: Job): void {
  const t = jobTimeouts.get(job);
  if (t) {
    clearTimeout(t);
    jobTimeouts.delete(job);
  }
}

export const jobManager = new JobManager();

const runBackgroundHandler: ToolHandler = async (args, ctx) => {
  const command = args.command as string;
  if (typeof command !== "string" || command.trim() === "") {
    return { content: "", error: "Missing required argument: command" };
  }
  // The trusted root is the workspace fixed at startup (item 8.6): the
  // Seatbelt write-set root for sandboxed jobs is ctx.workingDir, never a
  // model-passed cwd.
  const root = ctx.workingDir || process.cwd();
  const cwd = (args.cwd as string) || root;
  const timeoutMs = typeof args.timeout === "number" && args.timeout > 0
    ? Math.floor(args.timeout)
    : DEFAULT_TIMEOUT_MS;

  // stream: true — only tool-started jobs emit live-output events (plan §3
  // decision E); timeout-migrated jobs are tracked but never stream.
  const result = jobManager.start(command, cwd, timeoutMs, { stream: true, sandboxLevel: ctx.sandboxLevel, trustedRoot: root, writeRoots: ctx.writeRoots });
  if (!result.ok) return { content: "", error: result.error };
  return {
    content: [
      `Started background job ${result.id}`,
      `Command: ${command}`,
      `Use check_job with job_id "${result.id}" to poll status; kill_job to terminate.`,
    ].join("\n"),
  };
};

const checkJobHandler: ToolHandler = async (args) => {
  const jobId = args.job_id as string;
  if (typeof jobId !== "string" || jobId === "") {
    return { content: "", error: "Missing required argument: job_id" };
  }
  const report = jobManager.check(jobId);
  if (!report) {
    return { content: "", error: `Unknown job: ${jobId}. Job tracking is in-memory and does not survive a restart.` };
  }
  const lines = [
    `Status: ${report.status}${report.exitCode !== null ? ` (exit ${report.exitCode})` : ""}`,
    `Running for: ${(report.runningMs / 1000).toFixed(1)}s`,
  ];
  // The command's own bytes are wrapped in the untrusted-content delimiters;
  // the status lines above stay outside (tool voice, like web_search's).
  // Terminal-control escapes are stripped at this boundary (T14) so spoofed
  // UI / OSC 52 sequences in job output can never reach the terminal raw.
  if (report.stdout) lines.push(`stdout:\n${wrapUntrusted(sanitizeControlChars(report.stdout))}`);
  else lines.push("stdout: (none)");
  if (report.stderr) lines.push(`stderr:\n${wrapUntrusted(sanitizeControlChars(report.stderr))}`);
  else lines.push("stderr: (none)");
  if (report.stdoutTruncated) lines.push("(stdout truncated — kept last 1MB)");
  if (report.stderrTruncated) lines.push("(stderr truncated — kept last 1MB)");
  return { content: lines.join("\n") };
};

const killJobHandler: ToolHandler = async (args) => {
  const jobId = args.job_id as string;
  if (typeof jobId !== "string" || jobId === "") {
    return { content: "", error: "Missing required argument: job_id" };
  }
  const result = jobManager.kill(jobId);
  if (!result.ok) return { content: "", error: result.error };
  const report = jobManager.check(jobId);
  return {
    content: report
      ? `Killed job ${jobId} (status: ${report.status}).`
      : `Killed job ${jobId}.`,
  };
};

const runBackgroundDef: ToolDef = {
  name: "run_bash_background",
  description: "Start a shell command in the background. Returns a job ID immediately; use check_job to poll status and read accumulated stdout/stderr, and kill_job to terminate it. For commands that run longer than the normal 120s run_bash timeout (dev servers, builds, tests).",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "The command to execute" },
      cwd: { type: "string", description: "Working directory (optional, defaults to the project root)" },
      timeout: { type: "number", description: "Max runtime in milliseconds before the job is killed (optional, default 300000)" },
    },
    required: ["command"],
  },
};

const checkJobDef: ToolDef = {
  name: "check_job",
  description: "Check the status of a background job started with run_bash_background. Returns status (running/done/failed/killed), exit code, and accumulated stdout/stderr.",
  parameters: {
    type: "object",
    properties: {
      job_id: { type: "string", description: "The job ID returned by run_bash_background" },
    },
    required: ["job_id"],
  },
};

const killJobDef: ToolDef = {
  name: "kill_job",
  description: "Terminate a running background job started with run_bash_background (kills the whole process tree). No-op if the job already finished.",
  parameters: {
    type: "object",
    properties: {
      job_id: { type: "string", description: "The job ID returned by run_bash_background" },
    },
    required: ["job_id"],
  },
};

export function registerJobs(registry: ToolRegistry): void {
  registry.register({ def: runBackgroundDef, handler: runBackgroundHandler, groups: ["command"] });
  registry.register({ def: checkJobDef, handler: checkJobHandler, groups: ["command"] });
  registry.register({ def: killJobDef, handler: killJobHandler, groups: ["command"] });
}
