import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../config/loader.js";
import { resolveTheme, BUILTIN_THEMES } from "./theme.js";
import { splitThemeSelection } from "./contexts.js";
import { persistThemeChoice } from "./components/ThemeDropdown/index.js";

/**
 * End-to-end proof: the value the /theme picker persists (theme.mode = "<name>")
 * round-trips through the config loader and reaches resolveTheme as a named
 * preset — so a config-selected preset actually renders.
 */
describe("named preset config → resolveTheme round-trip", () => {
  const prevHome = process.env.NIB_HOME;
  let home: string;
  let projectDir: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "nib-theme-home-"));
    projectDir = mkdtempSync(join(tmpdir(), "nib-theme-proj-"));
    process.env.NIB_HOME = home;
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.NIB_HOME;
    else process.env.NIB_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  });

  it("persisted preset is parsed into {mode:'dark', name:'dracula'}", () => {
    persistThemeChoice("dracula", home);
    const { config, errors } = loadConfig(projectDir);
    expect(errors).toEqual([]);
    // loader maps a non-mode word into `name`, defaulting mode to dark.
    expect(config.theme?.mode).toBe("dark");
    expect(config.theme?.name).toBe("dracula");
  });

  it("resolveTheme honors the loaded preset (name wins over mode)", () => {
    persistThemeChoice("dracula", home);
    const { config } = loadConfig(projectDir);
    const resolved = resolveTheme({
      mode: config.theme?.mode ?? "dark",
      name: config.theme?.name,
      overrides: config.theme?.overrides,
    });
    expect(resolved).toBe(BUILTIN_THEMES.dracula);
  });

  it("splitThemeSelection routes a preset selection into `name`", () => {
    expect(splitThemeSelection("dracula")).toEqual({ mode: "dark", name: "dracula" });
    expect(splitThemeSelection("auto")).toEqual({ mode: "auto" });
    expect(splitThemeSelection("light")).toEqual({ mode: "light" });
  });

  it("a persisted mode word (auto/light/dark) resolves via mode, not name", () => {
    persistThemeChoice("light", home);
    const { config } = loadConfig(projectDir);
    expect(config.theme?.mode).toBe("light");
    expect(config.theme?.name).toBeUndefined();
    const { mode, name } = splitThemeSelection("light");
    expect(resolveTheme({ mode, name })).toBe(BUILTIN_THEMES.light);
  });
});
