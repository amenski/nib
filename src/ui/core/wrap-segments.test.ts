import { describe, it, expect } from "vitest";
import { wrapSegments } from "./wrap-segments.js";
import type { Segment } from "./markdown-inline.js";

const plain = (text: string): Segment => ({ text, formats: [] });
const code = (text: string): Segment => ({ text, formats: ["code"] });
const rowText = (rows: Segment[][]) => rows.map((r) => r.map((s) => s.text).join(""));

describe("wrapSegments", () => {
  it("breaks at spaces and never starts a row with one, even beside a styled span", () => {
    const rows = rowText(wrapSegments([plain("broken (undefined "), code("withApp"), plain(", a hardcoded "), code("390"), plain(" assert")], 20));
    for (const r of rows) {
      expect(r.startsWith(" ")).toBe(false);
      expect(r.length).toBeLessThanOrEqual(20);
    }
    expect(rows.join(" ")).toBe("broken (undefined withApp, a hardcoded 390 assert");
  });

  it("keeps a word made of adjacent segments together", () => {
    // Width 30: "Verification: " (14) + the 27-column word does not fit, so the
    // whole word moves to the next row instead of breaking at the "+".
    const rows = rowText(wrapSegments([plain("Verification: "), code("carouselLogic"), plain("+"), code("remixCompiler"), plain(" 58/58")], 30));
    expect(rows).toEqual(["Verification:", "carouselLogic+remixCompiler", "58/58"]);
  });

  it("treats an embedded newline as a hard break and splits an overlong word", () => {
    expect(rowText(wrapSegments([plain("a\nb")], 10))).toEqual(["a", "b"]);
    expect(rowText(wrapSegments([plain("abcdefghij")], 4))).toEqual(["abcd", "efgh", "ij"]);
  });

  it("keeps a pre-coloured line on one row when it fits (2026-10-11)", () => {
    // Regression: the escapes counting as columns made a dim 70-column line
    // wrap at width 80. `visualLength` is ANSI-aware now, so the row fits.
    const dim = (s: string) => `\x1b[38;5;246m${s}\x1b[0m`;
    const line = "word ".repeat(14).trim(); // 69 columns
    const rows = wrapSegments([{ text: dim(line), formats: [] }], 80);
    expect(rows).toHaveLength(1);
    expect(rows[0]![0]!.text).toBe(dim(line));
  });

  it("never splits inside an ANSI escape when force-breaking (2026-10-11)", () => {
    // A word longer than the width is split mid-word; the split must land
    // between escapes and characters, never inside one, or the raw sequence
    // fragments ("\x1b[38;5;2" / "46m") leak into the frame.
    const coloured = "\x1b[38;5;246m" + "abcdefghij" + "\x1b[0m";
    const rows = rowText(wrapSegments([{ text: coloured, formats: [] }], 4));
    expect(rows.join("")).toBe(coloured);
    for (const r of wrapSegments([{ text: coloured, formats: [] }], 4)) {
      for (const seg of r) expect(seg.text).not.toMatch(/\x1b\[[0-9;]*$/);
    }
  });
});
