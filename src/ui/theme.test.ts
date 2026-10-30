import { describe, it, expect } from "vitest";
import {
  detectSystemThemeFrom,
  resolveTheme,
  BUILTIN_THEMES,
  type SystemThemeDeps,
} from "./theme.js";

/** Build deps with sane defaults, overridable per test. */
function deps(over: Partial<SystemThemeDeps>): SystemThemeDeps {
  return {
    env: {},
    platform: "linux",
    exec: () => {
      throw new Error("exec not stubbed");
    },
    ...over,
  };
}

describe("detectSystemThemeFrom", () => {
  it("reads COLORFGBG light backgrounds (7/15)", () => {
    expect(detectSystemThemeFrom(deps({ env: { COLORFGBG: "0;7" } }))).toBe("light");
    expect(detectSystemThemeFrom(deps({ env: { COLORFGBG: "0;15" } }))).toBe("light");
    // Three-field form ("fg;x;bg") — last field wins.
    expect(detectSystemThemeFrom(deps({ env: { COLORFGBG: "0;default;15" } }))).toBe("light");
  });

  it("reads COLORFGBG dark backgrounds (0-6, 8)", () => {
    expect(detectSystemThemeFrom(deps({ env: { COLORFGBG: "15;0" } }))).toBe("dark");
    expect(detectSystemThemeFrom(deps({ env: { COLORFGBG: "15;6" } }))).toBe("dark");
    expect(detectSystemThemeFrom(deps({ env: { COLORFGBG: "15;8" } }))).toBe("dark");
  });

  it("falls through malformed COLORFGBG to the next stage", () => {
    // Non-numeric background → skip COLORFGBG; non-darwin → fallback dark.
    expect(detectSystemThemeFrom(deps({ env: { COLORFGBG: "15;default" } }))).toBe("dark");
    // Out-of-range background (e.g. 9) is neither light nor dark by our rule →
    // skip to next stage; here darwin Dark resolves it.
    expect(
      detectSystemThemeFrom(deps({ env: { COLORFGBG: "15;9" }, platform: "darwin", exec: () => "Dark\n" })),
    ).toBe("dark");
    expect(
      detectSystemThemeFrom(deps({ env: { COLORFGBG: "15;9" }, platform: "darwin", exec: () => { throw new Error("absent"); } })),
    ).toBe("light");
  });

  it("detects macOS Dark mode via AppleInterfaceStyle", () => {
    expect(detectSystemThemeFrom(deps({ platform: "darwin", exec: () => "Dark\n" }))).toBe("dark");
  });

  it("treats an absent AppleInterfaceStyle key (non-zero exit) as light", () => {
    expect(
      detectSystemThemeFrom(deps({ platform: "darwin", exec: () => { throw new Error("does not exist"); } })),
    ).toBe("light");
  });

  it("falls back to dark on non-darwin with no COLORFGBG", () => {
    expect(detectSystemThemeFrom(deps({ platform: "linux" }))).toBe("dark");
  });
});

describe("key-cap legibility", () => {
  // A chip paints textBright on border; a chord must never vanish into its own background.
  it("never paints a key-cap in its own background colour", () => {
    for (const [name, t] of Object.entries(BUILTIN_THEMES)) {
      expect(t.textBright, `${name}: key-cap fg must differ from its border background`).not.toBe(t.border);
    }
  });
});

describe("single built-in theme", () => {
  it("registers only dark", () => {
    expect(Object.keys(BUILTIN_THEMES)).toEqual(["dark"]);
  });

  // A settings file saved while the other presets existed must keep working:
  // every removed name, and light/auto mode, lands on dark.
  for (const name of ["light", "high-contrast", "dracula", "monokai", "github-dark", "github-light", "ansi-dark", "ansi-light", "does-not-exist"]) {
    it(`resolves a saved name "${name}" to dark`, () => {
      expect(resolveTheme({ mode: "dark", name }).name).toBe("dark");
    });
  }

  it("resolves light mode to dark", () => {
    expect(resolveTheme({ mode: "light" }).name).toBe("dark");
  });

  it("merges overrides on top of dark", () => {
    const resolved = resolveTheme({
      mode: "dark",
      overrides: { accent: 200, syntax: { keyword: 111 } as any },
    });
    expect(resolved.accent).toBe(200);
    expect(resolved.syntax.keyword).toBe(111);
    // Untouched slots stay from the base theme.
    expect(resolved.syntax.string).toBe(BUILTIN_THEMES.dark.syntax.string);
  });
});
