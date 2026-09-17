import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ToolRegistry } from "./registry.js";
import { registerSearch, runSearchTimed } from "./search.js";
import { parseUntrustedMarker } from "./untrusted-content.js";
import type { ToolContext } from "./types.js";

// Exercises the real registered `search` handler end-to-end against a real
// directory and a real `grep` subprocess -- no mocking. This is the same
// registry.execute path the live agent loop drives via executeTool in
// index.ts, so a shell-injection regression here would be a regression in
// the real tool, not a test double.

const TEST_DIR = join(tmpdir(), `nib-search-test-${process.pid}`);

function makeRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registerSearch(registry);
  return registry;
}

function makeCtx(): ToolContext {
  return {
    workingDir: TEST_DIR,
    sessionId: "search-test",
    signal: new AbortController().signal,
  };
}

describe("search (grep tool)", () => {
  let registry: ToolRegistry;
  let ctx: ToolContext;

  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    registry = makeRegistry();
    ctx = makeCtx();
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("registers with the read group", () => {
    const defs = registry.getByMode(["read"]);
    expect(defs.map((d) => d.name)).toContain("search");
  });

  it("does not execute shell metacharacters embedded in the pattern (command injection closed)", async () => {
    const canary = join(TEST_DIR, "canary.txt");
    // If `pattern` ever reaches a shell again, this would close the quoted
    // grep argument, chain a command via `;`, and write the canary file via
    // command substitution / redirection. A convincing proof needs an
    // observable side effect, not just "no crash" — the canary file's
    // existence is that side effect.
    const maliciousPattern = `x"; touch "${canary}"; echo "`;
    writeFileSync(join(TEST_DIR, "haystack.txt"), "nothing interesting here\n");

    const result = await registry.execute(
      { id: "1", name: "search", arguments: { pattern: maliciousPattern, dir: TEST_DIR } },
      ctx,
    );

    // The shell metacharacters never got interpreted, so no canary was created.
    expect(existsSync(canary)).toBe(false);
    // grep found no literal match for that bizarre string, and treated it
    // purely as a (regex) search pattern - not as a syntax error.
    expect(result.content).toBe("No matches found.");
  });

  it("does not execute a backtick/$( ) command-substitution pattern", async () => {
    const canary = join(TEST_DIR, "canary2.txt");
    const maliciousPattern = `$(touch ${canary})`;
    writeFileSync(join(TEST_DIR, "haystack.txt"), "nothing interesting here\n");

    await registry.execute(
      { id: "1", name: "search", arguments: { pattern: maliciousPattern, dir: TEST_DIR } },
      ctx,
    );

    expect(existsSync(canary)).toBe(false);
  });

  it("searches correctly for a literal/regex pattern containing shell-special characters", async () => {
    writeFileSync(
      join(TEST_DIR, "code.ts"),
      'const x = "hello"; // comment\nconst y = foo(a, b);\n',
    );

    // Pattern is shell-special (parens, comma) but grep-valid as a basic-regex
    // match — parens are literal in BRE (grep's default) — so it should find
    // the matching line via argv, not shell parsing.
    const result = await registry.execute(
      { id: "1", name: "search", arguments: { pattern: "foo(a, b)", dir: TEST_DIR } },
      ctx,
    );
    expect(result.content).toContain("foo(a, b)");
    expect(result.content).toContain("code.ts");
  });

  it("returns 'No matches found.' when nothing matches", async () => {
    writeFileSync(join(TEST_DIR, "file.txt"), "some content\n");
    const result = await registry.execute(
      { id: "1", name: "search", arguments: { pattern: "definitely_absent_xyz123", dir: TEST_DIR } },
      ctx,
    );
    expect(result.content).toBe("No matches found.");
    expect(result.error).toBeUndefined();
  });

  it("surfaces a real error for a nonexistent directory without throwing", async () => {
    const result = await registry.execute(
      { id: "1", name: "search", arguments: { pattern: "foo", dir: join(TEST_DIR, "does-not-exist") } },
      ctx,
    );
    expect(result.error).toBeDefined();
    expect(result.content).toContain("Error running search");
  });

  it("caps output at 50 lines", async () => {
    const lines = Array.from({ length: 80 }, (_, i) => `match line number ${i}`).join("\n");
    writeFileSync(join(TEST_DIR, "many.txt"), `${lines}\n`);

    const result = await registry.execute(
      { id: "1", name: "search", arguments: { pattern: "match line number", dir: TEST_DIR } },
      ctx,
    );

    // Strip the untrusted-content wrapper markers before counting lines — by
    // parsing them, not by matching the literals: the markers now carry a random
    // id, so an equality filter would silently strip nothing and every count
    // below would be off by the two marker lines.
    const body = result.content
      .split("\n")
      .filter((l) => parseUntrustedMarker(l) === undefined)
      .join("\n");
    const matchLines = body.split("\n").filter((l) => l.trim() !== "");
    expect(matchLines.length).toBe(50);
  });

  it("wraps matched content in the untrusted-content delimiters (T12)", async () => {
    writeFileSync(join(TEST_DIR, "wrap.txt"), "wrapped-search-hit\n");
    const result = await registry.execute(
      { id: "1", name: "search", arguments: { pattern: "wrapped-search-hit", dir: TEST_DIR } },
      ctx,
    );
    const lines = result.content.trim().split("\n");
    expect(parseUntrustedMarker(lines[0]!)?.role).toBe("begin");
    expect(parseUntrustedMarker(lines[lines.length - 1]!)?.role).toBe("end");
    expect(result.content).toContain("wrapped-search-hit");
  });

  it("strips terminal-control escapes from matched file content (T14)", async () => {
    const osc52 = "\x1b]52;c;aGVsbG8=\x07";
    const csiCursorMove = "\x1b[2K\x1b[1G";
    writeFileSync(join(TEST_DIR, "evil.txt"), `needle ${osc52} middle ${csiCursorMove} tail\n`);

    const result = await registry.execute(
      { id: "1", name: "search", arguments: { pattern: "needle", dir: TEST_DIR } },
      ctx,
    );
    expect(result.content).not.toContain("\x1b");
    expect(result.content).not.toContain("\x07");
    expect(result.content).toContain("needle");
    expect(result.content).toContain("tail");
  });

  // Regression: a search over a large tree was killed by the 30s timeout, and
  // the failure surfaced as Node's bare "Command failed: grep -rn <pattern>
  // <dir>" — no exit code, no stderr. That reads like a malformed command or a
  // denied path, so the real cause (the directory was too big to finish) was
  // invisible.
  //
  // Instead of spawning a subprocess (FIFO/mkfifo which flakes on macOS due to
  // kill EPERM leaking through vitest's fork pool), we directly invoke
  // runSearchTimed with a mocked execFileFn that emits a timeout-shaped error
  // instantly. Same code path, zero subprocess lifecycle dependency.
  it("names the timeout as the cause when the search is killed", async () => {
    // Monotonic counter: first call → 0 (the "started" timestamp), every
    // subsequent call → 500 (well past the 300ms timeout cap).  This makes
    // the timed-out branch (`nowFn() - started >= timeoutMs`) deterministically
    // true, without any subprocess/lifecycle dependency whatsoever.
    let callCount = 0;
    const fakeNowFn = (): number => ++callCount <= 1 ? 0 : 500;

    const fakeExecFile = (_cmd: string, _args: readonly string[], _opts: unknown, cb: (...args: unknown[]) => void) => {
      // Simulate Node's timeout error shape: killed=true, no exit code, no stderr.
      cb(Object.assign(new Error("Command failed: grep -rn anything /fake/dir"), {
        killed: true,
        code: null,
        signal: "SIGTERM",
      }) as Error & { killed?: boolean; code: number | null }, "");
    };

    const result = await runSearchTimed(
      "anything", "/fake/dir", 300,
      fakeExecFile as typeof import("node:child_process").execFile,
      fakeNowFn,
    );

    expect(result.error).toContain("timed out after 0.3s");
    expect(result.error).toContain("/fake/dir");
    expect(result.error).not.toContain("Command failed");
    expect(result.content).toContain("timed out");
  });

  it("skips generated, vendored and cached directories at any depth", async () => {
    writeFileSync(join(TEST_DIR, "src.txt"), "needle here\n");
    const skipped = ["node_modules", ".git", "target", "build", "dist", "vendor", "__pycache__", ".gradle"];
    for (const dir of skipped) {
      // Nested, not top-level: --exclude-dir matches the basename at any
      // depth, and a monorepo's build output is never at the root.
      const nested = join(TEST_DIR, "packages", "app", dir);
      mkdirSync(nested, { recursive: true });
      writeFileSync(join(nested, "generated.txt"), "needle here\n");
    }

    const result = await registry.execute(
      { id: "1", name: "search", arguments: { pattern: "needle", dir: TEST_DIR } },
      ctx,
    );

    expect(result.content).toContain("src.txt");
    for (const dir of skipped) expect(result.content).not.toContain(dir);
  });

  it("still searches a directory whose name only contains a skipped name", async () => {
    // --exclude-dir matches the whole basename, so `build-scripts` and
    // `distribution` are ordinary source directories, not build output.
    for (const dir of ["build-scripts", "distribution", "my-vendor"]) {
      mkdirSync(join(TEST_DIR, dir), { recursive: true });
      writeFileSync(join(TEST_DIR, dir, "src.txt"), "needle here\n");
    }

    const result = await registry.execute(
      { id: "1", name: "search", arguments: { pattern: "needle", dir: TEST_DIR } },
      ctx,
    );

    for (const dir of ["build-scripts", "distribution", "my-vendor"]) {
      expect(result.content).toContain(dir);
    }
  });

  it("still searches bin, which is usually hand-written scripts", async () => {
    mkdirSync(join(TEST_DIR, "bin"), { recursive: true });
    writeFileSync(join(TEST_DIR, "bin", "deploy.sh"), "needle here\n");

    const result = await registry.execute(
      { id: "1", name: "search", arguments: { pattern: "needle", dir: TEST_DIR } },
      ctx,
    );

    expect(result.content).toContain("deploy.sh");
  });

  it("skips binary files", async () => {
    writeFileSync(join(TEST_DIR, "bin.dat"), Buffer.from([0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65, 0x00, 0x01]));
    writeFileSync(join(TEST_DIR, "text.txt"), "needle here\n");

    const result = await registry.execute(
      { id: "1", name: "search", arguments: { pattern: "needle", dir: TEST_DIR } },
      ctx,
    );

    expect(result.content).toContain("text.txt");
    expect(result.content).not.toContain("bin.dat");
  });

});
