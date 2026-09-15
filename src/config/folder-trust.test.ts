import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, statSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { projectDirPath } from "./paths.js";
import { tmpdir } from "node:os";
import {
  checkFolderTrust,
  trustFolder,
  buildFolderContentSummary,
  hasGatedContent,
  loadFolderTrust,
} from "./folder-trust.js";
import { loadConfig } from "./loader.js";
import { checkSettingsTrust } from "./settings-trust.js";
import { checkSkillTrust } from "../skills/trust.js";
import { loadHookTrust, hookContentHash, hookTrustKey } from "../hooks/trust.js";

// Folder-level "fast path" trust (docs/security-tasks.md — folder-trust
// section): a bulk-approval convenience layered on top of the three existing
// per-artifact TOFU gates (skills, settings, hooks). Trusting a folder
// bulk-applies to the same three underlying stores those gates already read,
// for exactly the artifacts present at trust time. Content added or changed
// afterward is NOT covered by that bulk grant — it still re-prompts via the
// normal per-artifact gate. These tests exercise both the folder-trust
// classification itself and its effect on the three real gates.

const TEST_DIR = join(tmpdir(), `heirloom-folder-trust-${process.pid}`);
const HOME_DIR = join(TEST_DIR, "home");
const TRUST_FILE = join(HOME_DIR, "folder-trust.json");

let projectDir: string;
let prevHeirloomHome: string | undefined;
let prevHome: string | undefined;

function writeSkill(dir: string, name: string, body = "Body of " + name): string {
  const skillDir = join(projectDirPath(dir), "skills", name);
  mkdirSync(skillDir, { recursive: true });
  const path = join(skillDir, "SKILL.md");
  writeFileSync(path, `---\nname: ${name}\ndescription: test ${name}\n---\n${body}`, "utf-8");
  return path;
}

function writeProjectSettings(dir: string, settings: Record<string, unknown>): string {
  const heirloomDir = projectDirPath(dir);
  mkdirSync(heirloomDir, { recursive: true });
  const path = join(heirloomDir, "settings.json");
  writeFileSync(path, JSON.stringify(settings, null, 2), "utf-8");
  return path;
}

/** The trust stores key by realpath — a workspace reached via a symlink (or
 *  macOS's /var → /private/var) must not get two keys. */
function real(path: string): string {
  return realpathSync(path);
}

beforeEach(() => {
  mkdirSync(HOME_DIR, { recursive: true });
  projectDir = mkdtempSync(join(TEST_DIR, "project-"));
  prevHeirloomHome = process.env.HEIRLOOM_HOME;
  prevHome = process.env.HOME;
  process.env.HEIRLOOM_HOME = HOME_DIR;
  process.env.HOME = HOME_DIR;
});

afterEach(() => {
  if (prevHeirloomHome === undefined) delete process.env.HEIRLOOM_HOME;
  else process.env.HEIRLOOM_HOME = prevHeirloomHome;
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("hasGatedContent / buildFolderContentSummary", () => {
  it("a project with nothing gated has no gated content", () => {
    const configResult = loadConfig(projectDir);
    const summary = buildFolderContentSummary(projectDir, configResult);
    expect(hasGatedContent(summary)).toBe(false);
  });

  it("a project with a skill, a gated settings key, and a hook is fully summarized", () => {
    writeSkill(projectDir, "alpha");
    writeProjectSettings(projectDir, {
      mcpServers: { x: { command: "npx" } },
      hooks: { SessionStart: [{ command: "echo hi" }] },
    });
    const configResult = loadConfig(projectDir);
    const summary = buildFolderContentSummary(projectDir, configResult);
    expect(hasGatedContent(summary)).toBe(true);
    expect(summary.skills.map((s) => s.name)).toEqual(["alpha"]);
    expect(summary.settingsKeys).toEqual(["mcpServers"]);
    expect(summary.hooks).toHaveLength(1);
    expect(summary.hooks[0].command).toBe("echo hi");
    expect(summary.hooks[0].origin).toBe("project");
  });
});

describe("checkFolderTrust / trustFolder — classification", () => {
  it("new → trustFolder → trusted", () => {
    writeSkill(projectDir, "alpha");
    writeProjectSettings(projectDir, { mcpServers: { x: { command: "npx" } } });
    const configResult = loadConfig(projectDir);
    const summary = buildFolderContentSummary(projectDir, configResult);

    expect(checkFolderTrust(projectDir, summary)).toEqual({ status: "new" });
    trustFolder(projectDir, summary);
    expect(checkFolderTrust(projectDir, summary)).toEqual({ status: "trusted" });
  });
});

describe("folder trust as a fast path over the three real gates", () => {
  it("trusting a folder marks the skill and the settings key as trusted — the real gates see no prompt needed", () => {
    const skillPath = writeSkill(projectDir, "alpha");
    const settingsPath = writeProjectSettings(projectDir, { mcpServers: { x: { command: "npx" } } });
    const configResult = loadConfig(projectDir);
    const summary = buildFolderContentSummary(projectDir, configResult);

    // Before trusting the folder, the real per-artifact gates see new/unseen content.
    expect(checkSkillTrust(skillPath, "alpha").status).toBe("new");
    expect(checkSettingsTrust(settingsPath)).toEqual({ status: "new" });

    trustFolder(projectDir, summary);

    // After trusting the folder, the REAL gates (not folder-trust's own
    // store) independently report trusted — this is the actual mechanism
    // that makes per-artifact prompts not fire.
    expect(checkSkillTrust(skillPath, "alpha")).toEqual({ status: "trusted" });
    expect(checkSettingsTrust(settingsPath)).toEqual({ status: "trusted" });
  });

  it("trusting a folder pre-records a hook trust entry under the exact key HookRunner's lazy check computes", () => {
    writeProjectSettings(projectDir, { hooks: { SessionStart: [{ command: "echo hi" }] } });
    const configResult = loadConfig(projectDir);
    const summary = buildFolderContentSummary(projectDir, configResult);
    trustFolder(projectDir, summary);

    const hookEntry = summary.hooks[0];
    const realProjectDir = real(projectDir);
    const contentHash = hookContentHash(hookEntry.command, realProjectDir);
    const key = hookTrustKey(hookEntry.event, hookEntry.matcher, hookEntry.command, contentHash, realProjectDir);

    const store = loadHookTrust();
    expect(store.hooks[key]?.trusted).toBe(true);
  });

  it("a folder with no gated content never needs a folder-trust decision at all", () => {
    const configResult = loadConfig(projectDir);
    const summary = buildFolderContentSummary(projectDir, configResult);
    expect(hasGatedContent(summary)).toBe(false);
    // Nothing to assert on checkFolderTrust here — callers gate on
    // hasGatedContent before ever calling checkFolderTrust/prompting.
  });
});

describe("re-prompt semantics — the whole point of the fast path", () => {
  it("a skill EDITED after folder trust re-prompts (folder trust is not a blanket grant)", () => {
    const skillPath = writeSkill(projectDir, "alpha", "original body");
    const configResult1 = loadConfig(projectDir);
    const summary1 = buildFolderContentSummary(projectDir, configResult1);
    trustFolder(projectDir, summary1);
    expect(checkSkillTrust(skillPath, "alpha")).toEqual({ status: "trusted" });
    expect(checkFolderTrust(projectDir, summary1)).toEqual({ status: "trusted" });

    // Edit the skill content.
    writeSkill(projectDir, "alpha", "EDITED body — tamper signal");

    // The real per-artifact gate re-prompts.
    const result = checkSkillTrust(skillPath, "alpha");
    expect(result.status).toBe("changed");

    // The folder-trust classification also reflects the change (its own
    // artifact-hash bookkeeping), so a caller that re-checks folder trust
    // would show the prompt again rather than silently reusing the old "yes".
    const configResult2 = loadConfig(projectDir);
    const summary2 = buildFolderContentSummary(projectDir, configResult2);
    expect(checkFolderTrust(projectDir, summary2)).toEqual({ status: "changed" });
  });

  it("a skill ADDED after folder trust re-prompts", () => {
    writeSkill(projectDir, "alpha");
    const configResult1 = loadConfig(projectDir);
    const summary1 = buildFolderContentSummary(projectDir, configResult1);
    trustFolder(projectDir, summary1);

    // Add a second skill after the folder was trusted.
    const betaPath = writeSkill(projectDir, "beta");

    // The real per-artifact gate has never seen "beta" — it's new.
    expect(checkSkillTrust(betaPath, "beta")).toEqual({ status: "new", name: "beta", sourcePath: real(betaPath) });

    // Folder trust also reflects the addition.
    const configResult2 = loadConfig(projectDir);
    const summary2 = buildFolderContentSummary(projectDir, configResult2);
    expect(checkFolderTrust(projectDir, summary2)).toEqual({ status: "changed" });
  });

  it("the settings file EDITED after folder trust re-prompts / re-strips", () => {
    const settingsPath = writeProjectSettings(projectDir, { mcpServers: { x: { command: "npx" } } });
    const configResult1 = loadConfig(projectDir);
    const summary1 = buildFolderContentSummary(projectDir, configResult1);
    trustFolder(projectDir, summary1);
    expect(checkSettingsTrust(settingsPath)).toEqual({ status: "trusted" });

    // Edit the settings file — add a new execution-capable key.
    writeFileSync(settingsPath, JSON.stringify({ mcpServers: { x: { command: "npx" } }, notify: "/tmp/x.sh" }));

    expect(checkSettingsTrust(settingsPath)).toEqual({ status: "changed" });

    const configResult2 = loadConfig(projectDir);
    const summary2 = buildFolderContentSummary(projectDir, configResult2);
    expect(checkFolderTrust(projectDir, summary2)).toEqual({ status: "changed" });
  });

  it("a hook whose command changed after folder trust re-prompts", () => {
    writeProjectSettings(projectDir, { hooks: { SessionStart: [{ command: "echo original" }] } });
    const configResult1 = loadConfig(projectDir);
    const summary1 = buildFolderContentSummary(projectDir, configResult1);
    trustFolder(projectDir, summary1);

    const realProjectDir = real(projectDir);
    const originalHash = hookContentHash("echo original", realProjectDir);
    const originalKey = hookTrustKey("SessionStart", undefined, "echo original", originalHash, realProjectDir);
    expect(loadHookTrust().hooks[originalKey]?.trusted).toBe(true);

    // Change the hook's command.
    writeProjectSettings(projectDir, { hooks: { SessionStart: [{ command: "echo CHANGED" }] } });
    const configResult2 = loadConfig(projectDir);
    const summary2 = buildFolderContentSummary(projectDir, configResult2);

    // The changed command hashes to a DIFFERENT trust key with no matching
    // pre-recorded entry — HookRunner's lazy check (trustKeyFor) would find
    // nothing trusted and ask normally.
    const changedHash = hookContentHash("echo CHANGED", realProjectDir);
    const changedKey = hookTrustKey("SessionStart", undefined, "echo CHANGED", changedHash, realProjectDir);
    expect(changedKey).not.toBe(originalKey);
    expect(loadHookTrust().hooks[changedKey]).toBeUndefined();

    // Folder trust also reflects the change.
    expect(checkFolderTrust(projectDir, summary2)).toEqual({ status: "changed" });
  });

  it("a hook script file's content changing (not just the command string) changes its trust key", () => {
    const scriptDir = join(projectDir, "hook-scripts");
    mkdirSync(scriptDir, { recursive: true });
    const scriptPath = join(scriptDir, "guard.sh");
    writeFileSync(scriptPath, "#!/bin/sh\necho original\n");
    writeProjectSettings(projectDir, { hooks: { SessionStart: [{ command: "hook-scripts/guard.sh" }] } });

    const configResult1 = loadConfig(projectDir);
    const summary1 = buildFolderContentSummary(projectDir, configResult1);
    trustFolder(projectDir, summary1);

    const realProjectDir = real(projectDir);
    const originalHash = hookContentHash("hook-scripts/guard.sh", realProjectDir);
    const originalKey = hookTrustKey("SessionStart", undefined, "hook-scripts/guard.sh", originalHash, realProjectDir);
    expect(loadHookTrust().hooks[originalKey]?.trusted).toBe(true);

    // Edit the script's content (command string is unchanged).
    writeFileSync(scriptPath, "#!/bin/sh\necho CHANGED\n");
    const changedHash = hookContentHash("hook-scripts/guard.sh", realProjectDir);
    expect(changedHash).not.toBe(originalHash);
    const changedKey = hookTrustKey("SessionStart", undefined, "hook-scripts/guard.sh", changedHash, realProjectDir);
    expect(loadHookTrust().hooks[changedKey]).toBeUndefined();

    const configResult2 = loadConfig(projectDir);
    const summary2 = buildFolderContentSummary(projectDir, configResult2);
    expect(checkFolderTrust(projectDir, summary2)).toEqual({ status: "changed" });
  });
});

describe("folder declined — the three existing gates behave exactly as today", () => {
  it("no trustFolder call ever happening leaves every gate at its normal new/changed classification", () => {
    const skillPath = writeSkill(projectDir, "alpha");
    const settingsPath = writeProjectSettings(projectDir, { mcpServers: { x: { command: "npx" } } });
    const configResult = loadConfig(projectDir);
    const summary = buildFolderContentSummary(projectDir, configResult);

    expect(checkFolderTrust(projectDir, summary)).toEqual({ status: "new" });
    // Declining never calls trustFolder — assert the underlying gates are untouched.
    expect(checkSkillTrust(skillPath, "alpha").status).toBe("new");
    expect(checkSettingsTrust(settingsPath)).toEqual({ status: "new" });
    expect(loadHookTrust().hooks).toEqual({});
  });
});

describe("trust store hygiene", () => {
  it("writes mode 0600, atomically, under HEIRLOOM_HOME, storing hashes not content", () => {
    writeSkill(projectDir, "alpha", "secret-canary-body");
    const configResult = loadConfig(projectDir);
    const summary = buildFolderContentSummary(projectDir, configResult);
    trustFolder(projectDir, summary);

    const raw = readFileSync(TRUST_FILE, "utf-8");
    expect(raw).not.toContain("secret-canary-body");

    const parsed = JSON.parse(raw);
    const entry = parsed.folders[real(projectDir)];
    expect(entry).toBeDefined();
    expect(entry.trusted).toBe(true);
    expect(entry.firstSeen).toEqual(expect.any(Number));
    // Every stored artifact hash for the skill is a full sha256, never truncated.
    const skillHashKey = Object.keys(entry.artifactHashes).find((k) => k.startsWith("skill:"));
    expect(skillHashKey).toBeDefined();
    expect(entry.artifactHashes[skillHashKey!]).toMatch(/^[0-9a-f]{64}$/);

    const mode = statSync(TRUST_FILE).mode & 0o777;
    expect(mode).toBe(0o600);

    // Atomic write: no leftover temp files next to the store.
    expect(readdirSync(HOME_DIR).sort()).toEqual(["folder-trust.json", "skill-trust.json"]);
  });
});

describe("headless never auto-trusts", () => {
  it("checkFolderTrust alone never mutates state — only trustFolder (an explicit call) does", () => {
    writeSkill(projectDir, "alpha");
    const configResult = loadConfig(projectDir);
    const summary = buildFolderContentSummary(projectDir, configResult);

    // Simulate a headless run: it may call checkFolderTrust-adjacent read
    // paths (or, per the real exec-runner.ts wiring, nothing at all) but
    // must never call trustFolder. Confirm no store is created just from
    // reads.
    checkFolderTrust(projectDir, summary);
    expect(loadFolderTrust().folders).toEqual({});
    expect(readdirSync(HOME_DIR)).toEqual([]);
  });
});
