import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  themeChoices,
  persistThemeChoice,
  resolveThemeOutcome,
  AUTO_THEME,
} from "./index.js";
import { BUILTIN_THEMES } from "../../theme.js";

describe("themeChoices", () => {
  it("lists every builtin theme dynamically plus an auto entry", () => {
    const choices = themeChoices();
    // Every builtin key must appear — never hardcode preset names, so a new
    // preset added to BUILTIN_THEMES flows through automatically.
    for (const key of Object.keys(BUILTIN_THEMES)) {
      expect(choices).toContain(key);
    }
    expect(choices).toContain(AUTO_THEME);
    // auto is last; builtins precede it.
    expect(choices[choices.length - 1]).toBe(AUTO_THEME);
    expect(choices).toHaveLength(Object.keys(BUILTIN_THEMES).length + 1);
  });
});

describe("resolveThemeOutcome (revert-on-escape logic)", () => {
  it("confirm keeps the previewed theme", () => {
    expect(resolveThemeOutcome("dark", "dracula", "confirm")).toBe("dracula");
  });
  it("revert restores the theme active when the picker opened", () => {
    expect(resolveThemeOutcome("dark", "dracula", "revert")).toBe("dark");
  });
  it("revert is a no-op when nothing changed", () => {
    expect(resolveThemeOutcome("light", "light", "revert")).toBe("light");
  });
});

describe("persistThemeChoice (atomic user-level write)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "heirloom-theme-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes theme.mode into a fresh settings.json", () => {
    persistThemeChoice("dracula", dir);
    const settingsPath = join(dir, "settings.json");
    expect(existsSync(settingsPath)).toBe(true);
    const parsed = JSON.parse(readFileSync(settingsPath, "utf-8"));
    expect(parsed.theme.mode).toBe("dracula");
  });

  it("persists auto as theme.mode = auto", () => {
    persistThemeChoice(AUTO_THEME, dir);
    const parsed = JSON.parse(readFileSync(join(dir, "settings.json"), "utf-8"));
    expect(parsed.theme.mode).toBe("auto");
  });

  it("preserves existing settings and merges only the theme block", () => {
    const settingsPath = join(dir, "settings.json");
    writeFileSync(
      settingsPath,
      JSON.stringify({ model: "gpt-x", theme: { overrides: { accent: 1 } } }, null, 2),
      "utf-8",
    );
    persistThemeChoice("monokai", dir);
    const parsed = JSON.parse(readFileSync(settingsPath, "utf-8"));
    expect(parsed.model).toBe("gpt-x");
    expect(parsed.theme.mode).toBe("monokai");
    // existing theme sub-keys are preserved (merged, not clobbered)
    expect(parsed.theme.overrides).toEqual({ accent: 1 });
  });

  it("creates the home directory if it does not exist", () => {
    const nested = join(dir, "deep", "nested");
    persistThemeChoice("light", nested);
    expect(existsSync(join(nested, "settings.json"))).toBe(true);
  });

  it("leaves no temp files behind (atomic rename)", () => {
    persistThemeChoice("dark", dir);
    const files: string[] = readdirSync(dir);
    expect(files.filter((f) => f.endsWith(".tmp"))).toHaveLength(0);
    expect(files).toContain("settings.json");
  });

  it("recovers from a corrupt existing settings.json rather than crashing", () => {
    const settingsPath = join(dir, "settings.json");
    writeFileSync(settingsPath, "{ not valid json", "utf-8");
    expect(() => persistThemeChoice("high-contrast", dir)).not.toThrow();
    const parsed = JSON.parse(readFileSync(settingsPath, "utf-8"));
    expect(parsed.theme.mode).toBe("high-contrast");
  });
});
