import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { projectDirPath, projectSettingsPath } from "../config/paths.js";
import { tmpdir } from "node:os";
import { parseHooksConfig } from "./config.js";
import { loadConfig } from "../config/loader.js";

// Config parsing (hooks-spec.md §1): project > global per-event merge with
// per-entry origin, matcher rules, and fail-fast config errors.

const TEST_DIR = join(tmpdir(), `heirloom-hooks-config-${process.pid}`);
const HOME_DIR = join(TEST_DIR, "home");
const PROJECT_DIR = join(TEST_DIR, "project");

function parse(hooks: Record<string, unknown>, errors: string[] = []) {
  return parseHooksConfig(undefined, hooks, "config", errors);
}

beforeEach(() => {
  mkdirSync(PROJECT_DIR, { recursive: true });
  mkdirSync(HOME_DIR, { recursive: true });
  process.env.NIB_HOME = HOME_DIR;
});

afterEach(() => {
  delete process.env.NIB_HOME;
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("parseHooksConfig", () => {
  it("returns undefined when neither source defines hooks", () => {
    expect(parseHooksConfig(undefined, undefined, "config", [])).toBeUndefined();
  });

  it("marks entries with their origin", () => {
    const global = parseHooksConfig({ PreToolUse: [{ command: "g.sh" }] }, undefined, "config", []);
    expect(global!.entries[0].origin).toBe("global");

    const project = parseHooksConfig(undefined, { PreToolUse: [{ command: "p.sh" }] }, "config", []);
    expect(project!.entries[0].origin).toBe("project");
  });

  it("merges project over global per event; untouched events keep global entries", () => {
    const errors: string[] = [];
    const config = parseHooksConfig(
      {
        PreToolUse: [{ command: "global-pre.sh" }],
        Notification: [{ command: "global-notify.sh" }],
      },
      {
        PreToolUse: [{ command: "project-pre.sh" }],
      },
      "config",
      errors,
    );

    expect(errors).toEqual([]);
    expect(config!.byEvent.PreToolUse.map((e) => e.command)).toEqual(["project-pre.sh"]);
    expect(config!.byEvent.PreToolUse[0].origin).toBe("project");
    expect(config!.byEvent.Notification.map((e) => e.command)).toEqual(["global-notify.sh"]);
    expect(config!.byEvent.Notification[0].origin).toBe("global");
  });

  it("accepts omitted or '*' matchers as match-all", () => {
    const config = parse({
      PreToolUse: [{ command: "a.sh" }, { matcher: "*", command: "b.sh" }],
    });
    for (const entry of config!.byEvent.PreToolUse) {
      expect(entry.matches).toBeUndefined();
    }
  });

  it("compiles an exact-name list matcher (^[A-Za-z0-9_|,]+$)", () => {
    const config = parse({
      PreToolUse: [{ matcher: "run_bash|edit", command: "guard.sh" }],
    });
    const matches = config!.byEvent.PreToolUse[0].matches!;
    expect(matches("run_bash")).toBe(true);
    expect(matches("edit")).toBe(true);
    expect(matches("read_file")).toBe(false);
  });

  it("compiles anything else as an unanchored regex", () => {
    const config = parse({
      PreToolUse: [{ matcher: "^run", command: "guard.sh" }],
    });
    const matches = config!.byEvent.PreToolUse[0].matches!;
    expect(matches("run_bash")).toBe(true);
    expect(matches("my_run_bash")).toBe(false);
  });

  it("fails fast on an invalid matcher regex, naming the entry", () => {
    const errors: string[] = [];
    parse({ PreToolUse: [{ matcher: "(unclosed", command: "guard.sh" }] }, errors);

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("guard.sh");
    expect(errors[0]).toContain("(unclosed");
  });

  it("ignores matchers on non-tool events", () => {
    const errors: string[] = [];
    const config = parse({ Notification: [{ matcher: "nonsense(", command: "n.sh" }] }, errors);
    expect(errors).toEqual([]);
    expect(config!.byEvent.Notification[0].matches).toBeUndefined();
  });

  it("errors on an unknown event key", () => {
    const errors: string[] = [];
    parse({ PreToolUseX: [{ command: "x.sh" }] }, errors);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("PreToolUseX");
  });

  it("errors on a non-object entry and a missing command", () => {
    const errors: string[] = [];
    parse(
      {
        PreToolUse: ["not-an-object", { matcher: "*" }],
      },
      errors,
    );
    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain("non-object");
    expect(errors[1]).toContain("missing string \"command\"");
  });

  it("errors when hooks is not an object or an event list is not an array", () => {
    const errors: string[] = [];
    parseHooksConfig(undefined, "nope", "config", errors);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("hooks must be an object");

    const errors2: string[] = [];
    parseHooksConfig(undefined, { PreToolUse: "nope" }, "config", errors2);
    expect(errors2).toHaveLength(1);
    expect(errors2[0]).toContain("hooks.PreToolUse must be an array");
  });
});

describe("loadConfig integration", () => {
  it("parses hooks from both sources and the disableAllHooks master switch", () => {
    mkdirSync(join(HOME_DIR), { recursive: true });
    writeFileSync(
      join(HOME_DIR, "settings.json"),
      JSON.stringify({ hooks: { Notification: [{ command: "global-notify.sh" }] } }),
      "utf-8",
    );
    mkdirSync(projectDirPath(PROJECT_DIR), { recursive: true });
    writeFileSync(
      projectSettingsPath(PROJECT_DIR),
      JSON.stringify({
        hooks: { PreToolUse: [{ matcher: "run_bash", command: "guard.sh" }] },
        disableAllHooks: true,
      }),
      "utf-8",
    );

    const { config, warnings, errors } = loadConfig(PROJECT_DIR);

    expect(errors).toEqual([]);
    expect(config.disableAllHooks).toBe(true);
    expect(config.hooks!.byEvent.PreToolUse[0]).toMatchObject({ command: "guard.sh", origin: "project" });
    expect(config.hooks!.byEvent.Notification[0]).toMatchObject({ command: "global-notify.sh", origin: "global" });
    // Known keys — no unknown-field warnings.
    expect(warnings.some((w) => w.includes("hooks"))).toBe(false);
    expect(warnings.some((w) => w.includes("disableAllHooks"))).toBe(false);
  });

  it("fails config fast on an invalid matcher regex", () => {
    mkdirSync(projectDirPath(PROJECT_DIR), { recursive: true });
    writeFileSync(
      projectSettingsPath(PROJECT_DIR),
      JSON.stringify({ hooks: { PreToolUse: [{ matcher: "(bad", command: "guard.sh" }] } }),
      "utf-8",
    );

    const { errors } = loadConfig(PROJECT_DIR);

    expect(errors.some((e) => e.includes("guard.sh"))).toBe(true);
  });

  it("errors when disableAllHooks is not a boolean", () => {
    mkdirSync(projectDirPath(PROJECT_DIR), { recursive: true });
    writeFileSync(
      projectSettingsPath(PROJECT_DIR),
      JSON.stringify({ disableAllHooks: "yes" }),
      "utf-8",
    );

    const { errors } = loadConfig(PROJECT_DIR);

    expect(errors).toEqual(["config.disableAllHooks: must be a boolean"]);
  });
});
