import { describe, it, expect } from "vitest";
import {
  streamTextChunk,
  createStreamBlockState,
  classifyLine,
  isListItem,
  isListBlock,
  isQuoteBlock,
  paragraphShouldHold,
  MAX_HELD_LINES,
  type StreamBlockState,
} from "./stream-blocks.js";

/** Feed chunks in sequence, returning the committed lines. */
function feed(chunks: string[]): { lines: string[]; state: StreamBlockState } {
  let state = createStreamBlockState();
  let lines: string[] = [];
  for (const c of chunks) {
    const r = streamTextChunk(state, c);
    lines = lines.concat(r.lines);
    state = r.state;
  }
  return { lines, state };
}

describe("classifyLine", () => {
  it("classifies block starters", () => {
    expect(classifyLine("```ts")).toBe("fence");
    expect(classifyLine("```")).toBe("fence");
    expect(classifyLine("")).toBe("blank");
    expect(classifyLine("   ")).toBe("blank");
    expect(classifyLine("# Heading")).toBe("heading");
    expect(classifyLine("> quote")).toBe("quote");
    expect(classifyLine("---")).toBe("hr");
    expect(classifyLine("- item")).toBe("item");
    expect(classifyLine("* item")).toBe("item");
    expect(classifyLine("1. item")).toBe("item");
    expect(classifyLine("plain text")).toBe("text");
  });

  it("treats an indented line as a list continuation, not a top-level item", () => {
    expect(classifyLine("  - sub")).toBe("continuation");
    expect(classifyLine("    indented")).toBe("continuation");
  });

  it("does not treat bold as a list item", () => {
    expect(isListItem("**bold**")).toBe(false);
    expect(classifyLine("**bold**")).toBe("text");
  });
});

describe("isListBlock / paragraphShouldHold", () => {
  it("recognizes a multi-line list block", () => {
    expect(isListBlock(["- one", "- two"])).toBe(true);
    expect(isListBlock(["- item", "  continuation"])).toBe(true);
    expect(isListBlock(["1. one", "2. two"])).toBe(true);
    expect(isListBlock(["1. one", "  wrapped"])).toBe(true);
  });

  it("rejects a paragraph that merely starts with a list marker", () => {
    expect(isListBlock(["- one", "plain"])).toBe(false);
  });

  it("recognizes a multi-line blockquote block", () => {
    expect(isQuoteBlock(["> one"])).toBe(true);
    expect(isQuoteBlock(["> one", "> two"])).toBe(true);
    expect(isQuoteBlock(["> one", "  lazy continuation"])).toBe(true);
    // A plain line ends the quote — in a stream it may be a new paragraph.
    expect(isQuoteBlock(["> one", "plain"])).toBe(false);
    expect(isQuoteBlock(["plain", "> one"])).toBe(false);
  });

  it("holds a list block, an open span, a code span, and a quote across lines", () => {
    expect(paragraphShouldHold(["- item"])).toBe(true);
    expect(paragraphShouldHold(["- item", "  cont"])).toBe(true);
    expect(paragraphShouldHold(["**bold"])).toBe(true);
    expect(paragraphShouldHold(["install `npm"])).toBe(true);
    expect(paragraphShouldHold(["> quote"])).toBe(true);
    expect(paragraphShouldHold(["> one", "> two"])).toBe(true);
    // A lone completed paragraph never holds.
    expect(paragraphShouldHold(["plain text"])).toBe(false);
    expect(paragraphShouldHold(["- item", "plain"])).toBe(false);
    expect(paragraphShouldHold(["> quote", "plain"])).toBe(false);
  });
});

describe("streamTextChunk", () => {
  it("commits complete single lines immediately", () => {
    const { lines, state } = feed(["hello\nworld\n"]);
    expect(lines).toEqual(["hello", "world"]);
    expect(state.pending).toEqual([]);
    expect(state.buffer).toBe("");
  });

  it("holds a list block until it ends, then commits as one entry", () => {
    const { lines, state } = feed(["- item one\n", "  wrapped\n", "plain\n"]);
    expect(lines).toEqual(["- item one\n  wrapped", "plain"]);
    expect(state.pending).toEqual([]);
    expect(state.buffer).toBe("");
  });

  it("commits a lone list item immediately once a non-list line follows", () => {
    const { lines } = feed(["- item\n", "plain\n"]);
    expect(lines).toEqual(["- item", "plain"]);
  });

  it("flushes a held paragraph at a blank line (span cannot cross it)", () => {
    const { lines, state } = feed(["**bold\n", "still bold\n", "\n"]);
    // The span closes on line 2 but the blank line is the flush boundary.
    expect(lines).toEqual(["**bold\nstill bold", ""]);
    expect(state.pending).toEqual([]);
  });

  it("holds an unclosed span across streamed lines until it closes", () => {
    const { lines, state } = feed(["**bold\n", "continues**\n"]);
    expect(lines).toEqual(["**bold\ncontinues**"]);
    expect(state.buffer).toBe("");
    expect(state.pending).toEqual([]);
  });

  it("commits a paragraph at a heading, fence, or blockquote boundary", () => {
    const { lines } = feed(["para text\n", "# Heading\n"]);
    // The heading separator (Claude Code prints one blank after a heading)
    // rides along with the heading's own commit.
    expect(lines).toEqual(["para text", "# Heading", ""]);

    // A quote interrupts a held span paragraph the same way a heading does —
    // the span cannot cross into the quote. The quote line itself then holds:
    // it may be the first line of a multi-line blockquote.
    const { lines: q, state } = feed(["**bold\n", "> quote\n"]);
    expect(q).toEqual(["**bold"]);
    expect(state.pending).toEqual(["> quote"]);
  });

  it("follows a heading with exactly one blank line (2026-10-11)", () => {
    // Separator added, and the source's own blank swallowed.
    expect(feed(["# Title\n", "\n", "body\n"]).lines).toEqual(["# Title", "", "body"]);
    // No source blank: the separator alone.
    expect(feed(["# Title\n", "body\n"]).lines).toEqual(["# Title", "", "body"]);
    // A heading whose inline span is still open is held; its separator is
    // emitted at that later commit, so it can never land above the closing text.
    expect(feed(["## **bold\n", "closes**\n", "\n", "after\n"]).lines).toEqual([
      "## **bold\ncloses**",
      "",
      "after",
    ]);
    // Only headings get the separator.
    expect(feed(["plain\n", "\n", "body\n"]).lines).toEqual(["plain", "", "body"]);
  });

  it("holds a multi-line blockquote and commits it as one entry", () => {
    const { lines, state } = feed(["> line one\n", "> line two\n", "\n"]);
    expect(lines).toEqual(["> line one\n> line two", ""]);
    expect(state.pending).toEqual([]);
    expect(state.buffer).toBe("");
  });

  it("commits a lone quote line once a plain line follows", () => {
    const { lines } = feed(["> quote\n", "plain\n"]);
    expect(lines).toEqual(["> quote", "plain"]);
  });

  it("joins a span that closes across blockquote lines", () => {
    const { lines, state } = feed(["> **bold\n", "> continues**\n", "\n"]);
    expect(lines).toEqual(["> **bold\n> continues**", ""]);
    expect(state.pending).toEqual([]);
  });

  it("accumulates a fenced code block and commits it at the closing fence", () => {
    const { lines, state } = feed(["```ts\n", "const x = 1;\n", "```\n"]);
    expect(lines).toEqual(["```ts\nconst x = 1;\n```"]);
    expect(state.fence).toBeNull();
  });

  it("leaves an unclosed fence in state (committed at turn end via flush)", () => {
    const { lines, state } = feed(["```\n", "code\n"]);
    expect(lines).toEqual([]);
    expect(state.fence).toEqual(["```", "code"]);
  });

  it("does not hold past MAX_HELD_LINES (literal **kwargs escape hatch)", () => {
    const chunks = ["**kwargs\n", "more\n", "even more\n", "final\n"];
    const { lines, state } = feed(chunks);
    // After MAX_HELD_LINES held lines the paragraph commits as literal text;
    // the rest of the stream continues normally.
    expect(state.pending).toEqual([]);
    expect(lines.length).toBeGreaterThan(0);
    // The whole held run committed as one literal entry.
    expect(lines[0]).toBe(["**kwargs", "more", "even more"].join("\n"));
    expect(lines[lines.length - 1]).toBe("final");
  });

  it("preserves the partial tail across chunks", () => {
    const { lines, state } = feed(["hel", "lo\n"]);
    expect(lines).toEqual(["hello"]);
    expect(state.buffer).toBe("");
  });

  it("reports the live preview for a held paragraph and an open fence", () => {
    let state = createStreamBlockState();
    let r = streamTextChunk(state, "- item\n");
    expect(r.activeLine).toBe("- item");
    r = streamTextChunk(r.state, "  cont\n");
    expect(r.activeLine).toBe("- item\n  cont");
    expect(r.lines).toEqual([]);

    state = createStreamBlockState();
    r = streamTextChunk(state, "```ts\n");
    expect(r.activeLine).toBe("```ts");
    r = streamTextChunk(r.state, "code\n");
    expect(r.activeLine).toBe("```ts\ncode");
    expect(r.lines).toEqual([]);
  });

  it("returns an empty activeLine when nothing is held", () => {
    const r = streamTextChunk(createStreamBlockState(), "done\n");
    expect(r.activeLine).toBe("");
    expect(r.lines).toEqual(["done"]);
  });

  it("exposes MAX_HELD_LINES as the module-level cap", () => {
    expect(MAX_HELD_LINES).toBe(3);
  });
});
