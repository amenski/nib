import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HookRunner, hookContentHash, hookTrustKey } from "./index.js";
import { parseHooksConfig } from "./config.js";
import type { HooksConfig } from "./types.js";

// TOFU trust model (hooks-spec.md §6): global (~/.nib) hooks are trusted
// implicitly; project hooks must clear hooks-trust.json, prompting exactly
// once per unseen trust key (y = trust forever, n = skip this session).
// Keys are content-hashed and project-scoped (fix 1): a script edit or a
// second project changes the key and re-prompts. Headless runs skip untrusted
// hooks with a stderr warning.

const TEST_DIR = join(tmpdir(), `nib-hooks-trust-${process.pid}`);
const HOME_DIR = join(TEST_DIR, "home");
const TRUST_FILE = join(HOME_DIR, "hooks-trust.json");

function projectConfig(hooks: Record<string, unknown>): HooksConfig {
  const parsed = parseHooksConfig(undefined, hooks, "test", []);
  if (!parsed) throw new Error("parseHooksConfig returned undefined");
  return parsed;
}

function globalConfig(hooks: Record<string, unknown>): HooksConfig {
  const parsed = parseHooksConfig(hooks, undefined, "test", []);
  if (!parsed) throw new Error("parseHooksConfig returned undefined");
  return parsed;
}

function makeRunner(
  config: HooksConfig,
  overrides?: Partial<ConstructorParameters<typeof HookRunner>[0]>,
): HookRunner {
  return new HookRunner({
    config,
    cwd: TEST_DIR,
    sessionId: () => "s1",
    getPermissionMode: () => "normal",
    timeoutMs: 2000,
    ...overrides,
  });
}

const markerFile = join(TEST_DIR, "ran");
const scriptFile = () => {
  const dir = join(TEST_DIR, "hook-scripts");
  mkdirSync(dir, { recursive: true });
  return join(dir, "guard.sh");
};

/**
 * Keep the hook's stdin read end open until the runner closes the pipe (cat
 * reads to EOF). These tests' commands (`touch`, `echo`) exit instantly;
 * under machine load the runner's payload write (runner.ts runHook) can then
 * hit EPIPE — an 'error' event on the child's stdin with no listener, which
 * crashes the test worker. Holding the pipe open makes the write structurally
 * safe, no fixed sleeps or timing.
 */
const holdStdin = (cmd: string): string => `${cmd}; cat > /dev/null`;

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  mkdirSync(HOME_DIR, { recursive: true });
  process.env.NIB_HOME = HOME_DIR;
});

afterEach(() => {
  delete process.env.NIB_HOME;
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("TOFU trust", () => {
  it("trusts global hooks implicitly — never prompts", async () => {
    const runner = makeRunner(globalConfig({
      PreToolUse: [{ command: holdStdin(`touch '${markerFile}'`) }],
    }));
    const confirmTrust = vi.fn(async () => true);
    runner.confirmTrust = confirmTrust;

    const result = await runner.dispatch("PreToolUse", { tool_name: "run_bash", tool_input: {} });

    expect(confirmTrust).not.toHaveBeenCalled();
    expect(result.blocked).toBe(false);
    expect(existsSync(markerFile)).toBe(true);
  });

  it("prompts exactly once per unseen project hook, then runs it", async () => {
    const runner = makeRunner(projectConfig({
      PreToolUse: [{ command: holdStdin(`touch '${markerFile}'`) }],
    }));
    const confirmTrust = vi.fn(async () => true);
    runner.confirmTrust = confirmTrust;

    await runner.dispatch("PreToolUse", { tool_name: "run_bash", tool_input: {} });
    await runner.dispatch("PreToolUse", { tool_name: "run_bash", tool_input: {} });

    expect(confirmTrust).toHaveBeenCalledTimes(1);
    expect(confirmTrust).toHaveBeenCalledWith(expect.objectContaining({
      event: "PreToolUse",
      command: holdStdin(`touch '${markerFile}'`),
      origin: "project",
    }));
    expect(existsSync(markerFile)).toBe(true);
  });

  it("persists the trust forever when the user says yes", async () => {
    const runner = makeRunner(projectConfig({
      PreToolUse: [{ command: holdStdin(`touch '${markerFile}'`) }],
    }));
    runner.confirmTrust = async () => true;
    await runner.dispatch("PreToolUse", { tool_name: "run_bash", tool_input: {} });

    expect(existsSync(TRUST_FILE)).toBe(true);

    // A brand-new runner (next session, same HOME + cwd) must not prompt again.
    const confirmTrust = vi.fn(async () => true);
    const second = makeRunner(projectConfig({
      PreToolUse: [{ command: holdStdin(`touch '${markerFile}'`) }],
    }));
    second.confirmTrust = confirmTrust;
    await second.dispatch("PreToolUse", { tool_name: "run_bash", tool_input: {} });

    expect(confirmTrust).not.toHaveBeenCalled();
  });

  it("a 'no' skips the hook for the rest of the session without re-prompting", async () => {
    const runner = makeRunner(projectConfig({
      PreToolUse: [{ command: holdStdin(`touch '${markerFile}'`) }],
    }));
    const confirmTrust = vi.fn(async () => false);
    runner.confirmTrust = confirmTrust;

    await runner.dispatch("PreToolUse", { tool_name: "run_bash", tool_input: {} });
    await runner.dispatch("PreToolUse", { tool_name: "run_bash", tool_input: {} });

    expect(confirmTrust).toHaveBeenCalledTimes(1);
    expect(existsSync(markerFile)).toBe(false);
  });

  it("headless skips untrusted project hooks with a stderr warning and never prompts", async () => {
    const runner = makeRunner(projectConfig({
      PreToolUse: [{ command: holdStdin(`touch '${markerFile}'`) }],
    }), { headless: true });
    const stderr: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: any) => {
      stderr.push(String(chunk));
      return true;
    });
    try {
      runner.verifyTrust();

      const result = await runner.dispatch("PreToolUse", { tool_name: "run_bash", tool_input: {} });

      expect(result.blocked).toBe(false);
      expect(existsSync(markerFile)).toBe(false);
      expect(stderr.join("")).toContain("skipping untrusted project hook");
      expect(stderr.join("")).toContain("PreToolUse");
    } finally {
      spy.mockRestore();
    }
  });

  it("headless runs trusted project hooks without prompting", async () => {
    // Pre-trust the pair (as a previous interactive session would have).
    const runner = makeRunner(projectConfig({
      PreToolUse: [{ command: holdStdin(`touch '${markerFile}'`) }],
    }));
    runner.confirmTrust = async () => true;
    await runner.dispatch("PreToolUse", { tool_name: "run_bash", tool_input: {} }); // interactive ask, persists
    expect(existsSync(TRUST_FILE)).toBe(true);

    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const headless = makeRunner(projectConfig({
        PreToolUse: [{ command: holdStdin(`touch '${markerFile}'`) }],
      }), { headless: true });
      headless.verifyTrust();
      await headless.dispatch("PreToolUse", { tool_name: "run_bash", tool_input: {} });

      expect(stderr).not.toHaveBeenCalled();
      expect(existsSync(markerFile)).toBe(true);
    } finally {
      stderr.mockRestore();
    }
  });

  it("disableAllHooks overrides everything — no prompts, no warnings, nothing runs", async () => {
    const runner = makeRunner(
      projectConfig({ PreToolUse: [{ command: holdStdin(`touch '${markerFile}'`) }] }),
      { headless: true, disableAllHooks: true },
    );
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      runner.verifyTrust();
      await runner.dispatch("PreToolUse", { tool_name: "run_bash", tool_input: {} });

      expect(stderr).not.toHaveBeenCalled();
      expect(existsSync(markerFile)).toBe(false);
    } finally {
      stderr.mockRestore();
    }
  });
});

describe("content-hashed, project-scoped trust keys (fix 1)", () => {
  it("hashes the script CONTENT for file commands, not just the command string", async () => {
    const script = scriptFile();
    writeFileSync(script, "touch one");

    const before = hookContentHash("hook-scripts/guard.sh", TEST_DIR);
    writeFileSync(script, "touch two");
    const after = hookContentHash("hook-scripts/guard.sh", TEST_DIR);

    expect(before).not.toBe(after);
    // The command string never changed — only the file content did.
    expect(before).not.toBe(hookContentHash("echo hi", TEST_DIR));
  });

  it("hashes the command string itself for inline shell commands", async () => {
    expect(hookContentHash("npm run x", TEST_DIR)).toBe(hookContentHash("npm run x", TEST_DIR));
    expect(hookContentHash("npm run x", TEST_DIR)).not.toBe(hookContentHash("npm run y", TEST_DIR));
  });

  it("a missing script file hashes to a never-auto-trusted sentinel", async () => {
    expect(hookContentHash("hook-scripts/ghost.sh", TEST_DIR)).toBe("missing");
    // And a missing file never matches a stored key: trusting the script while
    // it exists does not cover the same command once the file is gone.
    const script = scriptFile();
    writeFileSync(script, "touch one");
    expect(hookContentHash("hook-scripts/guard.sh", TEST_DIR)).not.toBe("missing");
  });

  it("produces full 256-bit keys scoped to event, matcher, command, content, and project", () => {
    const c1 = hookContentHash("hook-scripts/guard.sh", TEST_DIR);
    const key = hookTrustKey("PreToolUse", "run_bash", "hook-scripts/guard.sh", c1, TEST_DIR);
    expect(key).toMatch(/^[0-9a-f]{64}$/);

    // Every input participates: event, matcher, command, content hash, project dir.
    expect(key).not.toBe(hookTrustKey("PostToolUse", "run_bash", "hook-scripts/guard.sh", c1, TEST_DIR));
    expect(key).not.toBe(hookTrustKey("PreToolUse", undefined, "hook-scripts/guard.sh", c1, TEST_DIR));
    expect(key).not.toBe(hookTrustKey("PreToolUse", "run_bash", "other.sh", c1, TEST_DIR));
    expect(key).not.toBe(hookTrustKey("PreToolUse", "run_bash", "hook-scripts/guard.sh", "different-hash", TEST_DIR));
    expect(key).not.toBe(hookTrustKey("PreToolUse", "run_bash", "hook-scripts/guard.sh", c1, "/elsewhere"));
    // Deterministic for identical inputs.
    expect(key).toBe(hookTrustKey("PreToolUse", "run_bash", "hook-scripts/guard.sh", c1, TEST_DIR));
  });

  it("a script content change is treated as unseen — re-confirms before running", async () => {
    const script = scriptFile();
    writeFileSync(script, holdStdin("touch one"));
    const runner = makeRunner(projectConfig({
      PreToolUse: [{ command: "hook-scripts/guard.sh" }],
    }));
    const confirmTrust = vi.fn(async () => true);
    runner.confirmTrust = confirmTrust;

    await runner.dispatch("PreToolUse", { tool_name: "run_bash", tool_input: {} });
    expect(confirmTrust).toHaveBeenCalledTimes(1);

    // Give the filesystem a beat so the mtime is observably different, then
    // swap the script content — the key must change and the ask must fire
    // again even though the command string is identical.
    await new Promise((r) => setTimeout(r, 20));
    writeFileSync(script, holdStdin("touch two"));
    await runner.dispatch("PreToolUse", { tool_name: "run_bash", tool_input: {} });

    expect(confirmTrust).toHaveBeenCalledTimes(2);
  });

  it("the same hook in a second project prompts again (trust never leaks across projects)", async () => {
    const projectA = join(TEST_DIR, "project-a");
    const projectB = join(TEST_DIR, "project-b");
    for (const dir of [projectA, projectB]) {
      mkdirSync(join(dir, "hook-scripts"), { recursive: true });
      writeFileSync(join(dir, "hook-scripts", "guard.sh"), holdStdin("echo hi"));
    }
    const cfgA = parseHooksConfig(undefined, { PreToolUse: [{ command: "hook-scripts/guard.sh" }] }, "test", [])!;
    const cfgB = parseHooksConfig(undefined, { PreToolUse: [{ command: "hook-scripts/guard.sh" }] }, "test", [])!;

    const runnerA = new HookRunner({
      config: cfgA, cwd: projectA, sessionId: () => "s1", getPermissionMode: () => "normal", timeoutMs: 2000,
    });
    const confirmA = vi.fn(async () => true);
    runnerA.confirmTrust = confirmA;
    await runnerA.dispatch("PreToolUse", { tool_name: "run_bash", tool_input: {} });
    expect(confirmA).toHaveBeenCalledTimes(1);

    // Identical command + identical script content, different project — the
    // project-scoped key does not match, so the ask fires again.
    const runnerB = new HookRunner({
      config: cfgB, cwd: projectB, sessionId: () => "s1", getPermissionMode: () => "normal", timeoutMs: 2000,
    });
    const confirmB = vi.fn(async () => true);
    runnerB.confirmTrust = confirmB;
    await runnerB.dispatch("PreToolUse", { tool_name: "run_bash", tool_input: {} });
    expect(confirmB).toHaveBeenCalledTimes(1);
  });

  it("deleting a trusted script's file makes it untrusted again (missing = untrusted)", async () => {
    const script = scriptFile();
    writeFileSync(script, holdStdin("touch one"));
    const runner = makeRunner(projectConfig({
      PreToolUse: [{ command: "hook-scripts/guard.sh" }],
    }));
    runner.confirmTrust = async () => true;
    await runner.dispatch("PreToolUse", { tool_name: "run_bash", tool_input: {} });
    expect(existsSync(TRUST_FILE)).toBe(true);

    rmSync(script, { force: true });
    const confirmTrust = vi.fn(async () => true);
    runner.confirmTrust = confirmTrust;
    await runner.dispatch("PreToolUse", { tool_name: "run_bash", tool_input: {} });

    expect(confirmTrust).toHaveBeenCalledTimes(1);
  });
});

describe("trust file hygiene (fix 6)", () => {
  it("writes mode 0600 with full-hash keys, atomic rename, and no plaintext command/event", async () => {
    const runner = makeRunner(projectConfig({
      PreToolUse: [{ matcher: "run_bash", command: "hook-scripts/guard.sh" }],
    }));
    writeFileSync(scriptFile(), holdStdin("echo hi"));
    runner.confirmTrust = async () => true;
    await runner.dispatch("PreToolUse", { tool_name: "run_bash", tool_input: {} });

    const raw = readFileSync(TRUST_FILE, "utf-8");
    // The file's comment promise: no plaintext command or event text.
    expect(raw).not.toContain("hook-scripts/guard.sh");
    expect(raw).not.toContain("PreToolUse");
    expect(raw).not.toContain("run_bash");

    const parsed = JSON.parse(raw);
    const keys = Object.keys(parsed.hooks);
    expect(keys).toHaveLength(1);
    // Full 256-bit hash — not a truncated fingerprint.
    expect(keys[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(parsed.hooks[keys[0]]).toEqual({ firstSeen: expect.any(Number), trusted: true });

    const mode = statSync(TRUST_FILE).mode & 0o777;
    expect(mode).toBe(0o600);

    // Atomic write: no leftover temp files next to the store.
    expect(readdirSync(HOME_DIR).sort()).toEqual(["hooks-trust.json"]);
  });

  it("a save failure is swallowed with a stderr note — never an unhandled rejection", async () => {
    // Point NIB_HOME at a path that cannot be created (a file in the way).
    writeFileSync(join(TEST_DIR, "blocker"), "x");
    process.env.NIB_HOME = join(TEST_DIR, "blocker", "home");

    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const runner = makeRunner(projectConfig({
      PreToolUse: [{ command: holdStdin(`touch '${markerFile}'`) }],
    }));
    runner.confirmTrust = async () => true;
    try {
      await runner.dispatch("PreToolUse", { tool_name: "run_bash", tool_input: {} });

      // The hook still ran this session despite the failed persist.
      expect(existsSync(markerFile)).toBe(true);
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining("failed to write hooks-trust.json"));
    } finally {
      stderr.mockRestore();
    }
  });
});
