import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { projectDirPath, projectSettingsPath } from "./paths.js";
import { tmpdir } from "node:os";
import { loadConfig } from "./loader.js";

// The global ~/.heirloom/settings.json is developer-specific and can carry
// keys this branch's loader doesn't know (e.g. SearXNG's webSearch) — point
// HEIRLOOM_HOME at an empty dir so no global settings interfere with the
// warning assertions. Mirrors loader.test.ts.
let homeDir: string;
let prevHome: string | undefined;

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), "heirloom-loader-refresh-home-"));
  prevHome = process.env.HEIRLOOM_HOME;
  process.env.HEIRLOOM_HOME = homeDir;
});

afterEach(() => {
  rmSync(homeDir, { recursive: true, force: true });
  if (prevHome === undefined) delete process.env.HEIRLOOM_HOME;
  else process.env.HEIRLOOM_HOME = prevHome;
});

describe("config.refresh validation", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "heirloom-loader-refresh-"));
    mkdirSync(projectDirPath(dir), { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeSettings(json: unknown) {
    writeFileSync(projectSettingsPath(dir), JSON.stringify(json), "utf-8");
  }

  it("warns (not errors) on an invalid value and leaves config.refresh unset", () => {
    writeSettings({ refresh: "turbo" });
    const { config, warnings, errors } = loadConfig(dir);
    expect(errors).toEqual([]);
    expect(warnings.filter((w) => w.includes("config.refresh"))).toHaveLength(1);
    expect(warnings.some((w) => w.includes("config.refresh") && w.includes("turbo"))).toBe(true);
    expect(config.refresh).toBeUndefined();
  });

  it("accepts a valid value with no warnings", () => {
    writeSettings({ refresh: "slow" });
    const { config, warnings } = loadConfig(dir);
    expect(config.refresh).toBe("slow");
    expect(warnings).toEqual([]);
  });

  it("does not warn about refresh as an unknown field", () => {
    writeSettings({ refresh: "turbo" });
    const { warnings } = loadConfig(dir);
    expect(warnings.some((w) => w.includes('unknown field "refresh"'))).toBe(false);
  });
});
