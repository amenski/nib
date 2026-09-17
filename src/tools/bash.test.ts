import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerBash, runBashTimed, resolveTimeoutToBackground } from "./bash.js";
import { jobManager } from "./jobs.js";
import { ToolRegistry } from "./registry.js";
import type { ToolContext } from "./types.js";
import { basename } from "node:path";
import { createSessionTempDir } from "../sandbox/session-temp.js";
import { parseUntrustedMarker } from "./untrusted-content.js";

const onDarwin = process.platform === "darwin";
const itOnDarwin = it.skipIf(!onDarwin);

// Assert on the parsed marker rather than a copied literal: the id is random per
// call, so the marker's *shape and pairing* are the assertion that means something.
const firstMarker = (content: string) => parseUntrustedMarker(content.split("\n")[0]!);
const lastMarker = (content: string) => parseUntrustedMarker(content.trim().split("\n").pop()!);

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

describe("runBashTimed (plan §3 timeout→background migration)", () => {
  beforeEach(() => {
    jobManager.cleanup();
  });

  afterEach(() => {
    jobManager.killAll();
  });

  it("returns stdout on success and Exit code on failure", async () => {
    const ok = await runBashTimed("echo bash-migration-test", process.cwd(), process.cwd(), 5000, true);
    expect(ok.content).toContain("bash-migration-test");

    const fail = await runBashTimed("exit 3", process.cwd(), process.cwd(), 5000, true);
    expect(fail.content).toContain("Exit code: 3");
  });

  it("passes the private session temp directory to child commands", async () => {
    const sessionTemp = createSessionTempDir();
    try {
      const result = await runBashTimed(
        "printf '%s|%s' \"$TMPDIR\" \"$npm_config_cache\"",
        process.cwd(),
        process.cwd(),
        5000,
        true,
        undefined,
        undefined,
        sessionTemp.path,
      );
      expect(result.content).toContain(`${sessionTemp.path}|${sessionTemp.path}/npm-cache`);
    } finally {
      sessionTemp.cleanup();
    }
  });

  it("wraps command output in the untrusted-content delimiters (T12); error framing stays readable", async () => {
    const ok = await runBashTimed("echo wrapped-bash-output", process.cwd(), process.cwd(), 5000, true);
    expect(firstMarker(ok.content)?.role).toBe("begin");
    expect(ok.content).toContain("wrapped-bash-output");
    expect(lastMarker(ok.content)?.role).toBe("end");

    const fail = await runBashTimed("echo wrapped-bash-err >&2; exit 3", process.cwd(), process.cwd(), 5000, true);
    expect(firstMarker(fail.content)?.role).toBe("begin");
    expect(fail.content).toContain("Exit code: 3");
    expect(fail.content).toContain("wrapped-bash-err");
    expect(lastMarker(fail.content)?.role).toBe("end");
  });

  it("migrates a timed-out command to the background and preserves output continuity", async () => {
    const result = await runBashTimed("echo before; sleep 1; echo after", process.cwd(), process.cwd(), 250, true);
    expect(result.content).toContain("moved to background");
    // The adoption notice is tool status, not command output — unwrapped.
    expect(result.content).not.toContain("BEGIN WEB CONTENT");
    const match = result.content.match(/job ([0-9a-f-]{36})/);
    expect(match).not.toBeNull();
    const jobId = match![1];

    // Pre-migration output (seeded into the job) and post-adoption output
    // (streamed after the handover) both appear in check_job.
    await waitFor(() => {
      const report = jobManager.check(jobId);
      return report !== null && report.status !== "running" && report.stdout.includes("after");
    });
    const report = jobManager.check(jobId)!;
    expect(report.status).toBe("done");
    expect(report.exitCode).toBe(0);
    expect(report.stdout).toContain("before");
    expect(report.stdout).toContain("after");
  });

  it("kills interactive-looking commands on timeout even with the config ON", async () => {
    const result = await runBashTimed("sleep 30", process.cwd(), process.cwd(), 250, true);
    expect(result.content).toContain("Exit code: null");
    expect(result.content).not.toContain("moved to background");
    // Nothing was migrated: the sleep command never became a job.
    expect(jobManager.list().filter((j) => j.command === "sleep 30")).toHaveLength(0);
  });

  it("kills on timeout when the config is OFF", async () => {
    const result = await runBashTimed("sleep 30", process.cwd(), process.cwd(), 250, false);
    expect(result.content).toContain("Exit code: null");
    expect(result.content).not.toContain("moved to background");
    expect(jobManager.list().filter((j) => j.command === "sleep 30")).toHaveLength(0);
  });

  it("truncates output beyond 512KB with a note instead of killing", async () => {
    const result = await runBashTimed("yes x | head -c 600000", process.cwd(), process.cwd(), 5000, true);
    expect(result.content).toContain("(output truncated — kept last 512KB)");
    expect(result.content).not.toContain("moved to background");
  });

  it("strips terminal-control escapes from stdout (T14): OSC 52, cursor moves, spoofed UI", async () => {
    // Octal escapes (\033, \007), not \xNN hex: /bin/sh's printf must produce
    // real ESC/BEL bytes portably. \0NNN octal is POSIX printf and behaves
    // identically under bash and dash; \xHH hex is a bash extension that
    // dash's printf does NOT interpret (dash is /bin/sh on Debian/Ubuntu,
    // including GitHub Actions' ubuntu runners), so it would leave the
    // literal text "\x1b" in the output instead of emitting ESC.

    // OSC 52 clipboard write: ESC + BEL stripped; the base64 payload stays as
    // inert literal text (control bytes are gone, so nothing reaches the
    // terminal's clipboard).
    const osc52 = await runBashTimed(`printf '\\033]52;c;cHJlYWQ\\007CLIP-LEAK'`, process.cwd(), process.cwd(), 5000, true);
    expect(osc52.content).toContain("CLIP-LEAK");
    expect(osc52.content).not.toContain("\x1b");
    expect(osc52.content).not.toContain("\x07");

    // Cursor-movement CSI: ESC stripped; the printable residue ("[2K", "[10;10H")
    // is inert literal text that cannot move the cursor or clear lines.
    const cursor = await runBashTimed(`printf 'a\\033[2Kb\\033[10;10Hc'`, process.cwd(), process.cwd(), 5000, true);
    expect(cursor.content).toContain("a[2Kb[10;10Hc");
    expect(cursor.content).not.toContain("\x1b");

    // Spoofed-UI color runs: all ESC bytes stripped; the visible text survives.
    const spoofed = await runBashTimed(`printf '\\033[38;5;0m\\033[48;5;0mSPOOFED-UI\\033[0m'`, process.cwd(), process.cwd(), 5000, true);
    expect(spoofed.content).toContain("SPOOFED-UI");
    expect(spoofed.content).not.toContain("\x1b");
    // Sanitized output still rides inside the T12 untrusted delimiters.
    expect(lastMarker(spoofed.content)?.role).toBe("end");
  });

  it("strips terminal-control escapes from stderr on the non-zero-exit path (T14)", async () => {
    const fail = await runBashTimed(`printf '\\033[31mERR\\033[0m' >&2; exit 3`, process.cwd(), process.cwd(), 5000, true);
    expect(fail.content).toContain("Exit code: 3");
    expect(fail.content).toContain("ERR");
    expect(fail.content).not.toContain("\x1b");
  });

  it("preserves \\n and \\t in command output (T14 keeps layout)", async () => {
    const result = await runBashTimed(`printf 'line1\\n\\tindented\\n'`, process.cwd(), process.cwd(), 5000, true);
    expect(result.content).toContain("line1\n\tindented\n");
    expect(result.content).not.toContain("\x1b");
  });

  it("resolveTimeoutToBackground defaults ON (decision D)", () => {
    expect(resolveTimeoutToBackground(undefined)).toBe(true);
    expect(resolveTimeoutToBackground(true)).toBe(true);
    expect(resolveTimeoutToBackground(false)).toBe(false);
  });
});

describe("non-zero exit error analysis (F5 delta)", () => {
  it("sets error and prepends a grepped <error_analysis> block when stderr matches", async () => {
    const fail = await runBashTimed(
      `printf 'build failed: Cannot find module ./missing\ncontext line\n' >&2; exit 3`,
      process.cwd(),
      process.cwd(),
      5000,
      true,
    );
    expect(fail.error).toBe("Exit code: 3");
    expect(fail.content).toContain("<error_analysis>");
    expect(fail.content).toContain("</error_analysis>");
    // Matched stderr lines ride inside the block, above the full body.
    const between = fail.content.slice(
      fail.content.indexOf("<error_analysis>"),
      fail.content.indexOf("</error_analysis>"),
    );
    expect(between).toContain("Exit code: 3");
    expect(between).toContain("build failed: Cannot find module ./missing");
    // The full output body (unmatched stderr included) is still present.
    expect(fail.content).toContain("context line");
    expect(lastMarker(fail.content)?.role).toBe("end");
  });

  it("sets error but omits the block when stderr has no matching lines", async () => {
    const fail = await runBashTimed("echo wrapped-bash-err >&2; exit 3", process.cwd(), process.cwd(), 5000, true);
    expect(fail.error).toBe("Exit code: 3");
    expect(fail.content).not.toContain("<error_analysis>");
  });

  it("leaves a silent non-zero exit (empty stderr) content-only with no error", async () => {
    const fail = await runBashTimed("exit 3", process.cwd(), process.cwd(), 5000, true);
    expect(fail.error).toBeUndefined();
    expect(fail.content).toContain("Exit code: 3");
    expect(fail.content).not.toContain("<error_analysis>");
  });

  it("caps the analysis block at the last 20 matched stderr lines", async () => {
    const fail = await runBashTimed(
      `for i in $(seq 1 25); do echo "error line $i" >&2; done; exit 1`,
      process.cwd(),
      process.cwd(),
      5000,
      true,
    );
    const between = fail.content.slice(
      fail.content.indexOf("<error_analysis>"),
      fail.content.indexOf("</error_analysis>"),
    );
    expect((between.match(/error line \d+/g) || []).length).toBe(20);
    expect(between).toContain("error line 25");
    expect(between).not.toContain("error line 1\n");
  });
});

describe("run_bash handler trusted-root cwd handling (item 8.6)", () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
    registerBash(registry);
  });

  it("cwd omitted defaults to ctx.workingDir (the trusted root)", async () => {
    const out = await registry.execute(
      { id: "1", name: "run_bash", arguments: { command: "pwd" } },
      mockCtx,
    );
    expect(out.error).toBeUndefined();
    expect(out.content).toContain(basename(process.cwd()));
  });

  it("no sandbox level → a cwd outside the workspace is unchanged behavior", async () => {
    const out = await registry.execute(
      { id: "1", name: "run_bash", arguments: { command: "pwd", cwd: "/tmp" } },
      mockCtx,
    );
    expect(out.error).toBeUndefined();
    expect(out.content).toContain("tmp");
  });

  itOnDarwin("sandboxed: rejects a cwd outside the trusted root with a tool error", async () => {
    const out = await registry.execute(
      { id: "1", name: "run_bash", arguments: { command: "echo hi", cwd: "/tmp" } },
      { ...mockCtx, sandboxLevel: "workspace-write" },
    );
    expect(out.content).toBe("");
    expect(out.error).toContain("Working directory escapes the sandbox workspace root");
  });
});
