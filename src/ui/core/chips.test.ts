import { describe, it, expect } from "vitest";
import { chip, meter, visibleWidth } from "./chips.js";

const COLOR = { fg: 231, bg: 54, colorEnabled: true };
const NO_COLOR = { fg: 231, bg: 54, colorEnabled: false };

describe("chip", () => {
  it("pads the label so the fill extends past the text", () => {
    // The padding inside the background run is what makes it read as a slab
    // rather than coloured text.
    expect(visibleWidth(chip("high", COLOR))).toBe("high".length + 2);
  });

  it("wraps the label in background and foreground colour", () => {
    const out = chip("high", COLOR);
    expect(out).toContain("\x1b[48;5;54m");
    expect(out).toContain("\x1b[38;5;231m");
    expect(out).toMatch(/\x1b\[0m$/);
  });

  it("degrades to brackets without colour so the shape survives", () => {
    expect(chip("high", NO_COLOR)).toBe("[high]");
  });

  it("stays on a single row", () => {
    // A bordered Box would be three rows and break the composer's fixed height.
    expect(chip("DeepSeek V4 Pro", COLOR)).not.toContain("\n");
  });
});

describe("meter", () => {
  const OPTS = { fg: 51, dim: 240, colorEnabled: true };

  it("renders the requested width regardless of fill", () => {
    for (const pct of [0, 1, 50, 99, 100]) {
      expect(visibleWidth(meter(pct, 12, OPTS))).toBe(12);
    }
  });

  it("fills proportionally", () => {
    const half = meter(50, 10, { ...OPTS, colorEnabled: false });
    expect(half).toHaveLength(10);
    expect(meter(0, 10, { ...OPTS, colorEnabled: false })).toHaveLength(10);
  });

  it("clamps out-of-range values instead of overflowing", () => {
    expect(visibleWidth(meter(-20, 8, OPTS))).toBe(8);
    expect(visibleWidth(meter(420, 8, OPTS))).toBe(8);
  });

  it("colours the filled and unfilled runs differently", () => {
    const out = meter(50, 10, OPTS);
    expect(out).toContain("\x1b[38;5;51m");
    expect(out).toContain("\x1b[38;5;240m");
  });
});

describe("visibleWidth", () => {
  it("ignores ANSI escapes", () => {
    expect(visibleWidth("\x1b[38;5;51mabc\x1b[0m")).toBe(3);
  });
});

describe("theme colour sourcing", () => {
  it("emits 256-colour escapes, not low ANSI", async () => {
    // Low ANSI (0-15) is remapped by each terminal's own palette, so chips
    // built from those slots do not match the rest of the 256-colour chrome —
    // the effort chip rendered muddy rather than amber. Every colour a chip
    // uses must therefore be an explicit 256-colour code.
    const { DARK_THEME } = await import("../theme.js");
    const out = chip("high", {
      fg: DARK_THEME.textInverse,
      bg: DARK_THEME.warning,
      colorEnabled: true,
    });
    // 214 = Claude Code's warning amber. If `warning` regresses to ANSI.yellow
    // (3) this fails.
    expect(out).toContain("\x1b[48;5;214m");
    expect(DARK_THEME.warning).toBeGreaterThan(15);
    expect(DARK_THEME.surface).toBeGreaterThan(15);
  });
});

describe("chip fill contrast", () => {
  it("fills chips with a tone that separates from the page background", async () => {
    // Regression: chips and the picker's selection band were filled with
    // `surface`, which sits only a hair above `background` in the grey ramp —
    // both vanished into a near-black terminal. `border` is the slot that is
    // meant to be visible against the page, and `selection` is purpose-built
    // for the band. ANSI_* themes are excluded: they deliberately use the
    // terminal's own 16-colour palette, where these numeric comparisons are
    // meaningless.
    const theme = await import("../theme.js");
    const themes = Object.entries(theme.BUILTIN_THEMES)
      .filter(([name]) => !name.startsWith("ansi"));
    expect(themes.length).toBeGreaterThan(0);

    for (const [name, t] of themes) {
      // The chip fill must be clearly distinguishable from the page. 8 steps
      // in the 256 ramp is roughly where a fill stops reading as "the same
      // colour" — `surface` fails this on the dark themes, which is the bug.
      expect(
        Math.abs(t.border - t.background),
        `${name}: chip fill (border) is too close to background`,
      ).toBeGreaterThanOrEqual(8);
      // And the selection band must not equal the page.
      expect(t.selection, `${name}: selection must differ from background`)
        .not.toBe(t.background);
    }
  });
});
