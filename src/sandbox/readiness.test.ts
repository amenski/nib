import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { containmentFailureError, readReadiness, spawnContained, type ReadinessOutcome } from "./launcher.js";
import { sandboxPrefix, type SandboxSpawn } from "./seatbelt.js";

const itOnDarwin = it.skipIf(process.platform !== "darwin");

interface Observation {
  ready: ReadinessOutcome;
  stdout: string;
  stderr: string;
  exit: number | null;
}

/** Driver for spawnContained that waits for readiness AND the child's exit. */
async function runContained(spec: SandboxSpawn | null, target: string[], cwd: string): Promise<Observation> {
  const { proc, readiness } = spawnContained(spec, target, { cwd, detached: true });
  let stdout = "";
  let stderr = "";
  proc.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
  proc.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  const exited = new Promise<number | null>((resolve) => proc.on("close", resolve));
  const ended = await Promise.race([
    exited,
    new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 8000)),
  ]);
  if (ended === "timeout") {
    // A child that outlives its own readiness window would otherwise leak as a
    // detached process into the rest of the suite.
    killDetached(proc);
    throw new Error("contained child did not exit within 8s");
  }
  return { ready: await readiness, stdout, stderr, exit: ended };
}

function killDetached(proc: ChildProcess): void {
  try { process.kill(-proc.pid!, "SIGKILL"); } catch { /* already gone, or no group */ }
  try { proc.kill("SIGKILL"); } catch { /* already gone */ }
}

describe("containment readiness (macOS)", () => {
  itOnDarwin("signals readiness only after the profile applies, and the command still runs", async () => {
    const root = mkdtempSync(join(tmpdir(), "nib-readiness-ok-"));
    const scratch = join(root, "scratch");
    mkdirSync(scratch);
    const canary = join(root, "canary.txt");
    const landed = join(scratch, "landed.txt");
    writeFileSync(canary, "workspace-write-canary");

    try {
      const spec = sandboxPrefix("", root, root, "workspace-write", [], scratch);
      expect(spec?.file).toBe("/usr/bin/sandbox-exec");

      // The legitimate-workflow direction: readiness, the command's own output
      // and exit code, and a real write into the approved scratch root.
      const observed = await runContained(
        spec,
        ["/bin/sh", "-c", `cat ${quote(canary)}; printf WROTE > ${quote(landed)}; echo DONE`],
        root,
      );

      expect(observed.ready).toEqual({ ready: true });
      expect(observed.stdout).toContain("workspace-write-canary");
      expect(observed.stdout).toContain("DONE");
      expect(observed.exit).toBe(0);
      // The frame must not leak into the command's output, and it must have
      // become the command rather than run alongside it.
      expect(observed.stdout).not.toContain("nib-readiness");
      expect(existsSync(landed)).toBe(true);
      expect(readFileSync(landed, "utf8")).toBe("WROTE");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  itOnDarwin("reports no readiness, and does not run the command, when the profile is refused", async () => {
    const root = mkdtempSync(join(tmpdir(), "nib-readiness-bad-"));
    const marker = join(root, "must-not-exist");
    const control = join(root, "control-marker");

    try {
      // A syntactically valid envelope around an operation sandbox-exec cannot
      // apply. Deliberately not a real profile: this direction has to be
      // reachable on every runner, including ones that permit nested Seatbelt
      // (where sandbox-unavailable.test.ts skips). What it proves is the
      // readiness protocol's failure branch, not the runner's nesting policy.
      const refused: SandboxSpawn = {
        file: "/usr/bin/sandbox-exec",
        args: ["-p", "(version 1) (deny default) (nib-no-such-operation)", "/bin/sh", "-c", ""],
      };

      // Control first: this runner can run the command at all, so the absence
      // of the marker below is the profile's doing, not a broken fixture.
      const controlRun = await runContained(null, ["/bin/sh", "-c", `touch ${quote(control)}`], root);
      expect(controlRun.exit).toBe(0);
      expect(controlRun.ready).toEqual({ ready: true });
      expect(existsSync(control)).toBe(true);

      const observed = await runContained(refused, ["/bin/sh", "-c", `touch ${quote(marker)}`], root);

      expect(observed.ready.ready).toBe(false);
      if (observed.ready.ready) throw new Error("unreachable");
      expect(observed.ready.reason).toBe("exited-before-ready");
      // The command never ran — the readiness byte precedes exec, so its
      // absence is evidence the profile was not in force for the command.
      expect(existsSync(marker)).toBe(false);

      // The message names the failure specifically and forecloses the retry a
      // reader might otherwise assume happened.
      const message = containmentFailureError(observed.ready);
      expect(message).toContain("SANDBOX_NOT_APPLIED");
      expect(message).toContain("no unsandboxed retry was attempted");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  itOnDarwin("still signals readiness when the target binary is missing", async () => {
    const root = mkdtempSync(join(tmpdir(), "nib-readiness-missing-"));
    const scratch = join(root, "scratch");
    mkdirSync(scratch);
    try {
      const spec = sandboxPrefix("", root, root, "workspace-write", [], scratch);
      // The frame signals before exec, so a broken MCP server path is reported
      // as the ordinary failure it is — never as unconfirmed containment.
      const observed = await runContained(spec, ["/nonexistent/bin/nib-nope"], root);

      expect(observed.ready).toEqual({ ready: true });
      expect(observed.exit).not.toBe(0);
      expect(observed.stderr).toContain("No such file or directory");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});

function quote(path: string): string {
  return `'${path.replace(/'/g, "'\\''")}'`;
}

/**
 * A ChildProcess as far as readReadiness is concerned: the fd-3 pipe, and the
 * close/error events. No real launcher on this runner can hang without
 * signalling, so the watchdog is exercised against this instead.
 */
function fakeContainedProc(): { proc: ChildProcess; pipe: EventEmitter } {
  const pipe = new EventEmitter();
  const proc = new EventEmitter() as unknown as ChildProcess;
  (proc as unknown as { stdio: unknown[] }).stdio = [null, null, null, pipe];
  return { proc, pipe };
}

describe("readiness watchdog", () => {
  it("reports a timeout when the launcher neither signals nor exits", async () => {
    vi.useFakeTimers();
    try {
      const { proc, pipe } = fakeContainedProc();
      const pending = readReadiness(proc);

      await vi.advanceTimersByTimeAsync(5_001);

      // Without this branch a hung launcher would wedge the call for good: the
      // command timeout cannot settle an outcome whose readiness never landed.
      await expect(pending).resolves.toMatchObject({ ready: false, reason: "timeout" });
      // The watchdog detaches, so a byte that arrives afterwards cannot settle
      // the same launch twice.
      expect(pipe.listenerCount("data")).toBe(0);
      expect(proc.listenerCount("close")).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats any byte as readiness, whatever its value", async () => {
    // The pipe is private to the child, so the byte is a signal and not a
    // channel: a payload cannot encode anything through it.
    const { proc, pipe } = fakeContainedProc();
    const pending = readReadiness(proc);

    pipe.emit("data", Buffer.from([0x7f]));

    await expect(pending).resolves.toEqual({ ready: true });
  });
});
