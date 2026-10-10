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
});
