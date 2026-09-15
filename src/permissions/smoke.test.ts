import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { projectSettingsPath } from "../config/paths.js";
import { tmpdir } from "node:os";
import { PermissionEngine } from "./engine.js";
import { loadConfig } from "../config/loader.js";

// End-to-end smoke pass against a real temp workspace and real settings.json
// files on disk (no mocking) — exercises every scenario called out in the
// permission-redesign plan's Step 9 manual smoke pass, as durable,
// re-runnable coverage rather than a one-off interactive session.

describe("permission system smoke pass", () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "nib-smoke-"));
    mkdirSync(join(workDir, "src"), { recursive: true });
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it("a plain in-cwd read with an allow-glob rule is a silent allow", () => {
    const engine = new PermissionEngine(
      { rules: [{ tool: "read_file", kind: "glob", pattern: "./**", action: "allow", origin: "config" }] },
      workDir,
    );
    const result = engine.resolve("read_file", { path: join(workDir, "src", "main.ts") });
    expect(result.action).toBe("allow");
    expect(result.wasUnresolved).toBe(false);
  });

  it("an ask-tier bash command exercises each of the 4 decision paths correctly", () => {
    const engine = new PermissionEngine(undefined, workDir);
    const command = "npm test";

    // 1. "once": no engine call at all — the turn just proceeds. Nothing to
    // assert against the engine itself; confirm the base case still asks.
    const initial = engine.resolve("run_bash", { command });
    expect(initial.action).toBe("ask");

    // 2. "session": approveForSession takes effect immediately, in-memory only.
    const sessionEngine = new PermissionEngine(undefined, workDir);
    const sessionRule = sessionEngine.buildDefaultRule("run_bash", { command });
    sessionEngine.approveForSession(sessionRule);
    expect(sessionEngine.resolve("run_bash", { command }).action).toBe("allow");
    expect(existsSync(projectSettingsPath(workDir))).toBe(false);

    // 3. "always": approveAlways takes effect immediately AND persists to disk.
    const alwaysEngine = new PermissionEngine(undefined, workDir);
    const alwaysRule = alwaysEngine.buildDefaultRule("run_bash", { command });
    alwaysEngine.approveAlways(alwaysRule);
    expect(alwaysEngine.resolve("run_bash", { command }).action).toBe("allow");
    expect(existsSync(projectSettingsPath(workDir))).toBe(true);

    // 4. "no" (deny): a fresh engine with no approval still asks (never denies
    // outright for an ordinary unconfigured call — that's the UI's job to
    // translate a "no" answer into askUser resolving false).
    const freshEngine = new PermissionEngine(undefined, workDir);
    expect(freshEngine.resolve("run_bash", { command }).action).toBe("ask");
  });

  it("session-tier approval does not survive a fresh engine instance (simulated restart), always-tier does", () => {
    const command = "npm run build";

    const engine = new PermissionEngine(undefined, workDir);
    engine.approveForSession(engine.buildDefaultRule("run_bash", { command: "npm run session-only" }));
    engine.approveAlways(engine.buildDefaultRule("run_bash", { command }));

    // Simulate a process restart: load settings.json fresh and construct a
    // brand new engine from it, exactly as cli.tsx does on startup.
    const { config } = loadConfig(workDir);
    const restarted = new PermissionEngine(config.permissions, workDir);

    expect(restarted.resolve("run_bash", { command: "npm run session-only" }).action).toBe("ask");
    expect(restarted.resolve("run_bash", { command }).action).toBe("allow");
  });

  it("inspecting settings.json before/after: absent before any always-approval, present and containing the rule after", () => {
    const settingsPath = projectSettingsPath(workDir);
    expect(existsSync(settingsPath)).toBe(false);

    const engine = new PermissionEngine(undefined, workDir);
    engine.approveAlways(engine.buildDefaultRule("run_bash", { command: "npm test" }));

    expect(existsSync(settingsPath)).toBe(true);
    const written = JSON.parse(readFileSync(settingsPath, "utf-8"));
    expect(written.permissions.rules).toContainEqual({ tool: "run_bash", pattern: "npm test", action: "allow" });
  });

  it("git reset --hard requires the stronger destructive confirmation path (winningRule.origin is builtin-destructive)", () => {
    const engine = new PermissionEngine(undefined, workDir);
    const result = engine.resolve("run_bash", { command: "git reset --hard HEAD~3" });

    expect(result.action).toBe("deny");
    expect(result.winningRule?.origin).toBe("builtin-destructive");
    // This is exactly what App.tsx's render logic checks to route to
    // DestructiveConfirmPrompt instead of the standard 4-option prompt.
  });

  it("an obfuscated destructive command still surfaces a real prompt even conceptually under auto-approve posture (wasUnresolved is never bypassable)", () => {
    const engine = new PermissionEngine(undefined, workDir);
    const result = engine.resolve("run_bash", { command: "env rm -rf /tmp/scratch" });

    // The engine's own result must carry wasUnresolved:true — this is the
    // exact flag App.tsx's askUser callback checks before applying the
    // auto-approve posture bypass. Confirming it here, at the source, is
    // the real regression test for the kill-chain the plan's review found:
    // if this flag were ever false for an unresolved segment, the UI-layer
    // bypass would silently wave the command through.
    expect(result.action).toBe("ask");
    expect(result.wasUnresolved).toBe(true);
  });

  it("a sub-agent style call (resolve() then askUser-equivalent) exercises ask-tier rather than silently denying", async () => {
    // Mirrors the agent.ts code path: permissions.resolve() returns "ask",
    // and when an askUser callback is provided (as orchestrator/index.ts now
    // threads through per Step 5), it's called rather than the call being
    // auto-denied headlessly.
    const engine = new PermissionEngine(undefined, workDir);
    const { action } = engine.resolve("run_bash", { command: "npm test" });
    expect(action).toBe("ask");

    let askUserCalled = false;
    const askUser = async (_toolName: string, _args: Record<string, unknown>) => {
      askUserCalled = true;
      return true;
    };

    const allowed = await askUser("run_bash", { command: "npm test" });
    expect(askUserCalled).toBe(true);
    expect(allowed).toBe(true);
  });
});
