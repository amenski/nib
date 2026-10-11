import React from "react";
import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import MarkdownText from "./MarkdownText.js";
import { stripAnsi } from "./test-helpers.js";

describe("MarkdownText block rendering", () => {
  it("parses inline formatting inside headings", () => {
    const md = "# **Bold** plan";
    const { lastFrame } = render(<MarkdownText>{md}</MarkdownText>);
    const frame = stripAnsi(lastFrame() ?? "");
    // The heading marker and the emphasis markers must not leak through.
    expect(frame).not.toContain("#");
    expect(frame).not.toContain("**");
    expect(frame).toContain("Bold plan");
  });

  it("renders a span that closes across a newline (paragraph merge)", () => {
    // flushPendingParagraph commits held lines joined with "\n" as one entry,
    // so the renderer must parse bold/code spanning the newline.
    const md = "**bold\ncontinues**";
    const { lastFrame } = render(<MarkdownText>{md}</MarkdownText>);
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).not.toContain("**");
    expect(frame).toContain("bold");
    expect(frame).toContain("continues");
  });

  it("renders a wrapped unordered list item as one item with its continuation", () => {
    // The streamer commits a held list block as a single "\n"-joined entry.
    const md = "- first item\n  wrapped under it\n- second item";
    const { lastFrame } = render(<MarkdownText>{md}</MarkdownText>);
    const frame = stripAnsi(lastFrame() ?? "");
    // Continuation lines stay under the item, not re-marked.
    expect(frame).toContain("first item");
    expect(frame).toContain("wrapped under it");
    expect(frame).toContain("second item");
    // The marker is "-" at column 0 (Claude Code's bullet), not "•" indented.
    const marked = frame.split("\n").filter((l) => l.startsWith("- "));
    expect(marked).toHaveLength(2);
    expect(frame).not.toContain("•");
  });

  it("accepts + as an unordered bullet", () => {
    const frame = stripAnsi(render(<MarkdownText>{"+ plus item"}</MarkdownText>).lastFrame() ?? "");
    expect(frame).toContain("plus item");
    expect(frame).toContain("+");
    expect(frame).not.toContain("•");
  });

  it("renders one level of nesting, re-lettering a nested ordered item", () => {
    // Claude Code supports a single nesting level; a nested ordered item is
    // lettered (a., b., …) rather than carrying the source's number, and a
    // deeper indent collapses onto that one level.
    const md = "- first item\n  - sub one\n    - sub two\n  1. alpha\n  - sub three";
    const frame = stripAnsi(render(<MarkdownText>{md}</MarkdownText>).lastFrame() ?? "");
    const rows = frame.split("\n").filter((r) => r.trim() !== "");
    expect(rows[0]).toBe("- first item");
    expect(rows[1]).toBe("  - sub one");
    // One level of support only: "    - sub two" (depth 3) sits at depth 2.
    expect(rows[2]).toBe("  - sub two");
    expect(rows[3]).toBe("  a. alpha");
    expect(rows[4]).toBe("  - sub three");
  });

  it("keeps a wrapped nested item hanging under its own text", () => {
    const md = "- top\n  - a nested item long enough to wrap at this width";
    const frame = stripAnsi(render(<MarkdownText width={30}>{md}</MarkdownText>).lastFrame() ?? "");
    const rows = frame.split("\n").filter((r) => r.trim() !== "");
    // The nested marker sits at column 2 and its text at 4; the wrapped row
    // continues at the text column, not back under the marker.
    expect(rows[1]).toBe("  - a nested item long enough");
    expect(rows[2]).toMatch(/^ {4}\S/);
  });

  it("renders a wrapped ordered list item with its own number", () => {
    const md = "1. first\n   continuation\n2. second";
    const { lastFrame } = render(<MarkdownText>{md}</MarkdownText>);
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("first");
    expect(frame).toContain("continuation");
    expect(frame).toContain("second");
    expect(frame).toMatch(/1\./);
    expect(frame).toMatch(/2\./);
  });

  it("renders a multi-line blockquote with a ▎ marker per line", () => {
    const md = "> line one\n> line two";
    const { lastFrame } = render(<MarkdownText>{md}</MarkdownText>);
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("line one");
    expect(frame).toContain("line two");
    // Both lines carry the marker, and the raw ">" never leaks.
    expect(frame.split("\n").filter((l) => l.includes("▎")).length).toBe(2);
    expect(frame).not.toContain("> line");
  });

  it("wraps a long heading to the width it is given (2026-10-11)", async () => {
    // Headings used to skip the wrapper, so a long one ran past the terminal
    // and Ink re-wrapped it wherever it liked (leaving a stray leading space on
    // rows that broke beside a styled span).
    const { visualLength } = await import("./MarkdownTable.js");
    const md = "## " + "alpha bravo charlie delta echo foxtrot golf hotel".repeat(2);
    const { lastFrame } = render(<MarkdownText width={30}>{md}</MarkdownText>);
    const rows = stripAnsi(lastFrame() ?? "").split("\n").filter((r) => r.trim() !== "");
    expect(rows.length).toBeGreaterThan(1);
    for (const r of rows) expect(visualLength(r)).toBeLessThanOrEqual(30);
    expect(rows[0]).toContain("alpha");
    expect(stripAnsi(lastFrame() ?? "")).not.toContain("##");
  });
});

describe("MarkdownText code blocks (2026-10-11)", () => {
  it("draws the body alone, with no ── lang ── header", async () => {
    const { ThemeContextValue, DARK_THEME } = await import("./theme.js");
    const theme = new ThemeContextValue(DARK_THEME, true);
    const md = "```ts\nconst x = 1;\n```";
    const frame = stripAnsi(render(<MarkdownText theme={theme}>{md}</MarkdownText>).lastFrame() ?? "");
    expect(frame).toContain("const x = 1;");
    expect(frame).not.toContain("──");
    expect(frame).not.toContain("ts");
    // Flush with the gutter: the old renderer indented the body two columns.
    expect(frame.split("\n").find((r) => r.includes("const"))).not.toMatch(/^ {1,}const/);
  });

  it("colours an unlabelled block with the accent, not dim grey", async () => {
    const { ThemeContextValue, DARK_THEME, ansiFg } = await import("./theme.js");
    const theme = new ThemeContextValue(DARK_THEME, true);
    const md = "```\nplain body\n```";
    const frame = render(<MarkdownText theme={theme}>{md}</MarkdownText>).lastFrame() ?? "";
    expect(frame).toContain(`${ansiFg(DARK_THEME.accent)}plain body`);
    expect(frame).not.toContain("\x1b[2mplain body");
  });

  it("shows nothing for a fence opener whose body has not streamed yet", () => {
    expect(stripAnsi(render(<MarkdownText>{"```ts"}</MarkdownText>).lastFrame() ?? "").trim()).toBe("");
  });
});

describe("MarkdownText rules and links (2026-10-11)", () => {
  it("draws a horizontal rule as three dim dashes", async () => {
    const { ThemeContextValue, DARK_THEME, ansiFg } = await import("./theme.js");
    const theme = new ThemeContextValue(DARK_THEME, true);
    const frame = render(<MarkdownText theme={theme}>{"---"}</MarkdownText>).lastFrame() ?? "";
    expect(frame).toContain(`${ansiFg(DARK_THEME.textDim)}---`);
    // Not the old full-width bar.
    expect(frame).not.toContain("─");
  });

  it("accents a link's label and dims its URL", async () => {
    const { ThemeContextValue, DARK_THEME, ansiFg } = await import("./theme.js");
    const theme = new ThemeContextValue(DARK_THEME, true);
    const frame =
      render(<MarkdownText theme={theme}>{"see [docs](https://x.y) now"}</MarkdownText>).lastFrame() ?? "";
    expect(frame).toContain(`${ansiFg(DARK_THEME.accent)}docs`);
    expect(frame).toContain(`${ansiFg(DARK_THEME.textDim)}(https://x.y)`);
    expect(frame).toContain("see");
    expect(frame).toContain("now");
  });
});

describe("MarkdownText inline code colour", () => {
  it("colours inline code with the theme accent instead of terminal dim", async () => {
    // Inline code rendered as dimColor (SGR 2), which most terminals draw as a
    // faint grey that is hard to read. Claude Code colours code spans with its
    // permission lavender — nib's `accent` slot.
    const { ThemeContextValue, DARK_THEME, ansiFg } = await import("./theme.js");
    const theme = new ThemeContextValue(DARK_THEME, true);
    const { lastFrame } = render(<MarkdownText theme={theme}>{"see `~/.nib/settings.json` now"}</MarkdownText>);
    const frame = lastFrame() ?? "";
    expect(frame).toContain(`${ansiFg(DARK_THEME.accent)}~/.nib/settings.json`);
    expect(frame).not.toContain("\x1b[2m~/.nib");
  });
});
