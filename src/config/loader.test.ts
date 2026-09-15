import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { projectDirPath, projectSettingsPath } from "./paths.js";
import { tmpdir } from "node:os";
import { loadConfig, migrateLegacyPermissions, resolveHome, sandboxSupportedOnPlatform } from "./loader.js";
import { homedir } from "node:os";

describe("validatePermissions (rule shape)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "heirloom-loader-"));
    mkdirSync(projectDirPath(dir), { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeSettings(json: unknown) {
    writeFileSync(projectSettingsPath(dir), JSON.stringify(json), "utf-8");
  }

  it("accepts a well-formed rules array", () => {
    writeSettings({
      permissions: {
        rules: [
          { tool: "run_bash", pattern: "git status", action: "allow" },
          { tool: "run_bash", pattern: "git commit:*", action: "allow" },
        ],
        defaultMode: "askAll",
      },
    });
    const { config, errors } = loadConfig(dir);
    expect(errors).toEqual([]);
    expect(config.permissions?.rules).toHaveLength(2);
  });

  it("parses a :* suffix pattern as prefix kind", () => {
    writeSettings({ permissions: { rules: [{ tool: "run_bash", pattern: "git commit:*", action: "allow" }] } });
    const { config } = loadConfig(dir);
    expect(config.permissions?.rules?.[0]).toMatchObject({ kind: "prefix", pattern: "git commit" });
  });

  it("parses a plain string pattern as exact kind", () => {
    writeSettings({ permissions: { rules: [{ tool: "run_bash", pattern: "git status", action: "allow" }] } });
    const { config } = loadConfig(dir);
    expect(config.permissions?.rules?.[0]).toMatchObject({ kind: "exact", pattern: "git status" });
  });

  it("parses a glob-containing pattern as glob kind", () => {
    writeSettings({ permissions: { rules: [{ tool: "read_file", pattern: "./src/**", action: "allow" }] } });
    const { config } = loadConfig(dir);
    expect(config.permissions?.rules?.[0]).toMatchObject({ kind: "glob", pattern: "./src/**" });
  });

  it("rejects a rule missing tool", () => {
    writeSettings({ permissions: { rules: [{ pattern: "git status", action: "allow" }] } });
    const { errors } = loadConfig(dir);
    expect(errors.some((e) => e.includes("missing string \"tool\""))).toBe(true);
  });

  it("rejects a rule with an invalid action", () => {
    writeSettings({ permissions: { rules: [{ tool: "run_bash", pattern: "git status", action: "maybe" }] } });
    const { errors } = loadConfig(dir);
    expect(errors.some((e) => e.includes("invalid action"))).toBe(true);
  });

  it("rejects permissions.rules that isn't an array", () => {
    writeSettings({ permissions: { rules: "not-an-array" } });
    const { errors } = loadConfig(dir);
    expect(errors.some((e) => e.includes("permissions.rules must be an array"))).toBe(true);
  });

  it("accepts a scan-equivalent rule with no whitelist to drift out of sync (the original bug's root cause is gone)", () => {
    writeSettings({ permissions: { rules: [{ tool: "glob", pattern: "", action: "allow" }] } });
    const { config, errors } = loadConfig(dir);
    expect(errors).toEqual([]);
    expect(config.permissions?.rules?.[0]).toMatchObject({ tool: "glob", kind: "any", action: "allow" });
  });
});

describe("migrateLegacyPermissions", () => {
  it("is a no-op (empty result) for an already-new-shape config", () => {
    const result = migrateLegacyPermissions({ rules: [{ tool: "run_bash", pattern: "git status", action: "allow" }] });
    expect(result.rules).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("translates read-in-cwd to a glob allow rule for read_file", () => {
    const result = migrateLegacyPermissions({ allow: ["read-in-cwd"] });
    expect(result.rules).toContainEqual(
      expect.objectContaining({ tool: "read_file", kind: "glob", pattern: "./**", action: "allow" }),
    );
  });

  it("translates scan to glob/search any-kind rules", () => {
    const result = migrateLegacyPermissions({ allow: ["scan"] });
    expect(result.rules).toContainEqual(expect.objectContaining({ tool: "glob", kind: "any", action: "allow" }));
    expect(result.rules).toContainEqual(expect.objectContaining({ tool: "search", kind: "any", action: "allow" }));
  });

  it("translates mcp to an mcp__* wildcard rule", () => {
    const result = migrateLegacyPermissions({ allow: ["mcp"] });
    expect(result.rules).toContainEqual(expect.objectContaining({ tool: "mcp__*", kind: "any", action: "allow" }));
  });

  it("drops the network scope with an explicit warning rather than approximating it", () => {
    const result = migrateLegacyPermissions({ allow: ["network"] });
    expect(result.rules.some((r) => r.tool === "network")).toBe(false);
    expect(result.warnings.some((w) => w.includes("network"))).toBe(true);
  });

  it("preserves the action (deny/ask) from the legacy scope list it came from", () => {
    const result = migrateLegacyPermissions({ deny: ["read-in-cwd"] });
    expect(result.rules).toContainEqual(expect.objectContaining({ tool: "read_file", action: "deny" }));
  });

  it("emits a summary warning naming how many scopes were migrated", () => {
    const result = migrateLegacyPermissions({ allow: ["read-in-cwd", "scan"] });
    expect(result.warnings.some((w) => w.includes("migrated") && w.includes("2"))).toBe(true);
  });

  it("returns empty rules and warnings for an empty legacy config", () => {
    const result = migrateLegacyPermissions({});
    expect(result.rules).toEqual([]);
    expect(result.warnings).toEqual([]);
  });
});

describe("loadConfig: migration integration, no disk write during load", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "heirloom-loader-migration-"));
    mkdirSync(projectDirPath(dir), { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("migrates a legacy-shape settings.json in-memory and surfaces a warning", () => {
    const settingsPath = projectSettingsPath(dir);
    writeFileSync(settingsPath, JSON.stringify({ permissions: { allow: ["read-in-cwd"], defaultMode: "askAll" } }), "utf-8");

    const { config, warnings } = loadConfig(dir);
    expect(config.permissions?.rules).toContainEqual(
      expect.objectContaining({ tool: "read_file", kind: "glob", pattern: "./**", action: "allow" }),
    );
    expect(warnings.some((w) => w.includes("migrated"))).toBe(true);
  });

  it("does not write to disk during loadConfig, even when migration occurs", () => {
    const settingsPath = projectSettingsPath(dir);
    const original = JSON.stringify({ permissions: { allow: ["read-in-cwd"], defaultMode: "askAll" } });
    writeFileSync(settingsPath, original, "utf-8");
    const statBefore = statSync(settingsPath).mtimeMs;

    loadConfig(dir);

    const contentAfter = readFileSync(settingsPath, "utf-8");
    const statAfter = statSync(settingsPath).mtimeMs;
    expect(contentAfter).toBe(original);
    expect(statAfter).toBe(statBefore);
  });

  it("is idempotent: loading an already-migrated (new-shape) file does not re-migrate or warn", () => {
    const settingsPath = projectSettingsPath(dir);
    writeFileSync(
      settingsPath,
      JSON.stringify({ permissions: { rules: [{ tool: "read_file", pattern: "./**", action: "allow" }] } }),
      "utf-8",
    );

    const { config, warnings } = loadConfig(dir);
    expect(config.permissions?.rules).toHaveLength(1);
    expect(warnings.some((w) => w.includes("migrated"))).toBe(false);
  });

  it("no settings.json is created by loadConfig alone", () => {
    // No settings.json written at all — loadConfig must not create one.
    loadConfig(dir);
    expect(existsSync(projectSettingsPath(dir))).toBe(false);
  });
});

// Write a project-level .heirloom/settings.json into a fresh temp dir and load it.
// NIB_HOME is pointed at an empty dir so no global settings interfere.
let projectDir: string;
let homeDir: string;
let prevHome: string | undefined;

function writeProjectSettings(obj: unknown): void {
  const dir = projectDirPath(projectDir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "settings.json"), JSON.stringify(obj), "utf-8");
}

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "loader-proj-"));
  homeDir = mkdtempSync(join(tmpdir(), "loader-home-"));
  prevHome = process.env.NIB_HOME;
  process.env.NIB_HOME = homeDir;
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(homeDir, { recursive: true, force: true });
  if (prevHome === undefined) delete process.env.NIB_HOME;
  else process.env.NIB_HOME = prevHome;
});

describe("loadConfig strictMcpConfig", () => {
  it("accepts strictMcpConfig: true", () => {
    writeProjectSettings({ strictMcpConfig: true });
    const { config, errors, warnings } = loadConfig(projectDir);
    expect(errors).toHaveLength(0);
    expect(warnings).toHaveLength(0);
    expect(config.strictMcpConfig).toBe(true);
  });

  it("accepts strictMcpConfig: false", () => {
    writeProjectSettings({ strictMcpConfig: false });
    const { config, errors } = loadConfig(projectDir);
    expect(errors).toHaveLength(0);
    expect(config.strictMcpConfig).toBe(false);
  });

  it("defaults to undefined when the field is absent (no warning)", () => {
    writeProjectSettings({});
    const { config, errors, warnings } = loadConfig(projectDir);
    expect(errors).toHaveLength(0);
    expect(warnings).toHaveLength(0);
    expect(config.strictMcpConfig).toBeUndefined();
  });

  it("accepts showCost: true", () => {
    writeProjectSettings({ showCost: true });
    const { config, errors } = loadConfig(projectDir);
    expect(errors).toHaveLength(0);
    expect(config.showCost).toBe(true);
  });

  it("showCost defaults to undefined (hidden) when absent", () => {
    writeProjectSettings({});
    const { config, errors } = loadConfig(projectDir);
    expect(errors).toHaveLength(0);
    expect(config.showCost).toBeUndefined();
  });

  it("rejects a non-boolean showCost with a validation error", () => {
    writeProjectSettings({ showCost: "yes" });
    const { config, errors } = loadConfig(projectDir);
    expect(errors.some((e) => e.includes("showCost"))).toBe(true);
  });

  it("rejects a non-boolean strictMcpConfig with a validation error", () => {
    writeProjectSettings({ strictMcpConfig: "yes" });
    const { config, errors } = loadConfig(projectDir);
    expect(errors).toContain("config.strictMcpConfig: must be a boolean");
    expect(config.strictMcpConfig).toBeUndefined();
  });
});

describe("loadConfig statusline", () => {
  it("accepts a well-formed command + module provider config", () => {
    writeProjectSettings({
      statusline: {
        enabled: true,
        refreshMs: 3000,
        separator: " | ",
        providers: [
          { type: "command", id: "git", command: "git branch --show-current", color: "cyan", timeoutMs: 1500, cwd: "." },
          { type: "module", id: "x", path: "./.deepcode/plugins/x.mjs", color: "yellow" },
        ],
      },
    });
    const { config, errors } = loadConfig(projectDir);
    expect(errors).toEqual([]);
    expect(config.statusline).toEqual({
      enabled: true,
      refreshMs: 3000,
      separator: " | ",
      providers: [
        { type: "command", id: "git", command: "git branch --show-current", color: "cyan", timeoutMs: 1500, cwd: "." },
        { type: "module", id: "x", path: "./.deepcode/plugins/x.mjs", color: "yellow" },
      ],
    });
  });

  it("defaults enabled to true when providers exist", () => {
    writeProjectSettings({ statusline: { providers: [{ type: "command", id: "g", command: "echo hi" }] } });
    const { config } = loadConfig(projectDir);
    expect(config.statusline?.enabled).toBe(true);
  });

  it("defaults enabled to false when there are no providers", () => {
    writeProjectSettings({ statusline: { providers: [] } });
    const { config } = loadConfig(projectDir);
    expect(config.statusline?.enabled).toBe(false);
  });

  it("defaults refreshMs to 2000 and separator to ' · '", () => {
    writeProjectSettings({ statusline: { providers: [{ type: "command", id: "g", command: "echo hi" }] } });
    const { config } = loadConfig(projectDir);
    expect(config.statusline?.refreshMs).toBe(2000);
    expect(config.statusline?.separator).toBe(" · ");
  });

  it("clamps refreshMs to a minimum of 500", () => {
    writeProjectSettings({ statusline: { refreshMs: 100, providers: [{ type: "command", id: "g", command: "echo hi" }] } });
    const { config } = loadConfig(projectDir);
    expect(config.statusline?.refreshMs).toBe(500);
  });

  it("rejects a command provider missing command", () => {
    writeProjectSettings({ statusline: { providers: [{ type: "command", id: "g" }] } });
    const { errors } = loadConfig(projectDir);
    expect(errors.some((e) => e.includes("statusline.providers.g.command is required"))).toBe(true);
  });

  it("rejects a module provider missing path", () => {
    writeProjectSettings({ statusline: { providers: [{ type: "module", id: "m" }] } });
    const { errors } = loadConfig(projectDir);
    expect(errors.some((e) => e.includes("statusline.providers.m.path is required"))).toBe(true);
  });

  it("rejects a provider with an unknown type", () => {
    writeProjectSettings({ statusline: { providers: [{ type: "widget", id: "w" }] } });
    const { errors } = loadConfig(projectDir);
    expect(errors.some((e) => e.includes('statusline.providers.w.type must be "command" or "module"'))).toBe(true);
  });

  it("rejects a provider missing id", () => {
    writeProjectSettings({ statusline: { providers: [{ type: "command", command: "x" }] } });
    const { errors } = loadConfig(projectDir);
    expect(errors.some((e) => e.includes('statusline.providers entry missing string "id"'))).toBe(true);
  });

  it("rejects providers that isn't an array", () => {
    writeProjectSettings({ statusline: { providers: "nope" } });
    const { errors } = loadConfig(projectDir);
    expect(errors.some((e) => e.includes("statusline.providers must be an array"))).toBe(true);
  });

  it("rejects statusline that isn't an object", () => {
    writeProjectSettings({ statusline: "on" });
    const { errors } = loadConfig(projectDir);
    expect(errors.some((e) => e.includes("statusline must be an object"))).toBe(true);
  });

  it("does not warn about statusline being an unknown field", () => {
    writeProjectSettings({ statusline: { providers: [{ type: "command", id: "g", command: "echo hi" }] } });
    const { warnings } = loadConfig(projectDir);
    expect(warnings.some((w) => w.includes('unknown field "statusline"'))).toBe(false);
  });
});

describe("loadConfig enabledSkills", () => {
  it("parses a per-skill enable/disable map", () => {
    writeProjectSettings({ enabledSkills: { foo: false, bar: true } });
    const { config, errors, warnings } = loadConfig(projectDir);
    expect(errors).toHaveLength(0);
    expect(warnings).toHaveLength(0);
    expect(config.enabledSkills).toEqual({ foo: false, bar: true });
  });

  it("rejects a non-boolean skill value", () => {
    writeProjectSettings({ enabledSkills: { foo: "off" } });
    const { errors } = loadConfig(projectDir);
    expect(errors).toContain("config.enabledSkills.foo: must be boolean");
  });

  it("rejects a non-object enabledSkills", () => {
    writeProjectSettings({ enabledSkills: "nope" });
    const { errors } = loadConfig(projectDir);
    expect(errors).toContain("config.enabledSkills: must be an object");
  });
});

describe("loadConfig favoriteModels", () => {
  it("parses a list of provider/model ids", () => {
    writeProjectSettings({ favoriteModels: ["deepseek/deepseek-v4-pro", "groq/llama"] });
    const { config, errors, warnings } = loadConfig(projectDir);
    expect(errors).toHaveLength(0);
    expect(warnings).toHaveLength(0);
    expect(config.favoriteModels).toEqual(["deepseek/deepseek-v4-pro", "groq/llama"]);
  });

  it("rejects a non-array favoriteModels", () => {
    writeProjectSettings({ favoriteModels: "nope" });
    const { errors } = loadConfig(projectDir);
    expect(errors).toContain("config.favoriteModels: must be an array of strings");
  });

  it("rejects a favoriteModels array containing non-string entries", () => {
    writeProjectSettings({ favoriteModels: ["deepseek/deepseek-v4-pro", 5] });
    const { errors } = loadConfig(projectDir);
    expect(errors).toContain("config.favoriteModels: all entries must be strings");
  });
});

describe("loadConfig recentModels", () => {
  it("parses a list of { id, at } entries", () => {
    writeProjectSettings({ recentModels: [{ id: "deepseek/deepseek-v4-pro", at: 12345 }] });
    const { config, errors, warnings } = loadConfig(projectDir);
    expect(errors).toHaveLength(0);
    expect(warnings).toHaveLength(0);
    expect(config.recentModels).toEqual([{ id: "deepseek/deepseek-v4-pro", at: 12345 }]);
  });

  it("rejects a non-array recentModels", () => {
    writeProjectSettings({ recentModels: "nope" });
    const { errors } = loadConfig(projectDir);
    expect(errors).toContain("config.recentModels: must be an array");
  });

  it("rejects entries missing id or at", () => {
    writeProjectSettings({ recentModels: [{ id: "deepseek/deepseek-v4-pro" }] });
    const { errors } = loadConfig(projectDir);
    expect(errors.some((e) => e.includes("config.recentModels"))).toBe(true);
  });
});

describe("loadConfig compaction.auto", () => {
  it("parses compaction.auto: false alongside threshold", () => {
    writeProjectSettings({ compaction: { auto: false, threshold: 0.6 } });
    const { config, errors, warnings } = loadConfig(projectDir);
    expect(errors).toHaveLength(0);
    expect(warnings).toHaveLength(0);
    expect(config.compaction).toEqual({ auto: false, threshold: 0.6 });
  });

  it("parses compaction.auto: true", () => {
    writeProjectSettings({ compaction: { auto: true } });
    const { config } = loadConfig(projectDir);
    expect(config.compaction?.auto).toBe(true);
  });
});

describe("loadConfig workflow keys", () => {
  it("keeps gitStatus / gitPollInterval without warnings", () => {
    writeProjectSettings({ workflow: { gitStatus: false, gitPollInterval: 5000 } });
    const { config, errors, warnings } = loadConfig(projectDir);
    expect(errors).toHaveLength(0);
    expect(warnings).toHaveLength(0);
    expect(config.workflow).toEqual({ gitStatus: false, gitPollInterval: 5000 });
  });

  it("deprecates gitCommands with a warning", () => {
    writeProjectSettings({ workflow: { gitCommands: true } });
    const { warnings } = loadConfig(projectDir);
    expect(warnings.some((w) => w.includes("workflow.gitCommands is deprecated"))).toBe(true);
  });

  it("deprecates detectBuildTools with a warning", () => {
    writeProjectSettings({ workflow: { detectBuildTools: true } });
    const { warnings } = loadConfig(projectDir);
    expect(warnings.some((w) => w.includes("workflow.detectBuildTools is deprecated"))).toBe(true);
  });
});

describe("loadConfig commands.timeoutToBackground", () => {
  it("parses an explicit false (opts out of timeout→background migration)", () => {
    writeProjectSettings({ commands: { timeoutToBackground: false } });
    const { config, errors, warnings } = loadConfig(projectDir);
    expect(errors).toHaveLength(0);
    expect(warnings).toHaveLength(0);
    expect(config.commands?.timeoutToBackground).toBe(false);
  });

  it("parses an explicit true", () => {
    writeProjectSettings({ commands: { timeoutToBackground: true } });
    const { config, errors } = loadConfig(projectDir);
    expect(errors).toHaveLength(0);
    expect(config.commands?.timeoutToBackground).toBe(true);
  });

  it("leaves the key undefined when absent (the consumer applies default ON)", () => {
    writeProjectSettings({});
    const { config, warnings } = loadConfig(projectDir);
    expect(config.commands).toBeUndefined();
    expect(warnings.some((w) => w.includes('unknown field "commands"'))).toBe(false);
  });

  it("rejects a non-boolean timeoutToBackground", () => {
    writeProjectSettings({ commands: { timeoutToBackground: "yes" } });
    const { errors } = loadConfig(projectDir);
    expect(errors.some((e) => e.includes("config.commands.timeoutToBackground: must be a boolean"))).toBe(true);
  });

  it("rejects a non-object commands block", () => {
    writeProjectSettings({ commands: "yes" });
    const { errors } = loadConfig(projectDir);
    expect(errors.some((e) => e.includes("config.commands: must be an object"))).toBe(true);
  });
});

describe("loadConfig debugLogEnabled (deprecated)", () => {
  it("emits a deprecation warning pointing at the --debug flag", () => {
    writeProjectSettings({ debugLogEnabled: true });
    const { warnings } = loadConfig(projectDir);
    expect(
      warnings.some((w) => w.includes("debugLogEnabled is deprecated and ignored — use the --debug flag")),
    ).toBe(true);
  });
});

describe("loadConfig telemetryEnabled (deleted key)", () => {
  it("treats telemetryEnabled as an unknown field", () => {
    writeProjectSettings({ telemetryEnabled: false });
    const { config, warnings } = loadConfig(projectDir);
    expect(warnings.some((w) => w.includes('unknown field "telemetryEnabled"'))).toBe(true);
    expect((config as Record<string, unknown>).telemetryEnabled).toBeUndefined();
  });
});

describe("resolveHome", () => {
  it("honors NIB_HOME", () => {
    expect(resolveHome()).toBe(homeDir);
  });

  it("falls back to the user home when unset", () => {
    const prev = process.env.NIB_HOME;
    delete process.env.NIB_HOME;
    try {
      expect(resolveHome()).toBe(join(homedir(), ".nib"));
    } finally {
      if (prev !== undefined) process.env.NIB_HOME = prev;
    }
  });
});

describe("loadConfig permissionProfile", () => {
  function writeGlobalSettings(obj: unknown): void {
    writeFileSync(join(homeDir, "settings.json"), JSON.stringify(obj), "utf-8");
  }

  it("parses a valid profile with level, fs, and network", () => {
    writeProjectSettings({
      permissionProfile: {
        level: "workspace-write",
        fs: [
          { path: "**/*.env", action: "deny" },
          { path: "~/notes/**", action: "read" },
        ],
        network: { allow: ["api.deepseek.com"], deny: ["*"] },
      },
    });
    const { config, errors, warnings } = loadConfig(projectDir);
    expect(errors).toEqual([]);
    expect(warnings.some((w) => w.includes('unknown field "permissionProfile"'))).toBe(false);
    expect(config.permissionProfile).toEqual({
      level: "workspace-write",
      fs: [
        { path: "**/*.env", action: "deny" },
        { path: "~/notes/**", action: "read" },
      ],
      network: { allow: ["api.deepseek.com"], deny: ["*"] },
    });
  });

  it("rejects an unknown level, naming the file and field", () => {
    writeProjectSettings({ permissionProfile: { level: "sandbox" } });
    const { errors } = loadConfig(projectDir);
    expect(errors.some((e) => e.startsWith("project config") && e.includes("permissionProfile.level must be one of"))).toBe(true);
  });

  it("requires a level when the key is present", () => {
    writeProjectSettings({ permissionProfile: { fs: [{ path: ".env", action: "deny" }] } });
    const { errors } = loadConfig(projectDir);
    expect(errors.some((e) => e.includes("permissionProfile.level must be one of"))).toBe(true);
  });

  it("rejects a write rule under strict-sandbox (narrowing-only violation)", () => {
    writeProjectSettings({
      permissionProfile: { level: "strict-sandbox", fs: [{ path: "src/**", action: "write" }] },
    });
    const { errors } = loadConfig(projectDir);
    expect(errors.some((e) => e.includes('action "write" not allowed at level "strict-sandbox"'))).toBe(true);
  });

  it("rejects a write rule outside workspace roots under workspace-write", () => {
    writeProjectSettings({
      permissionProfile: { level: "workspace-write", fs: [{ path: "~/notes/**", action: "write" }] },
    });
    const { errors } = loadConfig(projectDir);
    expect(errors.some((e) => e.includes('must be a workspace-relative path at level "workspace-write"'))).toBe(true);
  });

  it("accepts a write rule inside workspace roots under workspace-write", () => {
    writeProjectSettings({
      permissionProfile: { level: "workspace-write", fs: [{ path: "src/**", action: "write" }] },
    });
    const { errors } = loadConfig(projectDir);
    expect(errors).toEqual([]);
  });

  it("rejects an invalid glob naming the fs entry", () => {
    writeProjectSettings({
      permissionProfile: { level: "workspace-write", fs: [{ path: "foo[bar", action: "deny" }] },
    });
    const { errors } = loadConfig(projectDir);
    expect(errors.some((e) => e.includes('permissionProfile.fs entry "foo[bar" has invalid glob'))).toBe(true);
  });

  it("rejects an fs entry with an empty or missing path", () => {
    writeProjectSettings({ permissionProfile: { level: "workspace-write", fs: [{ path: "", action: "deny" }] } });
    const { errors } = loadConfig(projectDir);
    expect(errors.some((e) => e.includes('permissionProfile.fs entry missing string "path"'))).toBe(true);
  });

  it("rejects an fs entry with an invalid action", () => {
    writeProjectSettings({ permissionProfile: { level: "workspace-write", fs: [{ path: "a", action: "chmod" }] } });
    const { errors } = loadConfig(projectDir);
    expect(errors.some((e) => e.includes('has invalid action "chmod"'))).toBe(true);
  });

  it("rejects network entries that aren't strings", () => {
    writeProjectSettings({ permissionProfile: { level: "workspace-write", network: { allow: ["ok", 5] } } });
    const { errors } = loadConfig(projectDir);
    expect(errors.some((e) => e.includes("permissionProfile.network.allow must be an array of strings"))).toBe(true);
  });

  it("rejects a network entry with a wildcard other than \"*\"", () => {
    writeProjectSettings({ permissionProfile: { level: "workspace-write", network: { deny: ["*.example.com"] } } });
    const { errors } = loadConfig(projectDir);
    expect(errors.some((e) => e.includes('entry "*.example.com" is not a valid hostname'))).toBe(true);
  });

  it("rejects a non-object permissionProfile", () => {
    writeProjectSettings({ permissionProfile: "on" });
    const { errors } = loadConfig(projectDir);
    expect(errors.some((e) => e.includes("permissionProfile must be an object"))).toBe(true);
  });

  it("leaves the key undefined when absent from both files", () => {
    const { config, errors, warnings } = loadConfig(projectDir);
    expect(errors).toEqual([]);
    expect(config.permissionProfile).toBeUndefined();
    expect(warnings.some((w) => w.includes("permissionProfile"))).toBe(false);
  });

  describe("project > global merge (append / override by path and domain)", () => {
    it("merges fs by exact path and unions network lists; project level wins", () => {
      writeGlobalSettings({
        permissionProfile: {
          level: "workspace-write",
          fs: [
            { path: "**/*.env", action: "deny" },
            { path: "src/secret.ts", action: "deny" },
          ],
          network: { allow: ["api.deepseek.com", "registry.npmjs.org"], deny: ["example.com"] },
        },
      });
      writeProjectSettings({
        permissionProfile: {
          level: "strict-sandbox",
          fs: [
            { path: "src/secret.ts", action: "read" }, // replaces the global rule by path
            { path: "docs/**", action: "deny" }, // appended
          ],
          network: { allow: ["registry.npmjs.org"], deny: ["evil.com"] }, // unions, deduped
        },
      });
      const { config, errors } = loadConfig(projectDir);
      expect(errors).toEqual([]);
      expect(config.permissionProfile?.level).toBe("strict-sandbox");
      expect(config.permissionProfile?.fs).toEqual([
        { path: "**/*.env", action: "deny" },
        { path: "src/secret.ts", action: "read" }, // replaced in place, order preserved
        { path: "docs/**", action: "deny" },
      ]);
      expect(config.permissionProfile?.network).toEqual({
        allow: ["api.deepseek.com", "registry.npmjs.org"],
        deny: ["example.com", "evil.com"],
      });
    });

    it("names the file a bad global profile came from", () => {
      writeGlobalSettings({ permissionProfile: { level: "bogus" } });
      const { errors } = loadConfig(projectDir);
      expect(errors.some((e) => e.startsWith("global config") && e.includes("permissionProfile.level"))).toBe(true);
    });
  });
});

describe("loadConfig sandbox (permission-profile.md §8, phase (e))", () => {
  it("defaults off — key absent leaves sandbox undefined with no unknown-field warning", () => {
    const { config, errors, warnings } = loadConfig(projectDir);
    expect(errors).toEqual([]);
    expect(config.sandbox).toBeUndefined();
    expect(warnings.some((w) => w.includes('unknown field "sandbox"'))).toBe(false);
  });

  it("parses sandbox.enabled: true", () => {
    writeProjectSettings({ sandbox: { enabled: true } });
    const { config, errors, warnings } = loadConfig(projectDir);
    expect(errors).toEqual([]);
    expect(config.sandbox).toEqual({ enabled: true });
    // On macOS the flag is honored silently; on other platforms the loader
    // warns (policy-only). The parse itself is platform-independent.
    if (process.platform !== "darwin") {
      expect(warnings).toContain("sandbox is macOS-only; running policy-only");
    }
  });

  it("parses sandbox.enabled: false", () => {
    writeProjectSettings({ sandbox: { enabled: false } });
    const { config, errors } = loadConfig(projectDir);
    expect(errors).toEqual([]);
    expect(config.sandbox).toEqual({ enabled: false });
  });

  it("rejects a non-boolean enabled", () => {
    writeProjectSettings({ sandbox: { enabled: "yes" } });
    const { config, errors } = loadConfig(projectDir);
    expect(errors).toContain("config.sandbox.enabled: must be a boolean");
    expect(config.sandbox).toBeUndefined();
  });

  it("rejects a non-object sandbox", () => {
    writeProjectSettings({ sandbox: true });
    const { errors } = loadConfig(projectDir);
    expect(errors).toContain("config.sandbox: must be an object");
  });

  it("sandboxSupportedOnPlatform: macOS only", () => {
    expect(sandboxSupportedOnPlatform("darwin")).toBe(true);
    expect(sandboxSupportedOnPlatform("linux")).toBe(false);
    expect(sandboxSupportedOnPlatform("win32")).toBe(false);
  });
});

describe("loadConfig sandbox.writeRoots (global-only)", () => {
  function writeGlobalSettings(obj: unknown): void {
    writeFileSync(join(homeDir, "settings.json"), JSON.stringify(obj), "utf-8");
  }

  it("honors writeRoots from the global settings file", () => {
    writeGlobalSettings({ sandbox: { enabled: true, writeRoots: ["~/SecondBrain/AgentMemory"] } });
    const { config, errors, warnings } = loadConfig(projectDir);
    expect(errors).toEqual([]);
    expect(warnings.some((w) => w.includes("global-only"))).toBe(false);
    expect(config.sandbox?.writeRoots).toEqual(["~/SecondBrain/AgentMemory"]);
  });

  it("ignores writeRoots in a PROJECT file, with a warning (the load-bearing security property)", () => {
    writeProjectSettings({ sandbox: { enabled: true, writeRoots: ["/tmp/hostile"] } });
    const { config, errors, warnings } = loadConfig(projectDir);
    expect(errors).toEqual([]);
    expect(config.sandbox?.writeRoots).toBeUndefined();
    expect(warnings.some((w) => w.includes("sandbox.writeRoots is global-only"))).toBe(true);
  });

  it("a project writeRoots never overrides or merges with the global one", () => {
    writeGlobalSettings({ sandbox: { enabled: true, writeRoots: ["/global/root"] } });
    writeProjectSettings({ sandbox: { enabled: true, writeRoots: ["/project/root"] } });
    const { config, warnings } = loadConfig(projectDir);
    expect(config.sandbox?.writeRoots).toEqual(["/global/root"]);
    expect(warnings.some((w) => w.includes("sandbox.writeRoots is global-only"))).toBe(true);
  });

  it("rejects a non-array writeRoots with a validation error", () => {
    writeGlobalSettings({ sandbox: { enabled: true, writeRoots: "not-an-array" } });
    const { errors } = loadConfig(projectDir);
    expect(errors.some((e) => e.includes("config.sandbox.writeRoots: must be an array of strings"))).toBe(true);
  });

  it("rejects a writeRoots array containing non-string entries", () => {
    writeGlobalSettings({ sandbox: { enabled: true, writeRoots: ["/ok", 5] } });
    const { errors } = loadConfig(projectDir);
    expect(errors.some((e) => e.includes("config.sandbox.writeRoots: must be an array of strings"))).toBe(true);
  });

  it("leaves writeRoots undefined when absent from both files", () => {
    writeProjectSettings({ sandbox: { enabled: true } });
    const { config, errors, warnings } = loadConfig(projectDir);
    expect(errors).toEqual([]);
    expect(config.sandbox?.writeRoots).toBeUndefined();
    expect(warnings.some((w) => w.includes("global-only"))).toBe(false);
  });
});

describe("loadConfig webSearch.searxngUrl", () => {
  it("is undefined when absent (no warning, Bing-only default)", () => {
    writeProjectSettings({});
    const { config, warnings } = loadConfig(projectDir);
    expect(warnings).toHaveLength(0);
    expect(config.webSearch?.searxngUrl).toBeUndefined();
  });

  it("accepts an https:// URL for a non-local host", () => {
    writeProjectSettings({ webSearch: { searxngUrl: "https://searx.example.com" } });
    const { config, warnings, errors } = loadConfig(projectDir);
    expect(errors).toHaveLength(0);
    expect(warnings).toHaveLength(0);
    expect(config.webSearch?.searxngUrl).toBe("https://searx.example.com");
  });

  it("accepts http:// for localhost", () => {
    writeProjectSettings({ webSearch: { searxngUrl: "http://localhost:8888" } });
    const { config, warnings } = loadConfig(projectDir);
    expect(warnings).toHaveLength(0);
    expect(config.webSearch?.searxngUrl).toBe("http://localhost:8888");
  });

  it("accepts http:// for 127.0.0.1", () => {
    writeProjectSettings({ webSearch: { searxngUrl: "http://127.0.0.1:8888" } });
    const { config, warnings } = loadConfig(projectDir);
    expect(warnings).toHaveLength(0);
    expect(config.webSearch?.searxngUrl).toBe("http://127.0.0.1:8888");
  });

  it("accepts http:// for [::1]", () => {
    writeProjectSettings({ webSearch: { searxngUrl: "http://[::1]:8888" } });
    const { config, warnings } = loadConfig(projectDir);
    expect(warnings).toHaveLength(0);
    expect(config.webSearch?.searxngUrl).toBe("http://[::1]:8888");
  });

  it("warns and ignores http:// for a non-local host", () => {
    writeProjectSettings({ webSearch: { searxngUrl: "http://searx.example.com" } });
    const { config, warnings, errors } = loadConfig(projectDir);
    expect(errors).toHaveLength(0);
    expect(warnings.some((w) => w.includes("only https:// is allowed"))).toBe(true);
    expect(config.webSearch?.searxngUrl).toBeUndefined();
  });

  it("warns and ignores a malformed URL", () => {
    writeProjectSettings({ webSearch: { searxngUrl: "not a url" } });
    const { config, warnings } = loadConfig(projectDir);
    expect(warnings.some((w) => w.includes("is not a valid URL"))).toBe(true);
    expect(config.webSearch?.searxngUrl).toBeUndefined();
  });

  it("warns and ignores a non-string searxngUrl", () => {
    writeProjectSettings({ webSearch: { searxngUrl: 123 } });
    const { config, warnings } = loadConfig(projectDir);
    expect(warnings.some((w) => w.includes("webSearch.searxngUrl must be a string"))).toBe(true);
    expect(config.webSearch?.searxngUrl).toBeUndefined();
  });

  it("warns and ignores a non-object webSearch", () => {
    writeProjectSettings({ webSearch: "nope" });
    const { config, warnings } = loadConfig(projectDir);
    expect(warnings.some((w) => w.includes("webSearch must be an object"))).toBe(true);
    expect(config.webSearch).toBeUndefined();
  });

  it("rejects a non-http(s) scheme", () => {
    writeProjectSettings({ webSearch: { searxngUrl: "ftp://searx.example.com" } });
    const { config, warnings } = loadConfig(projectDir);
    expect(warnings.some((w) => w.includes("must be http:// or https://"))).toBe(true);
    expect(config.webSearch?.searxngUrl).toBeUndefined();
  });

  it("does not warn about webSearch as an unknown field", () => {
    writeProjectSettings({ webSearch: { searxngUrl: "https://searx.example.com" } });
    const { warnings } = loadConfig(projectDir);
    expect(warnings.some((w) => w.includes('unknown field "webSearch"'))).toBe(false);
  });

  it("rejects a URL with embedded credentials", () => {
    writeProjectSettings({ webSearch: { searxngUrl: "https://user:pass@searx.example.com" } });
    const { config, warnings } = loadConfig(projectDir);
    expect(warnings.some((w) => w.includes("must not embed credentials"))).toBe(true);
    expect(config.webSearch?.searxngUrl).toBeUndefined();
  });

  it("stores the parsed URL with the trailing slash stripped", () => {
    writeProjectSettings({ webSearch: { searxngUrl: "https://searx.example.com/" } });
    const { config, warnings } = loadConfig(projectDir);
    expect(warnings).toHaveLength(0);
    expect(config.webSearch?.searxngUrl).toBe("https://searx.example.com");
  });

  it("parses webSearch.enrich: false (the key that disables inline enrichment)", () => {
    writeProjectSettings({ webSearch: { enrich: false } });
    const { config, warnings, errors } = loadConfig(projectDir);
    expect(errors).toHaveLength(0);
    expect(warnings).toHaveLength(0);
    expect(config.webSearch?.enrich).toBe(false);
  });

  it("accepts webSearch.enrich: true", () => {
    writeProjectSettings({ webSearch: { enrich: true } });
    const { config, warnings } = loadConfig(projectDir);
    expect(warnings).toHaveLength(0);
    expect(config.webSearch?.enrich).toBe(true);
  });

  it("parses enrich alongside searxngUrl", () => {
    writeProjectSettings({ webSearch: { searxngUrl: "https://searx.example.com", enrich: false } });
    const { config, warnings } = loadConfig(projectDir);
    expect(warnings).toHaveLength(0);
    expect(config.webSearch).toEqual({ searxngUrl: "https://searx.example.com", enrich: false });
  });

  it("warns and ignores a non-boolean webSearch.enrich", () => {
    writeProjectSettings({ webSearch: { enrich: "yes" } });
    const { config, warnings } = loadConfig(projectDir);
    expect(warnings.some((w) => w.includes("webSearch.enrich must be a boolean"))).toBe(true);
    expect(config.webSearch?.enrich).toBeUndefined();
  });
});
