import { describe, it, expect } from "vitest";
import { parseInline, inlineSpanOpen, unclosedSpanClosers } from "./MarkdownText.js";

function textOf(segments: { text: string }[]): string {
  return segments.map((s) => s.text).join("");
}

describe("parseInline", () => {
  it("renders **bold** once, without duplicated text (overlap regression)", () => {
    const segs = parseInline("I'm in **planning mode** right now");
    expect(textOf(segs)).toBe("I'm in planning mode right now");
    const bold = segs.find((s) => (s as any).formats.includes("bold"));
    expect(bold?.text).toBe("planning mode");
  });

  it("handles a short bold word", () => {
    const segs = parseInline("**No** file modifications");
    expect(textOf(segs)).toBe("No file modifications");
  });

  it("bold and italic coexist without overlap", () => {
    const segs = parseInline("**bold** and *italic* here");
    expect(textOf(segs)).toBe("bold and italic here");
  });

  it("code wins over bold inside backticks", () => {
    const segs = parseInline("`**not bold**` outside");
    expect(textOf(segs)).toBe("**not bold** outside");
    expect((segs[0] as any).formats).toContain("code");
  });

  it("bold wraps an inline code span without leaking literal asterisks", () => {
    const segs = parseInline("**install `npm i -g x`**");
    expect(textOf(segs)).toBe("install npm i -g x");
    expect((segs[0] as any).formats).toEqual(["bold"]);
    expect((segs[1] as any).formats).toEqual(["bold", "code"]);
  });

  it("nests italic inside bold, stripping both marker pairs", () => {
    const segs = parseInline("**bold *italic* inside**");
    expect(textOf(segs)).toBe("bold italic inside");
    expect((segs[0] as any).formats).toEqual(["bold"]);
    expect((segs[1] as any).formats).toEqual(["bold", "italic"]);
    expect((segs[2] as any).formats).toEqual(["bold"]);
  });

  it("renders ***bold italic*** as a single bold+italic span", () => {
    const segs = parseInline("***both***");
    expect(textOf(segs)).toBe("both");
    expect(segs).toHaveLength(1);
    expect((segs[0] as any).formats).toEqual(["bold", "italic"]);
  });

  it("leaves link syntax inside code spans verbatim", () => {
    const segs = parseInline("`[not a link](nope)`");
    expect(textOf(segs)).toBe("[not a link](nope)");
    expect((segs[0] as any).formats).toEqual(["code"]);
  });

  it("still normalizes real links outside code, even with asterisks in the URL", () => {
    const segs = parseInline("see [docs](https://x.com/a**b) here");
    expect(textOf(segs)).toBe("see docs (https://x.com/a**b) here");
    // The label and its URL carry distinct formats so the renderer can accent
    // the one and dim the other; the surrounding text stays plain.
    const link = segs.find((s) => (s as any).formats.includes("link"));
    const url = segs.find((s) => (s as any).formats.includes("linkUrl"));
    expect(link?.text).toBe("docs");
    expect(url?.text).toBe("(https://x.com/a**b)");
    expect((segs[0] as any).formats).toEqual([]);
  });

  it("supports underscore emphasis", () => {
    const segs = parseInline("_emphasis_ here");
    expect(textOf(segs)).toBe("emphasis here");
    expect((segs[0] as any).formats).toEqual(["italic"]);
  });

  it("leaves arithmetic and snake_case underscores literal", () => {
    expect(textOf(parseInline("2 * 3 * 4"))).toBe("2 * 3 * 4");
    expect(parseInline("2 * 3 * 4").every((s) => (s as any).formats.length === 0)).toBe(true);
    expect(textOf(parseInline("foo_bar_baz"))).toBe("foo_bar_baz");
    expect(parseInline("foo_bar_baz").every((s) => (s as any).formats.length === 0)).toBe(true);
  });

  it("renders an unclosed opener as literal text", () => {
    const segs = parseInline("use **kwargs");
    expect(textOf(segs)).toBe("use **kwargs");
    expect(segs.every((s) => (s as any).formats.length === 0)).toBe(true);
  });

  it("recovers an unclosed inner delimiter as literal when an outer span closes", () => {
    const segs = parseInline("**a *b**");
    expect(textOf(segs)).toBe("a *b");
    expect(segs.every((s) => (s as any).formats.includes("bold"))).toBe(true);
  });

  it("keeps multiple bold spans independent", () => {
    const segs = parseInline("a **b** c **d** e");
    expect(textOf(segs)).toBe("a b c d e");
    const bold = segs.filter((s) => (s as any).formats.includes("bold"));
    expect(bold.map((s) => s.text)).toEqual(["b", "d"]);
  });

  it("renders strike and bold on the same span", () => {
    const segs = parseInline("~~**gone**~~ stays");
    expect(textOf(segs)).toBe("gone stays");
    expect((segs[0] as any).formats).toEqual(["strike", "bold"]);
  });
});

describe("unclosedSpanClosers (2026-10-11)", () => {
  it("returns nothing for text with no open span", () => {
    expect(unclosedSpanClosers("plain text")).toBe("");
    expect(unclosedSpanClosers("**closed**")).toBe("");
  });

  it("closes an open emphasis span", () => {
    expect(unclosedSpanClosers("**bold")).toBe("**");
    expect(unclosedSpanClosers("*italic")).toBe("*");
    expect(unclosedSpanClosers("~~strike")).toBe("~~");
  });

  it("closes an unmatched backtick, which leaves no parser stack entry", () => {
    expect(unclosedSpanClosers("install `npm")).toBe("`");
  });

  it("never closes a fenced code block (its content is literal, not a span)", () => {
    // Regression (found by probe): a fence's ``` lines are backticks, so the
    // odd-run rule appended a stray "`" to a streaming code block's preview,
    // rendering an extra backtick that was never in the output.
    expect(unclosedSpanClosers("```ts\nconst x = 1")).toBe("");
    expect(unclosedSpanClosers("```")).toBe("");
    expect(unclosedSpanClosers("```\ncode here\n```")).toBe("");
  });

  it("closes innermost first so a nested span stays well-formed", () => {
    // "**bold `code" must close the code span before its parent emphasis.
    expect(unclosedSpanClosers("**bold `code")).toBe("`**");
  });

  it("produces text the parser reads as fully closed", () => {
    for (const input of ["**bold", "*italic", "install `npm", "**bold `code"]) {
      expect(inlineSpanOpen(input)).toBe(true);
      expect(inlineSpanOpen(input + unclosedSpanClosers(input))).toBe(false);
    }
  });
});

describe("inlineSpanOpen", () => {
  it("reports open spans that may close on a later streamed line", () => {
    expect(inlineSpanOpen("**bold")).toBe(true);
    expect(inlineSpanOpen("*italic")).toBe(true);
    expect(inlineSpanOpen("~~strike")).toBe(true);
    expect(inlineSpanOpen("install `npm i -g")).toBe(true);
    expect(inlineSpanOpen("**bold *italic")).toBe(true);
  });

  it("reports complete text as closed", () => {
    expect(inlineSpanOpen("**bold**")).toBe(false);
    expect(inlineSpanOpen("*italic*")).toBe(false);
    expect(inlineSpanOpen("~~strike~~")).toBe(false);
    expect(inlineSpanOpen("run `npm test` and **fix** it")).toBe(false);
    expect(inlineSpanOpen("**bold** and *italic*")).toBe(false);
  });

  it("does not hold list bullets, arithmetic, or snake_case", () => {
    // The old odd-marker-count heuristic false-positived on these; the
    // parser's flanking rules must not hold them waiting for a closer.
    expect(inlineSpanOpen("* item")).toBe(false);
    expect(inlineSpanOpen("2 * 3 * 4")).toBe(false);
    expect(inlineSpanOpen("foo_bar_baz")).toBe(false);
  });

  it("treats a span closed across the paragraph join as complete", () => {
    // The streaming layer joins held lines with "\n" before checking, so a
    // closer on a later line must register as closed.
    expect(inlineSpanOpen("**bold\ncontinues**")).toBe(false);
  });
});
