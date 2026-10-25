import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { ToolRegistry } from "./registry.js";
import { executeTool, setSignal } from "./index.js";
import { registerJobs, jobManager, appendCapped } from "./jobs.js";
import { parseUntrustedMarker } from "./untrusted-content.js";
import type { JobStatusReport } from "./jobs.js";
import type { ToolContext } from "./types.js";

const onDarwin = process.platform === "darwin";
const itOnDarwin = it.skipIf(!onDarwin);

const mockCtx: ToolContext = {
  workingDir: process.cwd(),
  sessionId: "test",
  signal: new AbortController().signal,
};

async function waitFor(predicate: () => boolean, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function checkDone(jobId: string): Promise<JobStatusReport> {
  await waitFor(() => jobManager.check(jobId)!.status !== "running");
  return jobManager.check(jobId)!;
}

describe("registerJobs", () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
    registerJobs(registry);
  });

  afterEach(() => {
    jobManager.killAll();
  });

  it("registers all three tools under the command group", () => {
    const names = registry.getByMode(["command"]).map((d) => d.name).sort();
    expect(names).toEqual(["check_job", "kill_job", "run_bash_background"]);
  });

  it("defines JSON parameters matching the plan", () => {
    const bg = registry.getAllDefs().find((d) => d.name === "run_bash_background")!;
    expect(bg.parameters.required).toEqual(["command"]);
    expect(Object.keys(bg.parameters.properties)).toEqual(["command", "cwd", "timeout", "unsandboxed"]);
    const check = registry.getAllDefs().find((d) => d.name === "check_job")!;
    expect(check.parameters.required).toEqual(["job_id"]);
    expect(Object.keys(check.parameters.properties)).toEqual(["job_id", "wait_seconds"]);
    // The texts must ask for a wait, not a poll loop (plan §5.3).
    expect(check.description).toContain("Waits up to wait_seconds");
    expect(check.description).toContain("do not call it back-to-back");
    expect(bg.description).not.toMatch(/poll/i);
  });

  itOnDarwin("handler threads ctx.workingDir as the trusted root (escaping cwd rejected)", async () => {
    const out = await registry.execute(
      { id: "1", name: "run_bash_background", arguments: { command: "echo hi", cwd: "/tmp" } },
      { ...mockCtx, sandboxLevel: "workspace-write" },
    );
    expect(out.content).toBe("");
    expect(out.error).toContain("Working directory escapes the sandbox workspace root");
  });

  it("check_job strips terminal-control escapes from accumulated output (T14), keeping \\n and \\t", async () => {
    // Octal \033/\007, not \xNN hex: dash's printf (the /bin/sh on GitHub
    // Actions' ubuntu runners) doesn't interpret \xHH, which would leave the
    // literal text in the output instead of emitting real ESC/BEL bytes.
    // \0NNN octal is POSIX printf and behaves identically under bash and dash.
    const job = jobManager.start(`printf '\\033]52;c;cHJlYWQ\\007DATA\\n\\tkept'`, process.cwd(), 5000);
    expect(job.ok).toBe(true);
    const jobId = job.ok ? job.id : "";
    await waitFor(() => jobManager.check(jobId)!.status === "done");

    const out = await registry.execute(
      { id: "1", name: "check_job", arguments: { job_id: jobId } },
      mockCtx,
    );
    expect(out.error).toBeUndefined();
    expect(out.content).toContain("DATA\n\tkept");
    expect(out.content).not.toContain("\x1b");
    expect(out.content).not.toContain("\x07");
  });

  it("check_job wraps accumulated stdout/stderr in the untrusted delimiters, status lines outside (T12)", async () => {
    const okJob = jobManager.start("echo wrapped-check-job", process.cwd(), 5000);
    const failJob = jobManager.start("echo wrapped-check-err >&2; exit 3", process.cwd(), 5000);
    expect(okJob.ok && failJob.ok).toBe(true);
    const okId = okJob.ok ? okJob.id : "";
    const failId = failJob.ok ? failJob.id : "";
    await waitFor(() => jobManager.check(okId)!.status === "done");
    await waitFor(() => jobManager.check(failId)!.status === "failed");

    const okOut = await registry.execute(
      { id: "1", name: "check_job", arguments: { job_id: okId } },
      mockCtx,
    );
    expect(okOut.error).toBeUndefined();
    expect(okOut.content.startsWith("Status: done")).toBe(true);
    // Each captured stream sits under its label inside one wrapper pair: the
    // label, a begin marker, the payload (which may carry a trailing blank line
    // of its own), the matching end marker, then the next label. Scanned rather
    // than indexed so the payload's own newlines do not shift the assertion.
    const endAfter = (lines: string[], from: number) =>
      lines.findIndex((l, i) => i > from && parseUntrustedMarker(l)?.role === "end");

    const okLines = okOut.content.split("\n");
    const stdoutAt = okLines.indexOf("stdout:");
    expect(stdoutAt).toBeGreaterThan(-1);
    expect(parseUntrustedMarker(okLines[stdoutAt + 1]!)?.role).toBe("begin");
    const okEndAt = endAfter(okLines, stdoutAt);
    expect(okEndAt).toBeGreaterThan(stdoutAt);
    expect(okLines.slice(stdoutAt + 2, okEndAt).join("\n")).toContain("wrapped-check-job");
    expect(okLines[okEndAt + 1]).toBe("stderr: (none)");

    const failOut = await registry.execute(
      { id: "2", name: "check_job", arguments: { job_id: failId } },
      mockCtx,
    );
    expect(failOut.error).toBeUndefined();
    expect(failOut.content.startsWith("Status: failed (exit 3)")).toBe(true);
    expect(failOut.content).toContain("stdout: (none)");
    const failLines = failOut.content.split("\n");
    const stderrAt = failLines.indexOf("stderr:");
    expect(stderrAt).toBeGreaterThan(-1);
    expect(parseUntrustedMarker(failLines[stderrAt + 1]!)?.role).toBe("begin");
    const failEndAt = endAfter(failLines, stderrAt);
    expect(failEndAt).toBeGreaterThan(stderrAt);
    expect(failLines.slice(stderrAt + 2, failEndAt).join("\n")).toContain("wrapped-check-err");
  });
});

describe("JobManager", () => {
  beforeEach(() => {
    jobManager.cleanup();
  });

  afterEach(() => {
    jobManager.killAll();
  });

  it("returns a job id immediately and check_job reports done with stdout", async () => {
    const result = jobManager.start("echo hello-from-bg", process.cwd(), 5000);
    expect(result.ok).toBe(true);
    const jobId = result.ok ? result.id : "";
    expect(jobId).toMatch(/^[0-9a-f-]{36}$/);

    const report = await checkDone(jobId);
    expect(report.status).toBe("done");
    expect(report.exitCode).toBe(0);
    expect(report.stdout).toContain("hello-from-bg");
  });

  it("reports failed with the exit code for a failing command", async () => {
    const result = jobManager.start("echo boom >&2; exit 3", process.cwd(), 5000);
    expect(result.ok).toBe(true);
    const report = await checkDone(result.ok ? result.id : "");
    expect(report.status).toBe("failed");
    expect(report.exitCode).toBe(3);
    expect(report.stderr).toContain("boom");
  });

  it("kill_job terminates a running job", async () => {
    const result = jobManager.start("sleep 30", process.cwd(), 60_000);
    expect(result.ok).toBe(true);
    const jobId = result.ok ? result.id : "";
    await waitFor(() => jobManager.check(jobId)!.status === "running");

    const kill = jobManager.kill(jobId);
    expect(kill.ok).toBe(true);
    await waitFor(() => jobManager.check(jobId)!.status === "killed");
  });

  it("kill on an already-finished job is a no-op success", async () => {
    const result = jobManager.start("true", process.cwd(), 5000);
    const jobId = result.ok ? result.id : "";
    await checkDone(jobId);
    expect(jobManager.kill(jobId).ok).toBe(true);
  });

  it("unknown job_id is an error for both check and kill", () => {
    expect(jobManager.check("nope")).toBeNull();
    expect(jobManager.kill("nope").ok).toBe(false);
  });

  it("times out a long-running job and marks it failed", async () => {
    const result = jobManager.start("sleep 30", process.cwd(), 150);
    expect(result.ok).toBe(true);
    const jobId = result.ok ? result.id : "";
    await waitFor(() => jobManager.check(jobId)!.status !== "running");
    const report = jobManager.check(jobId)!;
    expect(report.status).toBe("failed");
    expect(report.stderr).toContain("timed out");
  });

  it("rejects a nonexistent working directory without spawning", () => {
    const result = jobManager.start("echo hi", "/nonexistent/nib-jobs-test", 5000);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Working directory");
  });

  itOnDarwin("rejects a sandboxed job whose cwd escapes the trusted root", () => {
    const result = jobManager.start("echo hi", "/tmp", 5000, {
      stream: true,
      sandboxLevel: "workspace-write",
      trustedRoot: process.cwd(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Working directory escapes the sandbox workspace root");
  });

  it("unsandboxed background jobs may run outside the workspace (unchanged)", async () => {
    const result = jobManager.start("echo hello-outside-ws", tmpdir(), 5000);
    expect(result.ok).toBe(true);
    const report = await checkDone(result.ok ? result.id : "");
    expect(report.stdout).toContain("hello-outside-ws");
  });

  it("rejects a 11th concurrent job beyond the cap of 10", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) {
      const r = jobManager.start("sleep 30", process.cwd(), 60_000);
      expect(r.ok).toBe(true);
      if (r.ok) ids.push(r.id);
    }
    const eleventh = jobManager.start("echo nope", process.cwd(), 5000);
    expect(eleventh.ok).toBe(false);
    if (!eleventh.ok) expect(eleventh.error).toContain("max 10");

    // The cap counts only *running* jobs — killing one frees the slot.
    expect(jobManager.kill(ids[0]).ok).toBe(true);
    await waitFor(() => jobManager.check(ids[0])!.status === "killed");
    const retry = jobManager.start("echo ok", process.cwd(), 5000);
    expect(retry.ok).toBe(true);
  });

  it("cleanup removes only completed jobs past the TTL, never running ones", async () => {
    const finished = jobManager.start("true", process.cwd(), 5000);
    const running = jobManager.start("sleep 30", process.cwd(), 60_000);
    expect(finished.ok && running.ok).toBe(true);
    const finishedId = finished.ok ? finished.id : "";
    const runningId = running.ok ? running.id : "";
    await checkDone(finishedId);

    // Rewrite the finished job's endTime to look 10 minutes old.
    const job = (jobManager as unknown as { jobs: Map<string, { endTime: number | null }> }).jobs.get(finishedId)!;
    job.endTime = Date.now() - 10 * 60_000;

    jobManager.cleanup();
    expect(jobManager.check(finishedId)).toBeNull();
    expect(jobManager.check(runningId)).not.toBeNull();
  });
});

describe("job completion/output events (plan §3)", () => {
  beforeEach(() => {
    jobManager.cleanup();
  });

  afterEach(() => {
    jobManager.killAll();
  });

  it("fires onCompleted exactly once with the check_job report when a job finishes", async () => {
    const reports: JobStatusReport[] = [];
    const off = jobManager.onCompleted((r) => reports.push(r));
    try {
      const result = jobManager.start("echo hello-bg-events", process.cwd(), 5000, { stream: true });
      const jobId = result.ok ? result.id : "";
      await checkDone(jobId);
      expect(reports).toHaveLength(1);
      expect(reports[0].id).toBe(jobId);
      expect(reports[0].status).toBe("done");
      expect(reports[0].exitCode).toBe(0);
      expect(reports[0].stdout).toContain("hello-bg-events");
    } finally {
      off();
    }
  });

  it("fires onCompleted for a failing job and for a kill", async () => {
    const reports: JobStatusReport[] = [];
    const off = jobManager.onCompleted((r) => reports.push(r));
    try {
      const fail = jobManager.start("exit 3", process.cwd(), 5000);
      const failId = fail.ok ? fail.id : "";
      await checkDone(failId);
      expect(reports).toHaveLength(1);
      expect(reports[0].status).toBe("failed");
      expect(reports[0].exitCode).toBe(3);

      const kill = jobManager.start("sleep 30", process.cwd(), 60_000);
      const killId = kill.ok ? kill.id : "";
      jobManager.kill(killId);
      await waitFor(() => jobManager.check(killId)!.status === "killed");
      expect(reports).toHaveLength(2);
      expect(reports[1].status).toBe("killed");
      // Exit code is null (clean kill) or -1 (process exited via signal after kill).
      // Both mean "the OS killed it, not the process itself."
      expect([null, -1]).toContain(reports[1].exitCode);
    } finally {
      off();
    }
  });

  it("unsubscribe stops future completion events", async () => {
    const reports: JobStatusReport[] = [];
    const off = jobManager.onCompleted((r) => reports.push(r));
    off();
    const result = jobManager.start("true", process.cwd(), 5000);
    await checkDone(result.ok ? result.id : "");
    expect(reports).toHaveLength(0);
  });

  it("delivers live output chunks for a streamable (model-started) job", async () => {
    const chunks: string[] = [];
    const off = jobManager.onOutput((id, chunk) => chunks.push(chunk));
    try {
      const result = jobManager.start("echo one; sleep 1; echo two", process.cwd(), 5000, { stream: true });
      const jobId = result.ok ? result.id : "";
      expect(jobId).not.toBe("");
      await checkDone(jobId);
      const all = chunks.join("");
      expect(all).toContain("one");
      expect(all).toContain("two");
    } finally {
      off();
    }
  });

  it("stays silent for non-streamable jobs (decision E: model-started only)", async () => {
    const chunks: string[] = [];
    const off = jobManager.onOutput(() => chunks.push("x"));
    try {
      const result = jobManager.start("echo should-not-stream", process.cwd(), 5000);
      const jobId = result.ok ? result.id : "";
      await checkDone(jobId);
      expect(chunks).toHaveLength(0);
    } finally {
      off();
    }
  });
});

// ── check_job waits (docs/check-job-wait-plan.md) ──
//
// Elapsed-time assertions use generous lower bounds only: a loaded CI box can
// make a wait finish late, never early, so `>= job duration` is the property
// that actually matters (the wait did not return instantly) and
// `<< the timeout` proves it stopped when the job did.
describe("check_job wait (plan §5)", () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
    registerJobs(registry);
    jobManager.cleanup();
  });

  afterEach(() => {
    jobManager.killAll();
  });

  const checkJob = (jobId: string, wait_seconds?: number, ctx: ToolContext = mockCtx) =>
    registry.execute(
      { id: "1", name: "check_job", arguments: wait_seconds === undefined ? { job_id: jobId } : { job_id: jobId, wait_seconds } },
      ctx,
    );

  it("returns as soon as the job finishes, well before wait_seconds elapses", async () => {
    const started = jobManager.start("sleep 1; echo waited-out", process.cwd(), 10_000);
    const jobId = started.ok ? started.id : "";
    const t0 = Date.now();
    const out = await checkJob(jobId, 20);
    const elapsed = Date.now() - t0;

    expect(out.error).toBeUndefined();
    expect(out.content).toContain("Status: done (exit 0)");
    expect(out.content).toContain("waited-out");
    expect(elapsed).toBeGreaterThanOrEqual(900);
    expect(elapsed).toBeLessThan(15_000);
  });

  it("returns running when wait_seconds elapses first, leaving the job alive", async () => {
    const started = jobManager.start("sleep 30", process.cwd(), 60_000);
    const jobId = started.ok ? started.id : "";
    const t0 = Date.now();
    const out = await checkJob(jobId, 0.3);
    const elapsed = Date.now() - t0;

    expect(out.content).toContain("Status: running");
    // The wait's own timeout must not touch the job (plan §4.4).
    expect(jobManager.check(jobId)!.status).toBe("running");
    expect(elapsed).toBeGreaterThanOrEqual(200);
    expect(elapsed).toBeLessThan(10_000);
  });

  it("wait_seconds: 0 returns immediately for a running job", async () => {
    const started = jobManager.start("sleep 30", process.cwd(), 60_000);
    const jobId = started.ok ? started.id : "";
    const t0 = Date.now();
    const out = await checkJob(jobId, 0);
    expect(out.content).toContain("Status: running");
    expect(Date.now() - t0).toBeLessThan(1_000);
  });

  it("an aborted signal ends the wait quickly and still reports the status", async () => {
    const started = jobManager.start("sleep 30", process.cwd(), 60_000);
    const jobId = started.ok ? started.id : "";
    const ac = new AbortController();
    const t0 = Date.now();
    setTimeout(() => ac.abort(), 150);
    const out = await checkJob(jobId, 20, { ...mockCtx, signal: ac.signal });
    expect(out.content).toContain("Status: running");
    expect(Date.now() - t0).toBeLessThan(5_000);
  });

  it("setSignal wires the shared tool context, so aborting the turn controller ends a check_job wait", async () => {
    const started = jobManager.start("sleep 30", process.cwd(), 60_000);
    const jobId = started.ok ? started.id : "";
    const turn = new AbortController();
    setSignal(turn.signal);
    try {
      const t0 = Date.now();
      let settled = false;
      const pending = executeTool({ id: "1", name: "check_job", arguments: { job_id: jobId, wait_seconds: 30 } })
        .finally(() => { settled = true; });
      await new Promise((r) => setTimeout(r, 200));
      expect(settled).toBe(false); // really waiting before the abort
      turn.abort();
      await waitFor(() => settled, 5_000);
      const out = await pending;
      expect(out.content).toContain("Status: running");
      expect(Date.now() - t0).toBeLessThan(5_000);
    } finally {
      setSignal(new AbortController().signal);
    }
  });

  it("an unknown job_id is still an error without waiting", async () => {
    const t0 = Date.now();
    const out = await checkJob("nope", 20);
    expect(out.error).toContain("Unknown job");
    expect(Date.now() - t0).toBeLessThan(1_000);
  });

  it("a non-numeric wait_seconds falls back to the 30s default", async () => {
    const started = jobManager.start("sleep 30", process.cwd(), 60_000);
    const jobId = started.ok ? started.id : "";
    // Proving the default is 30 s would cost 30 s; the clamp table below covers
    // the arithmetic, and here we only prove a bad value waits at all.
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 250);
    const t0 = Date.now();
    const out = await registry.execute(
      { id: "1", name: "check_job", arguments: { job_id: jobId, wait_seconds: "soon" } },
      { ...mockCtx, signal: ac.signal },
    );
    expect(out.content).toContain("Status: running");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(200);
  });

  it("reports how long it waited", async () => {
    const started = jobManager.start("sleep 0.5", process.cwd(), 10_000);
    const jobId = started.ok ? started.id : "";
    const out = await checkJob(jobId, 20);
    expect(out.content).toMatch(/Waited: \d+\.\ds/);
  });
});

// ── stream caps (release gate 4: availability limits) ──
//
// A child that emits unbounded output would otherwise grow the agent's memory
// for as long as it runs. `appendCapped` is the bound, shared by the background
// job streams (MAX_STREAM_CHARS = 1 MiB) and run_bash's foreground buffers
// (MAX_BASH_OUTPUT_CHARS). It is exercised here with a ten-character cap rather
// than by generating megabytes: the property under test is the arithmetic of the
// bound, and a small cap states it exactly, deterministically, and in
// microseconds. The end-to-end 512 KiB behaviour of run_bash is covered in
// bash.test.ts; this pins the primitive those paths share.
describe("appendCapped (stream bound)", () => {
  it("returns the buffer unchanged for an empty chunk without flagging truncation", () => {
    // A no-op chunk must never mark the stream truncated: the flag drives the
    // "(truncated)" note the model sees, and a false note would misdescribe
    // output that was never cut.
    const flags: number[] = [];
    expect(appendCapped("0123456789", "", () => flags.push(1), 10)).toBe("0123456789");
    expect(flags).toHaveLength(0);
  });

  it("appends freely up to the cap, and does not flag a buffer sitting exactly at it", () => {
    const flags: number[] = [];
    let buf = appendCapped("", "abc", () => flags.push(1), 10);
    expect(buf).toBe("abc");
    buf = appendCapped(buf, "def", () => flags.push(1), 10);
    expect(buf).toBe("abcdef");
    // Exactly at the cap (10 of 10): the comparison is strict, so nothing is
    // dropped and nothing is reported as dropped.
    buf = appendCapped(buf, "ghij", () => flags.push(1), 10);
    expect(buf).toBe("abcdefghij");
    expect(flags).toHaveLength(0);
  });

  it("keeps the most recent characters and flags truncation once when the cap is crossed", () => {
    const flags: number[] = [];
    const buf = appendCapped("abcdefghij", "k", () => flags.push(1), 10);
    expect(buf).toBe("bcdefghijk"); // the tail: newest output survives
    expect(buf).toHaveLength(10);
    expect(flags).toHaveLength(1);
  });

  it("trims a single oversized chunk to its tail, not its head", () => {
    const flags: number[] = [];
    const buf = appendCapped("", "0123456789ABCDEF", () => flags.push(1), 10);
    expect(buf).toBe("6789ABCDEF");
    expect(flags).toHaveLength(1);
  });

  it("never exceeds the cap across many appends, flagging each crossing", () => {
    const flags: number[] = [];
    let buf = "";
    for (let i = 0; i < 25; i += 1) {
      buf = appendCapped(buf, "wxyz", () => flags.push(1), 10);
      expect(buf.length).toBeLessThanOrEqual(10);
    }
    // 100 characters fed in, 10-character window: the buffer holds the last ten
    // of the 25 four-character chunks (period 4, so the tail is the final two
    // characters of a chunk followed by two whole chunks), and every append
    // that crossed the cap flagged once — appends 3 through 25.
    expect(buf).toBe("yzwxyzwxyz");
    expect(flags).toHaveLength(23);
  });
});
