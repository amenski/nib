import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, existsSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import {
  buildSeatbeltProfile,
  sandboxPrefix,
  seatbeltWorkspaceRoot,
  validateCwdWithinTrustedRoot,
} from "./seatbelt.js";
import { runBashTimed } from "../tools/bash.js";
import { jobManager } from "../tools/jobs.js";

const onDarwin = process.platform === "darwin";
const itOnDarwin = it.skipIf(!onDarwin);

// ── helpers ──

/** Poll until predicate is true, same convention as jobs.test.ts's waitFor. */
async function waitFor(predicate: () => boolean, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}

interface RunResult {
  exit: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Spawn a command the same way the tools layer does (sandboxPrefix →
 * explicit argv, else shell:true) and capture the result. A 20s cap keeps a
 * broken profile from hanging the suite.
 */
function runCommand(command: string, cwd: string, level?: "strict-sandbox" | "workspace-write" | "unrestricted"): Promise<RunResult> {
  return new Promise((resolve) => {
    // cwd doubles as the trusted root here — the enforcement fixtures run
    // the child in the directory whose writes they assert on.
    const sandbox = sandboxPrefix(command, cwd, cwd, level);
    const child = sandbox
      ? spawn(sandbox.file, sandbox.args, { cwd })
      : spawn(command, { cwd, shell: true });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => { stdout += d; });
    child.stderr?.on("data", (d: Buffer) => { stderr += d; });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ exit: null, stdout, stderr: stderr + "\n(timed out)" });
    }, 20_000);
    child.on("error", (err) => { clearTimeout(timer); resolve({ exit: null, stdout, stderr: stderr + `\n${err.message}` }); });
    // 'close' rather than 'exit': 'exit' fires as soon as the process itself
    // terminates, which can race ahead of the stdout/stderr 'data' handlers
    // above still draining buffered pipe output. 'close' only fires once the
    // child's stdio streams have also closed, so stdout/stderr are guaranteed
    // complete by the time the result is resolved. Same bug as jobs.ts
    // (commit d864909).
    child.on("close", (code) => { clearTimeout(timer); resolve({ exit: code, stdout, stderr }); });
  });
}

/** A hermetic local HTTP server: sandboxed network connects never reach it. */
function startHttpServer(): Promise<{ server: Server; port: number; connections: () => number }> {
  return new Promise((resolve) => {
    let conns = 0;
    const server = createServer((_req, res) => { res.end("ok"); });
    server.on("connection", () => { conns += 1; });
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ server, port, connections: () => conns });
    });
  });
}

const FETCH_OK = (port: number) =>
  `node -e 'fetch("http://127.0.0.1:${port}").then(r=>{console.log("NETOK", r.status);process.exit(0)}).catch(e=>{console.log("NETFAIL", e.cause?.code ?? e.message);process.exit(1)})'`;

// ── profile construction (platform-independent) ──

describe("buildSeatbeltProfile", () => {
  it("strict-sandbox: deny default, read-only, no network, no write-set", () => {
    const p = buildSeatbeltProfile("strict-sandbox", "/ws");
    expect(p).toContain("(version 1)");
    expect(p).toContain("(deny default)");
    expect(p).toContain("(allow file-read*)");
    expect(p).toContain('(allow file-write* (literal "/dev/null"))');
    expect(p).not.toContain("network-outbound");
    expect(p).not.toContain("(subpath");
  });

  it("workspace-write: strict core plus the workspace write-set, without direct egress", () => {
    const p = buildSeatbeltProfile("workspace-write", "/private/tmp/ws");
    expect(p).toContain('(allow file-write* (subpath "/private/tmp/ws"))');
    expect(p).not.toContain("network-outbound");
    expect(p).toContain("(deny default)");
  });

  it("workspace-write: carries the battery-proven write carve-outs (literal /tmp, $TMPDIR, ~/.npm)", () => {
    const p = buildSeatbeltProfile("workspace-write", "/ws");
    // The 2026-08-15 dev-toolchain battery: mktemp failed on $TMPDIR, a raw
    // /tmp write failed, env -u TMPDIR mktemp fell back to /tmp and failed,
    // npm install failed on ~/.npm/_cacache. All three subpaths appear,
    // realpath'd (the form the kernel matches).
    expect(p).toContain(`(allow file-write* (subpath "${realpathSync("/tmp")}"))`);
    expect(p).toContain(`(allow file-write* (subpath "${realpathSync(tmpdir())}"))`);
    expect(p).toContain(`(allow file-write* (subpath "${seatbeltWorkspaceRoot(join(homedir(), ".npm"))}"))`);
  });

  it("workspace-write: emits an allow line for a configured global writeRoot", () => {
    // docs/unified-write-boundary.md §2: the Seatbelt write-set is the shared
    // resolveWriteRoots set — a configured `sandbox.writeRoots` entry becomes
    // a real `(allow file-write* (subpath …))` line, alongside the trusted
    // root, so a shell write into it is permitted by the same set the file
    // tools consult.
    const p = buildSeatbeltProfile("workspace-write", "/ws", ["/ws", "/extra/global-root"]);
    expect(p).toContain('(allow file-write* (subpath "/ws"))');
    expect(p).toContain('(allow file-write* (subpath "/extra/global-root"))');
  });

  it("strict-sandbox: emits no allow line even when a writeRoot is configured", () => {
    const p = buildSeatbeltProfile("strict-sandbox", "/ws", ["/extra/global-root"]);
    expect(p).not.toContain("(subpath");
    expect(p).not.toContain("/extra/global-root");
  });

  it("strict-sandbox: gains none of the carve-outs (read-only stays absolute)", () => {
    const p = buildSeatbeltProfile("strict-sandbox", "/ws");
    expect(p).not.toContain("(subpath");
    expect(p).not.toContain("/private/tmp");
    expect(p).not.toContain(".npm");
    expect(p).toContain('(allow file-write* (literal "/dev/null"))');
  });

  it("escapes quotes/backslashes in the workspace root for SBPL", () => {
    const p = buildSeatbeltProfile("workspace-write", '/a"b\\c');
    expect(p).toContain('(allow file-write* (subpath "/a\\"b\\\\c"))');
  });

  it("seatbeltWorkspaceRoot realpath-resolves the cwd (symlink-safe subpath)", () => {
    expect(seatbeltWorkspaceRoot("/tmp")).toBe(realpathSync("/tmp"));
  });
});

describe("sandboxPrefix", () => {
  it("unrestricted (or absent level) returns no prefix — spawn args unchanged", () => {
    expect(sandboxPrefix("echo hi", process.cwd(), process.cwd(), undefined)).toBeNull();
    expect(sandboxPrefix("echo hi", process.cwd(), process.cwd(), "unrestricted")).toBeNull();
  });

  itOnDarwin("levels below unrestricted produce a sandbox-exec prefix on macOS", () => {
    const p = sandboxPrefix("echo hi", process.cwd(), process.cwd(), "strict-sandbox");
    expect(p).not.toBeNull();
    expect(p!.file).toBe("/usr/bin/sandbox-exec");
    expect(p!.args[0]).toBe("-p");
    expect(p!.args[2]).toBe("/bin/sh");
    expect(p!.args[3]).toBe("-c");
    expect(p!.args[4]).toBe("echo hi");
  });

  it.skipIf(onDarwin)("non-macOS: levels below unrestricted are policy-only (no prefix)", () => {
    expect(sandboxPrefix("echo hi", process.cwd(), process.cwd(), "strict-sandbox")).toBeNull();
    expect(sandboxPrefix("echo hi", process.cwd(), process.cwd(), "workspace-write")).toBeNull();
  });

  itOnDarwin("the write-set subpath is the trusted root, not the per-call cwd", () => {
    const root = mkdtempSync(join(tmpdir(), "seatbelt-root-"));
    const sub = join(root, "sub");
    mkdirSync(sub, { recursive: true });
    try {
      const p = sandboxPrefix("echo hi", sub, root, "workspace-write");
      expect(p).not.toBeNull();
      expect(p!.args[1]).toContain(`(subpath "${realpathSync(root)}")`);
      expect(p!.args[1]).not.toContain(`(subpath "${realpathSync(sub)}")`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ── trusted-root cwd containment (item 8.6, platform-independent) ──

describe("validateCwdWithinTrustedRoot", () => {
  it("allows the trusted root itself and any subdirectory of it", () => {
    const root = mkdtempSync(join(tmpdir(), "seatbelt-root-"));
    const sub = join(root, "sub");
    mkdirSync(sub, { recursive: true });
    try {
      expect(validateCwdWithinTrustedRoot(root, root)).toEqual({ ok: true });
      expect(validateCwdWithinTrustedRoot(sub, root)).toEqual({ ok: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a cwd outside the trusted root (/tmp-adjacent and ~)", () => {
    const root = mkdtempSync(join(tmpdir(), "seatbelt-root-"));
    try {
      const outside = validateCwdWithinTrustedRoot(join(tmpdir(), "seatbelt-elsewhere"), root);
      expect(outside.ok).toBe(false);
      if (!outside.ok) expect(outside.error).toContain("sandbox workspace root");

      // ~ expands to the home directory — rejected unless the home dir is
      // inside the trusted root.
      const home = validateCwdWithinTrustedRoot("~", root);
      expect(home.ok).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("allows a cwd under an explicitly authorized additional root", () => {
    const root = mkdtempSync(join(tmpdir(), "seatbelt-root-"));
    const added = mkdtempSync(join(tmpdir(), "seatbelt-added-"));
    const other = mkdtempSync(join(tmpdir(), "seatbelt-other-"));
    try {
      expect(validateCwdWithinTrustedRoot(added, root, [added])).toEqual({ ok: true });
      expect(validateCwdWithinTrustedRoot(join(added, "nested"), root, [added])).toEqual({ ok: true });
      expect(validateCwdWithinTrustedRoot(other, root, [added]).ok).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(added, { recursive: true, force: true });
      rmSync(other, { recursive: true, force: true });
    }
  });

  it("rejects a cwd whose symlink escapes the trusted root", () => {
    const root = mkdtempSync(join(tmpdir(), "seatbelt-root-"));
    const outside = mkdtempSync(join(tmpdir(), "seatbelt-out-"));
    const link = join(root, "escape");
    try {
      symlinkSync(outside, link, "dir");
      const result = validateCwdWithinTrustedRoot(link, root);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain(link);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("allows a cwd symlinked to another path inside the trusted root", () => {
    const root = mkdtempSync(join(tmpdir(), "seatbelt-root-"));
    const inner = join(root, "inner");
    mkdirSync(inner, { recursive: true });
    const link = join(root, "alias");
    try {
      symlinkSync(inner, link, "dir");
      expect(validateCwdWithinTrustedRoot(link, root)).toEqual({ ok: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ── real sandbox behavior (macOS only) ──

describe("seatbelt enforcement (macOS)", () => {
  const workspace = process.cwd();

  itOnDarwin("strict-sandbox: basic commands work — ls, echo, git status, node", async () => {
    const ls = await runCommand("ls", workspace, "strict-sandbox");
    expect(ls.exit).toBe(0);
    expect(ls.stdout).toContain("src");

    const echo = await runCommand("echo seatbelt-echo-ok", workspace, "strict-sandbox");
    expect(echo.exit).toBe(0);
    expect(echo.stdout).toContain("seatbelt-echo-ok");

    const git = await runCommand("git status", workspace, "strict-sandbox");
    expect(git.exit).toBe(0);
    expect(git.stdout).toContain("On branch");

    const node = await runCommand("node -e 'console.log(1)'", workspace, "strict-sandbox");
    expect(node.exit).toBe(0);
    expect(node.stdout.trim()).toBe("1");
  }, 85_000);

  itOnDarwin("strict-sandbox: writes fail everywhere (read-only)", async () => {
    const outsideDir = mkdtempSync(join(tmpdir(), "seatbelt-strict-"));
    const outside = join(outsideDir, "write.txt");
    try {
      const result = await runCommand(`touch "${outside}"`, workspace, "strict-sandbox");
      expect(result.exit).not.toBe(0);
      expect(result.stderr).toMatch(/Operation not permitted|not permitted/i);
      expect(existsSync(outside)).toBe(false);
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  }, 25_000);

  itOnDarwin("strict-sandbox: network attempts are denied (server never reached)", async () => {
    const { server, port, connections } = await startHttpServer();
    try {
      const result = await runCommand(FETCH_OK(port), workspace, "strict-sandbox");
      expect(result.exit).not.toBe(0);
      expect(result.stdout).toContain("NETFAIL");
      expect(connections()).toBe(0);
    } finally {
      server.close();
    }
  }, 25_000);

  itOnDarwin("workspace-write: writes inside the workspace succeed, outside fail", async () => {
    const ws = mkdtempSync(join(tmpdir(), "seatbelt-ws-"));
    // Home root is outside the write-set — and NOT inside the temp/npm
    // carve-outs, so it is the correct denied target (tmpdir-adjacent paths
    // became carved 2026-08-15).
    const outside = join(homedir(), "seatbelt-ws-out.txt");
    rmSync(outside, { force: true });
    try {
      const inside = await runCommand(`touch "${join(ws, "inside.txt")}"`, ws, "workspace-write");
      expect(inside.exit).toBe(0);
      expect(existsSync(join(ws, "inside.txt"))).toBe(true);

      const out = await runCommand(`touch "${outside}"`, ws, "workspace-write");
      expect(out.exit).not.toBe(0);
      expect(out.stderr).toMatch(/Operation not permitted|not permitted/i);
      expect(existsSync(outside)).toBe(false);
    } finally {
      rmSync(ws, { recursive: true, force: true });
      rmSync(outside, { force: true });
    }
  }, 45_000);

  itOnDarwin("workspace-write: battery control — ~/ escape write stays denied", async () => {
    // Battery #7 (2026-08-15): `echo hi > ~/…` must keep failing after the
    // carve-outs — home is outside the write-set and not carved.
    const ws = mkdtempSync(join(tmpdir(), "seatbelt-ctrl-"));
    const target = join(homedir(), "sbx-battery-escape-test");
    rmSync(target, { force: true });
    try {
      const result = await runCommand("echo hi > ~/sbx-battery-escape-test", ws, "workspace-write");
      expect(result.exit).not.toBe(0);
      expect(result.stderr).toMatch(/Operation not permitted|not permitted/i);
      expect(existsSync(target)).toBe(false);
    } finally {
      rmSync(ws, { recursive: true, force: true });
      rmSync(target, { force: true });
    }
  }, 25_000);

  itOnDarwin("workspace-write: network attempts are denied (server never reached)", async () => {
    const { server, port, connections } = await startHttpServer();
    try {
      const result = await runCommand(FETCH_OK(port), process.cwd(), "workspace-write");
      expect(result.exit).not.toBe(0);
      expect(connections()).toBe(0);
    } finally {
      server.close();
    }
  }, 25_000);

  itOnDarwin("workspace-write: git status works in the workspace", async () => {
    const result = await runCommand("git status", process.cwd(), "workspace-write");
    expect(result.exit).toBe(0);
    expect(result.stdout).toContain("On branch");
  }, 25_000);
});

// ── tools-layer wiring (macOS only — exercises the real spawn paths) ──

describe("sandbox wiring into run_bash and background jobs", () => {
  const workspace = process.cwd();

  afterEach(() => {
    jobManager.killAll();
  });

  itOnDarwin("runBashTimed sandboxes the child when a level is passed", async () => {
    const denied = await runBashTimed(
      "touch /tmp/nib-seatbelt-bash-probe.txt",
      workspace,
      workspace,
      5000,
      true,
      "strict-sandbox",
    );
    expect(denied.content).toContain("Exit code:");
    expect(denied.content).not.toContain("Exit code: 0");

    const allowed = await runBashTimed("echo seatbelt-wired-ok", workspace, workspace, 5000, true, "strict-sandbox");
    expect(allowed.content).toContain("seatbelt-wired-ok");
  }, 15_000);

  itOnDarwin("workspace-write permits git metadata writes only in an explicitly added root", async () => {
    const primaryRoot = mkdtempSync(join(workspace, ".seatbelt-primary-"));
    const repo = mkdtempSync(join(workspace, ".seatbelt-added-"));
    try {
      const initialized = await runCommand("git init -q", repo);
      expect(initialized.exit).toBe(0);
      writeFileSync(join(repo, "tracked.txt"), "tracked\n");

      const denied = await runBashTimed(
        "git add tracked.txt",
        repo,
        primaryRoot,
        5000,
        true,
        "workspace-write",
      );
      expect(denied.content).toBe("");
      expect(denied.error).toContain("Working directory escapes the sandbox workspace root");

      const allowed = await runBashTimed(
        "git add tracked.txt",
        repo,
        primaryRoot,
        5000,
        true,
        "workspace-write",
        [repo],
      );
      expect(allowed.error).toBeUndefined();
      // Success-path run_bash content is just the wrapped stdout (bash.ts) —
      // "Exit code: N" lines only appear on failure, and `git add` is silent.
      expect(allowed.content).toContain("(no output)");
      expect(existsSync(join(repo, ".git", "index"))).toBe(true);
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(primaryRoot, { recursive: true, force: true });
    }
  }, 30_000);

  itOnDarwin("no level passed → spawn behavior unchanged", async () => {
    const result = await runBashTimed("echo seatbelt-off-ok", workspace, workspace, 5000, true, undefined);
    expect(result.content).toContain("seatbelt-off-ok");
  }, 10_000);

  itOnDarwin("background jobs inherit the sandbox level (write denied in a strict job)", async () => {
    const started = jobManager.start(
      "touch /tmp/nib-seatbelt-job-probe.txt",
      workspace,
      10_000,
      { stream: false, sandboxLevel: "strict-sandbox", trustedRoot: workspace },
    );
    expect(started.ok).toBe(true);
    const id = started.ok ? started.id : "";
    await waitFor(() => jobManager.check(id)!.status !== "running");
    const report = jobManager.check(id);
    expect(report?.status).toBe("failed");
    expect(report?.exitCode).not.toBe(0);
    expect(existsSync("/tmp/nib-seatbelt-job-probe.txt")).toBe(false);
  }, 15_000);

  // ── trusted-root containment through the tools layer (item 8.6) ──

  itOnDarwin(
    "workspace-write: a real npm install works in a scratch workspace (carve-outs in effect)",
    async (ctx) => {
      // The 2026-08-15 battery's row 3 reproduced as a regression test: npm
      // install must succeed under workspace-write now that ~/.npm (cache)
      // and the temp dirs are carved. 30s budget inside runBashTimed; a
      // timeout-kill (slow/offline env) skips rather than fails.
      const ws = mkdtempSync(join(tmpdir(), "seatbelt-npm-"));
      try {
        writeFileSync(
          join(ws, "package.json"),
          JSON.stringify({ name: "seatbelt-npm-test", version: "1.0.0", private: true }),
        );
        const result = await runBashTimed(
          "npm install is-number --no-audit --no-fund --loglevel=error",
          ws,
          ws,
          30_000,
          false,
          "workspace-write",
        );
        if (result.content.includes("Exit code: null")) {
          ctx.skip("npm install exceeded the 30s budget — skipped (slow/offline env)");
          return;
        }
        expect(result.error).toBeUndefined();
        expect(existsSync(join(ws, "node_modules", "is-number"))).toBe(true);
      } finally {
        rmSync(ws, { recursive: true, force: true });
      }
    },
    40_000,
  );

  itOnDarwin("runBashTimed rejects a cwd outside the trusted root — tool error, no spawn", async () => {
    const result = await runBashTimed("echo should-not-run", "/tmp", workspace, 5000, true, "workspace-write");
    expect(result.content).toBe("");
    expect(result.error).toContain("Working directory escapes the sandbox workspace root");
    expect(result.error).toContain("/tmp");
  });

  itOnDarwin("runBashTimed rejects a cwd symlinked outside the trusted root", async () => {
    const root = mkdtempSync(join(tmpdir(), "seatbelt-root-"));
    const outside = mkdtempSync(join(tmpdir(), "seatbelt-out-"));
    const link = join(root, "escape");
    try {
      symlinkSync(outside, link, "dir");
      const result = await runBashTimed("echo should-not-run", link, root, 5000, true, "workspace-write");
      expect(result.content).toBe("");
      expect(result.error).toContain("Working directory escapes the sandbox workspace root");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("runBashTimed allows a subdirectory cwd inside the trusted root (write-set stays the root)", async () => {
    const root = mkdtempSync(join(tmpdir(), "seatbelt-root-"));
    const sub = join(root, "sub");
    mkdirSync(sub, { recursive: true });
    try {
      const result = await runBashTimed("pwd", sub, root, 5000, true, "workspace-write");
      expect(result.error).toBeUndefined();
      expect(result.content).toContain("sub");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 10_000);

  itOnDarwin("background jobs reject a cwd escaping the trusted root the same way", async () => {
    const started = jobManager.start("echo should-not-run", "/tmp", 10_000, {
      stream: true,
      sandboxLevel: "workspace-write",
      trustedRoot: workspace,
    });
    expect(started.ok).toBe(false);
    if (!started.ok) expect(started.error).toContain("Working directory escapes the sandbox workspace root");
  });
});
