import { describe, it, expect } from "vitest";
import { buildWelcomeLines } from "./WelcomeScreen.js";
import { ThemeContextValue, DARK_THEME } from "../theme.js";
import { stripAnsi as strip } from "../test-helpers.js";

function setup(
  overrides: Partial<{ model: string; thinkingEnabled: boolean; reasoningEffort?: string; cwd: string }> = {},
  colorEnabled = true,
) {
  const theme = new ThemeContextValue(DARK_THEME, colorEnabled);
  return buildWelcomeLines(theme, {
    model: "DeepSeek V4 Pro",
    thinkingEnabled: true,
    reasoningEffort: "high",
    cwd: "/Users/someone/projects/nib",
    ...overrides,
  });
}

/**
 * The session header used to be a component PINNED for the whole session; now
 * it is just the first lines ever committed to scrollback (see App.tsx and
 * OutputArea's <Static> migration). buildWelcomeLines is pure — no Ink render
 * needed — so these tests assert directly on the returned strings.
 */
describe("buildWelcomeLines", () => {
  it("fits in a handful of rows", () => {
    // Was 15 rows (six-row ASCII banner + six-row settings panel), which is
    // 63% of a standard 24-row terminal, forever, back when it was pinned.
    expect(setup().length).toBeLessThanOrEqual(7);
  });

  it("renders the wordmark padded for an inverse block, with color enabled", () => {
    // chip() wraps " NIB " in a background-color escape run when
    // colorEnabled is true — assert the ANSI background/foreground escapes
    // bracket the padded text.
    const lines = setup({}, true);
    const markLine = lines.find((l) => l.includes("NIB"))!;
    expect(markLine).toBeDefined();
    expect(markLine).toContain(" NIB ");
    // An ANSI escape (background/foreground set) appears before the mark and
    // a reset follows it — chip()'s colorEnabled branch.
    expect(markLine).toMatch(/\x1b\[[0-9;]*m NIB \x1b\[0m/);
  });

  it("degrades the wordmark to bracketed text when color is disabled", () => {
    // chip()'s colorEnabled:false branch degrades to "[label]" so the mark
    // still reads as a discrete token without color.
    const lines = setup({}, false);
    const markLine = lines.find((l) => l.includes("NIB"))!;
    expect(markLine).toContain("[NIB]");
  });

  it("shows the resolved model name, never a placeholder", () => {
    const lines = setup();
    const joined = lines.join("\n");
    expect(joined).toContain("DeepSeek V4 Pro");
    expect(joined).not.toContain("unknown");
  });

  it("states model, thinking and cwd on one line", () => {
    const lines = setup();
    const contextLine = lines.find((l) => l.includes("DeepSeek V4 Pro"));
    expect(contextLine).toBeDefined();
    expect(strip(contextLine!)).toContain("thinking high");
    expect(strip(contextLine!)).toContain("nib");
  });

  it("reports thinking as off when disabled", () => {
    const lines = setup({ thinkingEnabled: false });
    expect(lines.join("\n")).toContain("thinking off");
  });

  it("falls back to 'on' when thinking is enabled without an effort level", () => {
    const lines = setup({ reasoningEffort: undefined });
    expect(lines.join("\n")).toContain("thinking on");
  });

  it("abbreviates a long home-relative path", () => {
    const lines = setup({ cwd: process.env.HOME + "/a/very/deep/nested/path/that/keeps/going/on/and/on" });
    expect(lines.join("\n")).toContain("…");
  });

  it("includes the tip line", () => {
    const lines = setup();
    expect(lines.some((l) => strip(l).startsWith("Tip: "))).toBe(true);
  });

  it("renders no multi-row ASCII banner", () => {
    // The old banner was 61 columns of block/box glyphs across six rows,
    // shredded in IntelliJ's JediTerm. Its glyphs measured identical advance
    // widths, so font-metric drift wasn't the cause — likely renderer-side
    // (JediTerm custom-painting those glyph ranges), unverified.
    const lines = setup();
    const blockRows = lines.filter((l) => /█{4,}/.test(l));
    expect(blockRows).toHaveLength(0);
  });
});
