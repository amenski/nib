import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render } from "ink-testing-library";
import { Box, Text } from "ink";
import { ThemeProvider, TerminalProvider } from "./contexts.js";
import HintBar from "./HintBar.js";
import { stripAnsi as strip } from "./test-helpers.js";
import { DARK_THEME, BUILTIN_THEMES, ansiFg } from "./theme.js";

/** Ink narrows a blanket reset to foreground-off when closing a colour run. */
const ANSI_FG_RESET = "\x1b[39m";

function renderBar(ui: React.ReactElement, colorEnabled = false) {
  return render(
    <ThemeProvider config={{ colorEnabled }}>
      <TerminalProvider>{ui}</TerminalProvider>
    </ThemeProvider>,
  );
}

const LEFT = [{ key: "esc", label: "interrupt" }];
const RIGHT = [{ key: "ctrl+shift+p", label: "commands" }];

/**
 * The bottom row of the frame, and the only continuously-changing element.
 *
 * Ink repaints a changed line by walking the cursor UP from the bottom, so every
 * row below an animating line is rewritten on each tick. This bar carries the
 * 80ms working animation precisely because nothing renders under it. The tests
 * below pin the properties that keep that true: one row, stable width, and no
 * animation (or timer) when idle.
 */
describe("HintBar", () => {
  // Chords render as key-caps. Without colour a chip degrades to "[esc]", which
  // is what these assertions match — the shape survives either way.
  it("renders hints on a single row", () => {
    const { lastFrame } = renderBar(<HintBar left={LEFT} right={RIGHT} />);
    const rows = strip(lastFrame() ?? "").split("\n").filter((r) => r.trim() !== "");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain("[esc] interrupt");
    expect(rows[0]).toContain("[ctrl+shift+p] commands");
  });

  it("starts no timer when no turn is running", () => {
    // An idle animation would repaint this row forever — the bug fixed in
    // c74d54d, reintroduced one level down.
    const spy = vi.spyOn(globalThis, "setInterval");
    renderBar(<HintBar left={LEFT} />);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("animates only while working", () => {
    const spy = vi.spyOn(globalThis, "setInterval");
    renderBar(<HintBar working left={LEFT} />);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("paints the active dot in the theme accent at full intensity while working", () => {
    // The whole field used to be dim-wrapped, which made the travelling dot
    // nearly invisible on dark themes. The active dot must now carry the
    // accent colour, un-dimmed, so the animation reads at a glance.
    const { lastFrame } = renderBar(<HintBar working left={LEFT} />, true);
    // Ink wraps each styled run in reversed-video escapes (its own cursor
    // marker), so normalize those away before asserting on the colour runs.
    const frame = (lastFrame() ?? "").replace(/\x1b\[7m/g, "").replace(/\x1b\[27m/g, "");
    // Ink re-encodes the raw escapes the component emits: a blanket reset
    // (\x1b[0m) is narrowed to the matching attribute-off code — \x1b[39m after
    // a foreground colour, \x1b[22m after dim — so assert on those, not on the
    // pre-render string. frame starts at 0, so the active dot is the first of
    // the eight. The accent run is immediately followed by the track's
    // textDim run, so Ink drops the closing reset and opens the next fg
    // instead — assert on the accent run opening the dot, not on its close.
    expect(frame).toContain(`${ansiFg(DARK_THEME.accent)}•`);
    // ...and the other seven track dots stay dim — the theme's textDim grey, not
    // terminal dim. Ink also coalesces adjacent identical runs, so they arrive
    // as one dim span rather than seven individually-wrapped glyphs.
    expect(frame).toContain(`${ansiFg(DARK_THEME.textDim)}${"·".repeat(7)}${ANSI_FG_RESET}`);
  });

  it("keeps the indicator field blank when idle", () => {
    const { lastFrame } = renderBar(<HintBar left={LEFT} />);
    const frame = lastFrame() ?? "";
    expect(frame).not.toContain("•");
  });

  it("keeps the hints flush left and unmoved whether idle or working", () => {
    // The indicator field is reserved even when blank, so nothing shifts when a
    // turn starts and the row is overwritten in place rather than reflowed. It
    // trails the hints rather than leading them — leading it indented every
    // hint by the field width, which read as a stray margin.
    const idle = strip(renderBar(<HintBar left={LEFT} right={RIGHT} />).lastFrame() ?? "");
    const busy = strip(renderBar(<HintBar working left={LEFT} right={RIGHT} />).lastFrame() ?? "");
    expect(idle.indexOf("[esc]")).toBe(0);
    expect(busy.indexOf("[esc]")).toBe(0);
    // And the right-hand group must not move either.
    expect(busy.indexOf("ctrl+shift+p")).toBe(idle.indexOf("ctrl+shift+p"));
  });

  it("right-aligns the right-hand group", () => {
    const { lastFrame } = renderBar(<HintBar left={LEFT} right={RIGHT} />);
    const row = strip(lastFrame() ?? "").split("\n")[0];
    expect(row.indexOf("ctrl+shift+p")).toBeGreaterThan(row.indexOf("esc"));
    // Padded apart rather than run together.
    expect(row).toMatch(/interrupt\s{2,}\[ctrl\+shift\+p\]/);
  });

  it("stays one row even with nothing to show", () => {
    const { lastFrame } = renderBar(<HintBar left={[]} />);
    expect(strip(lastFrame() ?? "").split("\n")).toHaveLength(1);
  });

  it("renders below whatever precedes it", () => {
    // Position is the whole point: it must be last.
    const { lastFrame } = renderBar(
      <Box flexDirection="column">
        <Text>STATUS-BAR</Text>
        <HintBar working left={LEFT} />
      </Box>,
    );
    const rows = strip(lastFrame() ?? "").split("\n").filter((r) => r.trim() !== "");
    expect(rows[0]).toContain("STATUS-BAR");
    expect(rows[rows.length - 1]).toContain("[esc] interrupt");
  });

  /**
   * Key-cap legibility regression.
   *
   * The cap used to paint `textDim` on `border`. Those slots sit a few steps
   * apart on the same grey ramp in most themes and are the SAME VALUE (8) in
   * ansi-dark/ansi-light, so the chord rendered as an invisible slab — the
   * label beside it was readable while the key it described was not.
   */
  it("never paints a key-cap in its own background colour", () => {
    for (const [name, t] of Object.entries(BUILTIN_THEMES)) {
      expect(
        t.textBright,
        `${name}: key-cap fg must differ from its border background`,
      ).not.toBe(t.border);
    }
  });

  it("paints the key-cap brighter than the label beside it", () => {
    const { lastFrame } = renderBar(<HintBar left={LEFT} />, true);
    const frame = lastFrame() ?? "";
    // The cap carries an explicit bright foreground; the label is dim (textDim).
    expect(frame).toContain(ansiFg(DARK_THEME.textBright));
    expect(frame).toContain(ansiFg(DARK_THEME.textDim));
  });
});
