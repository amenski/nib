import { afterEach, describe, expect, it } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, existsSync, lstatSync, symlinkSync, writeFileSync } from "node:fs";
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
    // "No write-set" is the invariant — not "no subpaths at all". The child
    // read boundary (readBoundaryLines) deliberately contributes *read*
    // subpaths at every sandboxed level; it subtracts $HOME from the blanket
    // read grant and re-allows the workspace. Only writes stay absolute.
    expect(p).not.toContain("(allow file-write* (subpath");
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
    expect(p).not.toContain("(allow file-write* (subpath");
    expect(p).not.toContain("/extra/global-root");
  });

  it("strict-sandbox: gains none of the write carve-outs (read-only stays absolute)", () => {
    const p = buildSeatbeltProfile("strict-sandbox", "/ws");
    // The write carve-outs are temp + ~/.npm. strict-sandbox gets neither as
    // a *write* set. `~/.npm` does still appear as one of the read-boundary
    // allows (HOME_READ_ALLOWS), which is level-independent by design — so
    // assert on the write form specifically rather than on the substring.
    expect(p).not.toContain("(allow file-write* (subpath");
    expect(p).not.toContain("/private/tmp");
    expect(p).not.toContain(`(allow file-write* (subpath "${seatbeltWorkspaceRoot(join(homedir(), ".npm"))}"))`);
    expect(p).toContain('(allow file-write* (literal "/dev/null"))');
  });

  it("read boundary: never re-allows $HOME itself, so a missing narrow entry cannot widen it", () => {
    // The re-allow list is resolved with realpathSync and an absent entry is
    // skipped. Resolving through the nearest *existing* ancestor instead —
    // which is what a naive shared helper does — maps a missing `~/.cache`
    // to `$HOME` and emits an allow for the entire home directory AFTER the
    // deny. SBPL is last-matching-rule-wins, so that silently voids the
    // whole read boundary. This test fails if that regression returns.
    const home = realpathSync(homedir());
    for (const level of ["strict-sandbox", "workspace-write"] as const) {
      const p = buildSeatbeltProfile(level, "/private/tmp/ws");
      expect(p).toContain(`(deny file-read* (subpath "${home}"))`);
      expect(p).not.toContain(`(allow file-read* (subpath "${home}"))`);
    }
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

// ── child read boundary (macOS) — release gate 1 ──
//
// The release-gate probe of 2026-09-16 found that `(allow file-read*)` let a
// sandboxed child read a sibling directory's canary. These tests reproduce
// that read and pin the fix in both directions: denied under a sandboxed
// level, readable under `unrestricted`, so a failure can never be a fixture
// artifact.

describe("child read boundary (macOS)", () => {
  const CANARY = "SYNTHETIC_CANARY_9f3a1c_not_a_real_secret";
  const nodeRead = (p: string) =>
    `node -e 'try{process.stdout.write(require("fs").readFileSync(${JSON.stringify(p)},"utf8"))}catch(e){process.stderr.write("ERR "+e.code);process.exit(3)}'`;

  /**
   * The boundary is `$HOME`-shaped, so the fixture has to live *under the
   * real home* for the deny rule to apply at all — a fixture in $TMPDIR sits
   * outside the boundary and reads happily. Disposable, synthetic, and
   * removed in `finally`; never a real credential.
   */
  function fixture() {
    const root = mkdtempSync(join(homedir(), ".nib-readgate-"));
    const ws = join(root, "ws");
    const sibling = join(root, "sibling");
    mkdirSync(ws, { recursive: true });
    mkdirSync(sibling, { recursive: true });
    const canaryPath = join(sibling, "canary.txt");
    writeFileSync(canaryPath, CANARY + "\n");
    writeFileSync(join(ws, "normal.txt"), "normal project file\n");
    return { root, ws, sibling, canaryPath, cleanup: () => rmSync(root, { recursive: true, force: true }) };
  }

  itOnDarwin(
    "workspace-write: sibling canary is denied via Node and shell; unsandboxed control still reads it",
    async () => {
      const f = fixture();
      try {
        // Direction 1 — control. Without a profile the same read succeeds, so
        // the denials below are attributable to Seatbelt, not the fixture.
        const control = await runCommand(`cat ${JSON.stringify(f.canaryPath)}`, f.ws, "unrestricted");
        expect(control.stdout).toContain(CANARY);

        // Direction 2 — the release-gate read, now denied.
        const viaNode = await runCommand(nodeRead(f.canaryPath), f.ws, "workspace-write");
        expect(viaNode.stdout).not.toContain(CANARY);
        expect(viaNode.exit).not.toBe(0);

        const viaShell = await runCommand(`cat ${JSON.stringify(f.canaryPath)}`, f.ws, "workspace-write");
        expect(viaShell.stdout).not.toContain(CANARY);
        expect(viaShell.exit).not.toBe(0);

        // The boundary must not be a blanket denial: ordinary project reads
        // still work, for both the shell and an interpreter.
        const inside = await runCommand("cat normal.txt", f.ws, "workspace-write");
        expect(inside.exit).toBe(0);
        expect(inside.stdout).toContain("normal project file");
        const insideNode = await runCommand(nodeRead(join(f.ws, "normal.txt")), f.ws, "workspace-write");
        expect(insideNode.exit).toBe(0);
        expect(insideNode.stdout).toContain("normal project file");
      } finally {
        f.cleanup();
      }
    },
    40_000,
  );

  itOnDarwin("strict-sandbox: the same sibling denial holds at the read-only level", async () => {
    const f = fixture();
    try {
      const viaNode = await runCommand(nodeRead(f.canaryPath), f.ws, "strict-sandbox");
      expect(viaNode.stdout).not.toContain(CANARY);
      expect(viaNode.exit).not.toBe(0);

      const inside = await runCommand("cat normal.txt", f.ws, "strict-sandbox");
      expect(inside.exit).toBe(0);
    } finally {
      f.cleanup();
    }
  }, 30_000);

  itOnDarwin("denial survives a workspace symlink pointing at the canary (physical path)", async () => {
    const f = fixture();
    const link = join(f.ws, "escape.txt");
    try {
      symlinkSync(f.canaryPath, link);
      const viaNode = await runCommand(nodeRead(link), f.ws, "workspace-write");
      expect(viaNode.stdout).not.toContain(CANARY);
      expect(viaNode.exit).not.toBe(0);

      const viaShell = await runCommand("cat escape.txt", f.ws, "workspace-write");
      expect(viaShell.stdout).not.toContain(CANARY);
      expect(viaShell.exit).not.toBe(0);
    } finally {
      f.cleanup();
    }
  }, 30_000);

  itOnDarwin("a synthetic canary in $HOME itself (outside the workspace) is unreadable", async () => {
    // Proves the deny covers the home directory itself, not just the
    // workspace's parent. The trusted root is the fixture workspace, so the
    // bare home directory is outside it. Synthetic; removed immediately.
    const f = fixture();
    const name = `.nib-readgate-home-${process.pid}.txt`;
    const homeCanary = join(homedir(), name);
    writeFileSync(homeCanary, CANARY + "\n");
    try {
      const control = await runCommand(`cat ${JSON.stringify(homeCanary)}`, f.ws, "unrestricted");
      expect(control.stdout).toContain(CANARY);

      const denied = await runCommand(`cat ${JSON.stringify(homeCanary)}`, f.ws, "workspace-write");
      expect(denied.stdout).not.toContain(CANARY);
      expect(denied.exit).not.toBe(0);

      // `~` / $HOME expansion must not be a way around the boundary either.
      const viaHomeExpansion = await runCommand(`cat "$HOME/${name}"`, f.ws, "workspace-write");
      expect(viaHomeExpansion.stdout).not.toContain(CANARY);
      expect(viaHomeExpansion.exit).not.toBe(0);
    } finally {
      rmSync(homeCanary, { force: true });
      f.cleanup();
    }
  }, 30_000);

  itOnDarwin("a canary outside $HOME is still readable when contained (recorded residual)", async () => {
    // This test pins the *limit* of the boundary, not a protection. The deny
    // rule subtracts $HOME; it does not enumerate the filesystem, so a path
    // outside $HOME — here $TMPDIR — stays readable by a sandboxed child even
    // though it is outside the workspace and outside every write root. That
    // is residual 1 in docs/security-architecture-plan.md and the reason
    // permission-ux-redesign.md discloses a "$HOME-shaped" read boundary
    // instead of claiming general read isolation.
    //
    // It is asserted rather than merely observed so that tightening the
    // boundary in future cannot pass silently: a change here must come with a
    // doc change, and a regression in the other direction (a child that can
    // no longer read its own scratch space) fails loudly too. Synthetic and
    // disposable, like the fixtures above.
    const f = fixture();
    const outsideDir = mkdtempSync(join(tmpdir(), "nib-readgate-outside-"));
    const outsideCanary = join(outsideDir, "canary.txt");
    writeFileSync(outsideCanary, CANARY + "\n");
    try {
      // Control: the same read with no profile. Both directions must read it;
      // the point of the row is that containment does not change the answer.
      const control = await runCommand(`cat ${JSON.stringify(outsideCanary)}`, f.ws, "unrestricted");
      expect(control.stdout).toContain(CANARY);

      const contained = await runCommand(`cat ${JSON.stringify(outsideCanary)}`, f.ws, "workspace-write");
      expect(contained.exit).toBe(0);
      expect(contained.stdout).toContain(CANARY);

      const containedNode = await runCommand(nodeRead(outsideCanary), f.ws, "workspace-write");
      expect(containedNode.exit).toBe(0);
      expect(containedNode.stdout).toContain(CANARY);

      // Pair the success with a denial in the same launch configuration. A
      // "read succeeds" assertion is satisfied by a profile that never
      // applied, so without this leg the test could pass for the wrong
      // reason; the $HOME sibling canary must still be denied here.
      const denied = await runCommand(`cat ${JSON.stringify(f.canaryPath)}`, f.ws, "workspace-write");
      expect(denied.stdout).not.toContain(CANARY);
      expect(denied.exit).not.toBe(0);
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
      f.cleanup();
    }
  }, 30_000);

  itOnDarwin("listing the sibling directory is denied (readdir is not metadata)", async () => {
    const f = fixture();
    try {
      const listing = await runCommand(
        `node -e 'console.log(require("fs").readdirSync(${JSON.stringify(f.sibling)}).join(","))'`,
        f.ws,
        "workspace-write",
      );
      expect(listing.exit).not.toBe(0);
      expect(listing.stdout).not.toContain("canary.txt");
    } finally {
      f.cleanup();
    }
  }, 30_000);

  itOnDarwin("the toolchain still resolves modules and stats parent dirs (metadata stays allowed)", async () => {
    // Regression guard for the fix itself: denying `file-read-metadata` for
    // $HOME made Node's module resolution and even `ls -la` die with EPERM.
    const f = fixture();
    try {
      const ls = await runCommand("ls -la", f.ws, "workspace-write");
      expect(ls.exit).toBe(0);
      expect(ls.stdout).toContain("normal.txt");

      const node = await runCommand("node -e 'console.log(1)'", f.ws, "workspace-write");
      expect(node.exit).toBe(0);
      expect(node.stdout.trim()).toBe("1");
    } finally {
      f.cleanup();
    }
  }, 30_000);
});

// ── git integrity (macOS) — release gate 2 ──
//
// The 2026-09-16 release probe found the workspace write grant includes
// `.git`, so a sandboxed child could write `.git/hooks` — a persistence
// escape the policy layer cannot see, because an interpreter or a package
// lifecycle script is not a tool call and never reaches the rules. These
// tests reproduce that write from Node and from an npm lifecycle script and
// pin the deny in both directions.

describe("git integrity (macOS)", () => {
  const GIT_ENV = {
    ...process.env,
    GIT_AUTHOR_NAME: "F",
    GIT_AUTHOR_EMAIL: "f@example.invalid",
    GIT_COMMITTER_NAME: "F",
    GIT_COMMITTER_EMAIL: "f@example.invalid",
  };

  /** Host-side git, for fixture setup only — never itself sandboxed. */
  function git(args: string, cwd: string): string {
    return execFileSync("/bin/sh", ["-c", `git ${args}`], { cwd, encoding: "utf8", env: GIT_ENV });
  }

  /**
   * A disposable repository. The fixture lives in $TMPDIR, which is inside
   * the workspace-write write-set via the temp carve-outs — but `cwd` doubles
   * as the trusted root in `runCommand`, so the repo is the write root here
   * and the carve-outs are not what permits the writes under test.
   */
  function fixture() {
    const ws = mkdtempSync(join(tmpdir(), "nib-gitgate-"));
    git("init -q", ws);
    writeFileSync(join(ws, "tracked.txt"), "tracked\n");
    git("add -A && git commit -qm init", ws);
    return { ws, gitdir: join(ws, ".git"), cleanup: () => rmSync(ws, { recursive: true, force: true }) };
  }

  /** Writes `p` from a real Node child (the release-gate vector). */
  const nodeWrite = (p: string) =>
    `node -e 'const fs=require("fs"),path=require("path"),p=${JSON.stringify(p)};` +
    `try{fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,"x")}` +
    `catch(e){process.stderr.write("ERR "+e.code);process.exit(3)}'`;

  /**
   * Asserts the deny, then proves the same write lands with no profile — so a
   * passing test can never be a fixture that was simply never writable.
   */
  async function deniedButOtherwiseWritable(ws: string, target: string, command: string) {
    const control = await runCommand(command, ws, "unrestricted");
    expect(control.exit).toBe(0);
    expect(existsSync(target)).toBe(true);
    rmSync(target, { force: true });

    const denied = await runCommand(command, ws, "workspace-write");
    expect(denied.exit).not.toBe(0);
    expect(existsSync(target)).toBe(false);
  }

  itOnDarwin(
    "workspace-write: Node cannot write .git/hooks (the release-gate escape)",
    async () => {
      const f = fixture();
      try {
        await deniedButOtherwiseWritable(
          f.ws,
          join(f.gitdir, "hooks", "pre-commit"),
          nodeWrite(join(f.gitdir, "hooks", "pre-commit")),
        );
      } finally {
        f.cleanup();
      }
    },
    60_000,
  );

  itOnDarwin(
    "workspace-write: an npm lifecycle script cannot write .git/hooks either",
    async () => {
      const f = fixture();
      try {
        // The same escape through a dependency script rather than a direct
        // interpreter call: the denial must hold for the child's child.
        mkdirSync(join(f.ws, "scripts"), { recursive: true });
        writeFileSync(
          join(f.ws, "package.json"),
          JSON.stringify({
            name: "nib-gitgate-fixture",
            version: "1.0.0",
            private: true,
            scripts: { probe: "node scripts/write-hook.js" },
          }),
        );
        writeFileSync(
          join(f.ws, "scripts", "write-hook.js"),
          `const fs=require("fs");try{fs.mkdirSync(".git/hooks",{recursive:true});` +
            `fs.writeFileSync(".git/hooks/post-checkout","x")}catch(e){process.exit(3)}\n`,
        );
        const hook = join(f.gitdir, "hooks", "post-checkout");
        await deniedButOtherwiseWritable(f.ws, hook, "npm run --silent probe");
      } finally {
        f.cleanup();
      }
    },
    90_000,
  );

  itOnDarwin(
    "workspace-write: hooks, config, and credentials are denied by every write form",
    async () => {
      const f = fixture();
      try {
        // A shell redirect, a `.git/config` rewrite (remote retargeting and
        // `credential.helper` / `core.hooksPath` injection), and the
        // credential store.
        const redirect = await runCommand("echo x > .git/hooks/post-checkout", f.ws, "workspace-write");
        expect(redirect.exit).not.toBe(0);
        expect(existsSync(join(f.gitdir, "hooks", "post-checkout"))).toBe(false);

        await deniedButOtherwiseWritable(
          f.ws,
          join(f.gitdir, "config"),
          nodeWrite(join(f.gitdir, "config")),
        );
        await deniedButOtherwiseWritable(
          f.ws,
          join(f.gitdir, "credentials"),
          nodeWrite(join(f.gitdir, "credentials")),
        );
      } finally {
        f.cleanup();
      }
    },
    90_000,
  );

  itOnDarwin(
    "workspace-write: the deny reaches a nested repository and a submodule gitdir",
    async () => {
      const f = fixture();
      const subSrc = mkdtempSync(join(tmpdir(), "nib-gitgate-src-"));
      try {
        // A nested repo at an arbitrary depth: a fixed `<root>/.git` deny
        // would miss it, which is why the rule is a regex.
        mkdirSync(join(f.ws, "nested", ".git", "hooks"), { recursive: true });
        await deniedButOtherwiseWritable(
          f.ws,
          join(f.ws, "nested", ".git", "hooks", "pre-commit"),
          nodeWrite(join(f.ws, "nested", ".git", "hooks", "pre-commit")),
        );

        // A real submodule's gitdir lives at `.git/modules/<name>/` with its
        // OWN hooks and config. A regex anchored on a literal `.git/hooks/`
        // was measured to miss both — this is the regression guard for that.
        git("init -q && echo s > f.txt && git add -A && git commit -qm s", subSrc);
        git(`-c protocol.file.allow=always submodule add -q ${subSrc} sub`, f.ws);
        const subGitdir = join(f.gitdir, "modules", "sub");
        expect(existsSync(join(subGitdir, "hooks"))).toBe(true);
        for (const leaf of ["hooks/pre-commit", "config"]) {
          await deniedButOtherwiseWritable(
            f.ws,
            join(subGitdir, leaf),
            nodeWrite(join(subGitdir, leaf)),
          );
        }
      } finally {
        rmSync(subSrc, { recursive: true, force: true });
        f.cleanup();
      }
    },
    150_000,
  );

  itOnDarwin(
    "workspace-write: a child cannot re-point .git/hooks at a directory it can write",
    async () => {
      // The end run around a path-based hooks deny: move the hooks directory
      // aside, put a symlink named `.git/hooks` in its place, and write the
      // hook through the symlink — which resolves to an ordinary writable
      // workspace path. Denying the hooks directory *node* is what closes it,
      // so this asserts on the node, not on the hook file.
      const REPOINT = "mv .git/hooks hooks-elsewhere && ln -s ../hooks-elsewhere .git/hooks";

      // Control first: with no profile the re-point succeeds, so the denial
      // below cannot be an artifact of the command itself failing.
      const control = fixture();
      try {
        const r = await runCommand(REPOINT, control.ws, "unrestricted");
        expect(r.exit, r.stderr).toBe(0);
        expect(lstatSync(join(control.gitdir, "hooks")).isSymbolicLink()).toBe(true);
      } finally {
        control.cleanup();
      }

      const f = fixture();
      try {
        const r = await runCommand(REPOINT, f.ws, "workspace-write");
        expect(r.exit).not.toBe(0);
        expect(lstatSync(join(f.gitdir, "hooks")).isSymbolicLink()).toBe(false);
        expect(lstatSync(join(f.gitdir, "hooks")).isDirectory()).toBe(true);
        expect(existsSync(join(f.ws, "hooks-elsewhere"))).toBe(false);
      } finally {
        f.cleanup();
      }
    },
    60_000,
  );

  itOnDarwin(
    "workspace-write: ordinary Git workflows still run with no exception",
    async () => {
      const f = fixture();
      try {
        for (const [label, cmd] of [
          ["read", "git status --porcelain >/dev/null && git log --oneline -1 >/dev/null && git diff --stat >/dev/null"],
          ["add + commit", "echo a >> tracked.txt && git add tracked.txt && git commit -qm c2"],
          ["stash", "echo b >> tracked.txt && git stash"],
          ["branch + checkout", "git branch tb && git checkout -qb feat && git checkout -q -"],
          ["tag", "git tag v1"],
          ["worktree add", "git worktree add -q wt -b wtbr"],
        ] as const) {
          const r = await runCommand(cmd, f.ws, "workspace-write");
          expect(r.exit, `${label}: ${r.stderr}`).toBe(0);
        }
      } finally {
        f.cleanup();
      }
    },
    150_000,
  );

  itOnDarwin(
    "workspace-write: hook templates stay writable, so repository creation is not blocked beyond config",
    async () => {
      const f = fixture();
      try {
        // The `.sample` allow is real, not vestigial: `git init` lays these
        // down, and a `.sample` is never executed.
        const sample = join(f.gitdir, "hooks", "pre-commit.sample");
        rmSync(sample, { force: true });
        const r = await runCommand(nodeWrite(sample), f.ws, "workspace-write");
        expect(r.exit).toBe(0);
        expect(existsSync(sample)).toBe(true);
      } finally {
        f.cleanup();
      }
    },
    60_000,
  );

  itOnDarwin(
    "workspace-write: repository creation is the documented cost — .git/config is not writable",
    async () => {
      // The deny deliberately breaks `git init` / `git remote add` /
      // `git clone` / `git submodule add`, which all write `.git` config.
      // The trusted path for explicitly approved Git operations is the
      // "approved-operation variant" below: this test is its missing-grant
      // control, so the two together prove the grant is what unblocks it.
      const f = fixture();
      try {
        const r = await runCommand("mkdir -p fresh && cd fresh && git init -q", f.ws, "workspace-write");
        expect(r.exit).not.toBe(0);
        expect(existsSync(join(f.ws, "fresh", ".git", "config"))).toBe(false);
      } finally {
        f.cleanup();
      }
    },
    60_000,
  );

  // ── the approved-operation variant (trusted half, release gate 2) ──
  //
  // Reached in production only through agent.ts's ask branch on a plain
  // `true` from askUser — an explicit approval of that one command. The
  // tests below drive runBashTimed's grant argument directly, which is the
  // same bit that path sets.

  itOnDarwin(
    "approved variant: an approved config-writing command runs, and the same command without the grant does not",
    async () => {
      const f = fixture();
      try {
        const command = "git remote add origin ./origin-path";
        // Control: no grant → the deny bites (the documented cost).
        const denied = await runBashTimed(command, f.ws, f.ws, 30_000, false, "workspace-write");
        expect(denied.error).toBeDefined();
        expect(git("remote", f.ws).trim()).toBe("");

        // Same spawn shape, grant set → the approved operation runs.
        const approved = await runBashTimed(
          command, f.ws, f.ws, 30_000, false, "workspace-write", undefined, undefined, true,
        );
        expect(approved.error).toBeUndefined();
        // The write really landed in .git/config, not just an exit code.
        expect(git("config remote.origin.url", f.ws).trim()).toBe("./origin-path");
      } finally {
        f.cleanup();
      }
    },
    60_000,
  );

  itOnDarwin(
    "approved variant: repository creation works again — git init lays down config and hook templates",
    async () => {
      const f = fixture();
      try {
        const init = await runBashTimed(
          "mkdir -p fresh && cd fresh && git init -q",
          f.ws, f.ws, 30_000, false, "workspace-write", undefined, undefined, true,
        );
        expect(init.error).toBeUndefined();
        const fresh = join(f.ws, "fresh", ".git");
        expect(existsSync(join(fresh, "config"))).toBe(true);
        // The hooks *directory* is allowed so init can write into it, which
        // is only safe because hook files themselves stay denied (below).
        expect(existsSync(join(fresh, "hooks"))).toBe(true);
      } finally {
        f.cleanup();
      }
    },
    60_000,
  );

  itOnDarwin(
    "approved variant: hooks and credentials stay denied even with the grant",
    async () => {
      const f = fixture();
      try {
        const hook = join(f.gitdir, "hooks", "pre-commit");
        const hookWrite = await runBashTimed(
          nodeWrite(hook), f.ws, f.ws, 30_000, false, "workspace-write", undefined, undefined, true,
        );
        expect(hookWrite.error).toBeDefined();
        expect(existsSync(hook)).toBe(false);

        const credentials = join(f.gitdir, "credentials");
        const credWrite = await runBashTimed(
          nodeWrite(credentials), f.ws, f.ws, 30_000, false, "workspace-write", undefined, undefined, true,
        );
        expect(credWrite.error).toBeDefined();
        expect(existsSync(credentials)).toBe(false);

        // Those two denials only mean something if the grant is genuinely
        // applied to this same spawn shape — so prove a config write lands.
        const configWrite = await runBashTimed(
          "git config nib.probe yes", f.ws, f.ws, 30_000, false, "workspace-write", undefined, undefined, true,
        );
        expect(configWrite.error).toBeUndefined();
        expect(git("config nib.probe", f.ws).trim()).toBe("yes");
      } finally {
        f.cleanup();
      }
    },
    90_000,
  );

  itOnDarwin(
    "approved variant: the grant is workspace-scoped — a config write in an added root still fails",
    async () => {
      const f = fixture();
      const added = fixture();
      try {
        const roots = [f.ws, added.ws];
        // Control: the added root is writable for ordinary Git work, so a
        // failure below is attributable to the config deny, not to the cwd.
        const ordinary = await runBashTimed(
          `cd '${added.ws}' && echo a >> tracked.txt && git add -A`,
          f.ws, f.ws, 30_000, false, "workspace-write", roots,
        );
        expect(ordinary.error).toBeUndefined();

        const outside = await runBashTimed(
          `cd '${added.ws}' && git config nib.probe yes`,
          f.ws, f.ws, 30_000, false, "workspace-write", roots, undefined, true,
        );
        expect(outside.error).toBeDefined();
        expect(git("config --get nib.probe || true", added.ws).trim()).toBe("");

        // …while the same approved command inside the workspace itself works.
        const inside = await runBashTimed(
          "git config nib.probe yes",
          f.ws, f.ws, 30_000, false, "workspace-write", roots, undefined, true,
        );
        expect(inside.error).toBeUndefined();
        expect(git("config nib.probe", f.ws).trim()).toBe("yes");
      } finally {
        f.cleanup();
        added.cleanup();
      }
    },
    90_000,
  );

  it("the approved-operation variant is emitted only on request, only for workspace-write, and below the denies", () => {
    const ws = "/private/tmp/ws";
    const configAllow = `(allow file-write* (regex "^/private/tmp/ws/(.*/)?\\.git(/.*)?/config(\\.lock)?$"))`;
    const hooksNodeAllow = `(allow file-write* (regex "^/private/tmp/ws/(.*/)?\\.git(/.*)?/hooks$"))`;
    const denyConfig = `(deny file-write* (regex "^.*/\\.git(/.*)?/config(\\.lock)?$"))`;

    // Absent the grant, neither allow exists at either level — the only
    // `(allow … (regex …))` line in the untrusted profile is the `.sample`
    // one inside the deny set.
    for (const level of ["strict-sandbox", "workspace-write"] as const) {
      const p = buildSeatbeltProfile(level, ws);
      expect(p).not.toContain(configAllow);
      expect(p).not.toContain(hooksNodeAllow);
    }

    const trusted = buildSeatbeltProfile("workspace-write", ws, undefined, true);
    expect(trusted).toContain(configAllow);
    expect(trusted).toContain(hooksNodeAllow);
    // Exactly the deny set's `.sample` allow plus the two granted ones — no
    // allow for hook files, and none for credentials.
    const trustedAllows = trusted.split("\n").filter((l) => l.startsWith("(allow file-write* (regex"));
    expect(trustedAllows).toEqual([
      `(allow file-write* (regex "^.*/\\.git(/.*)?/hooks/[^/]+\\.sample$"))`,
      configAllow,
      hooksNodeAllow,
    ]);
    // Last-matching-rule-wins: these are allows, so they must come after the
    // denies they carve into.
    expect(trusted.indexOf(configAllow)).toBeGreaterThan(trusted.indexOf(denyConfig));

    // strict-sandbox is untouched even when the grant is set: widening a
    // read-only level into ".git/config is writable" is a different level's
    // contract, so the flag must be inert there.
    const strict = buildSeatbeltProfile("strict-sandbox", ws, undefined, true);
    expect(strict).not.toContain(configAllow);
    expect(strict).not.toContain(hooksNodeAllow);
    expect(strict).toBe(buildSeatbeltProfile("strict-sandbox", ws));
  });

  itOnDarwin(
    "approved variant: a dotted workspace path neither widens to a neighbour nor disables the grant",
    async () => {
      // A regex-escape bug here is security-relevant in the widening
      // direction: with the dot left bare, the grant for `ws.v1` would also
      // match a sibling named `wssv1`. An over-escape disables the grant
      // instead. Both are caught by running the real thing.
      const root = mkdtempSync(join(tmpdir(), "nib-gitgate-esc-"));
      const ws = join(root, "ws.v1");
      const neighbour = join(root, "wssv1");
      mkdirSync(ws);
      mkdirSync(neighbour);
      git("init -q", ws);
      git("init -q", neighbour);
      try {
        const granted = await runBashTimed(
          "git config nib.probe yes", ws, ws, 30_000, false, "workspace-write", [ws], undefined, true,
        );
        expect(granted.error).toBeUndefined();
        expect(git("config nib.probe", ws).trim()).toBe("yes");

        // The neighbour is an ordinary write root here — so a config write in
        // it fails only because the grant's workspace scope excludes it.
        const spill = await runBashTimed(
          `cd '${neighbour}' && git config nib.probe yes`,
          ws, ws, 30_000, false, "workspace-write", [ws, neighbour], undefined, true,
        );
        expect(spill.error).toBeDefined();
        expect(git("config --get nib.probe || true", neighbour).trim()).toBe("");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    60_000,
  );

  it("regex-escapes the workspace root, so a metacharacter path cannot match a neighbour", () => {
    // `regexQuote` runs before `sbplQuote`, so a path-sourced `.` is emitted
    // as a double backslash in the profile *text* — SBPL decodes `\\` to `\`,
    // which is the single backslash the regex engine needs before the dot
    // (the same decoded form the constant deny lines write directly). The
    // end-to-end test above is what actually holds this honest.
    const p = buildSeatbeltProfile("workspace-write", "/private/tmp/ws.x", undefined, true);
    expect(p).toContain("^/private/tmp/ws\\\\.x/(.*/)?");
    expect(p).not.toContain("^/private/tmp/ws.x/(.*/)?");
    const paren = buildSeatbeltProfile("workspace-write", "/private/tmp/ws(1)+", undefined, true);
    expect(paren).toContain("^/private/tmp/ws\\\\(1\\\\)\\\\+/(.*/)?");
  });

  it("the integrity denies are emitted at both sandboxed levels, after the write grants", () => {
    for (const level of ["strict-sandbox", "workspace-write"] as const) {
      const p = buildSeatbeltProfile(level, "/private/tmp/ws");
      expect(p).toContain('(deny file-write* (regex "^.*/\\.git(/.*)?/hooks/[^/]+$"))');
      expect(p).toContain('(allow file-write* (regex "^.*/\\.git(/.*)?/hooks/[^/]+\\.sample$"))');
      expect(p).toContain('(deny file-write* (regex "^.*/\\.git(/.*)?/hooks$"))');
      expect(p).toContain('(deny file-write* (regex "^.*/\\.git(/.*)?/config(\\.lock)?$"))');
      expect(p).toContain('(deny file-write* (regex "^.*/\\.git(/.*)?/credentials$"))');
      // SBPL is last-matching-rule-wins: a deny emitted before the write-root
      // grants would be overridden by them and silently do nothing.
      expect(p.indexOf("(deny file-write* (regex")).toBeGreaterThan(
        p.lastIndexOf("(allow file-write* (subpath"),
      );
    }
  });
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
