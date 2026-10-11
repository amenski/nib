/**
 * Nib MarkdownText — Rich markdown renderer with syntax highlighting
 *
 * Features:
 * - Inline formatting: **bold**, *italic*, `code`, ~~strike~~, [links](url)
 * - Block elements: headings, blockquotes, lists (incl. wrapped items),
 *   horizontal rules
 * - Fenced code blocks with syntax highlighting (10+ languages)
 * - Theme-aware colors via ThemeContextValue
 * - Graceful fallback when syntax highlighter unavailable
 *
 * The inline parser lives in core/markdown-inline.ts and is re-exported here
 * so existing imports (`import { parseInline } from "./MarkdownText.js"`)
 * keep working. The streaming layer's paragraph merging can commit an entry
 * with embedded newlines — a wrapped list item, a multi-line blockquote, or a
 * span closed across a newline — so the block branches below handle
 * multi-line input, not just single lines.
 */

import React, { Fragment } from "react";
import { Text } from "ink";
import {
  parseInline,
  inlineSpanOpen,
  unclosedSpanClosers,
  type Segment,
} from "./core/markdown-inline.js";
import SyntaxHighlighter, { detectLanguage, type Language } from "./SyntaxHighlighter.js";
import MarkdownTable, { isTableBlock } from "./MarkdownTable.js";
import { wrapSegments } from "./core/wrap-segments.js";
import type { SyntaxColors } from "./theme.js";

// Re-exported so callers/tests importing from "./MarkdownText.js" keep working
// after the parser moved to core/markdown-inline.ts.
export { parseInline, inlineSpanOpen, unclosedSpanClosers };
export type { Segment };

interface MarkdownTextProps {
  children: string;
  /**
   * Columns this text may occupy. Passed to a table so its rows are sized to
   * the width actually available: a table on a gutter line sits two columns in
   * from the terminal edge, and sizing it to the full terminal made every row
   * wrap (the wrapped tail landed at column 0 as stray `┤ ─` fragments).
   * Without it the table falls back to the terminal width.
   */
  width?: number;
  /** Optional theme context for syntax highlighting and colors */
  theme?: {
    colorEnabled: boolean;
    theme: {
      syntax: any;
      text: number;
      textDim: number;
      textBright: number;
      textInverse: number;
      accent: number;
    };
    syntax: (key: keyof SyntaxColors, text: string) => string;
    dim: (text: string) => string;
    fg: (color: number, text: string) => string;
  };
}

// ── Inline Segment Renderer ──

function SegmentText({ segment, theme }: { segment: Segment; theme?: MarkdownTextProps["theme"] }) {
  const props: Record<string, any> = {};

  if (segment.formats.includes("bold")) props.bold = true;
  if (segment.formats.includes("italic")) props.italic = true;
  if (segment.formats.includes("strike")) props.strikethrough = true;
  if (segment.formats.includes("code")) {
    // Claude Code colours code spans with its permission lavender (nib's
    // `accent`). Terminal dim is only the no-theme fallback: most terminals
    // draw it as a faint grey that is hard to read.
    if (theme?.colorEnabled) return <Text {...props}>{theme.fg(theme.theme.accent, segment.text)}</Text>;
    props.dimColor = true;
  }

  // A link's label takes the accent; its URL recedes dim beside it.
  // (OSC-8 hyperlinks are out of scope.)
  if (segment.formats.includes("link") && theme?.colorEnabled) {
    return <Text {...props}>{theme.fg(theme.theme.accent, segment.text)}</Text>;
  }
  if (segment.formats.includes("linkUrl")) {
    if (theme?.colorEnabled) return <Text {...props}>{theme.fg(theme.theme.textDim, segment.text)}</Text>;
    props.dimColor = true;
  }

  return <Text {...props}>{segment.text}</Text>;
}

/**
 * Render a parsed inline string (which may contain embedded newlines). With a
 * `width`, the segments are pre-wrapped (core/wrap-segments.ts) so Ink never
 * re-wraps them — its own wrap leaves a stray leading space on rows that break
 * beside a styled span. `indent` pads continuation rows (a list item's text
 * hangs under its first word, not under the marker).
 */
function Inline({ text, theme, width, indent = 0 }: { text: string; theme?: MarkdownTextProps["theme"]; width?: number; indent?: number }) {
  const segs = parseInline(text);
  if (width !== undefined && width > indent) {
    const rows = wrapSegments(segs, width - indent);
    const pad = " ".repeat(indent);
    return (
      <>
        {rows.map((row, r) => (
          <Fragment key={r}>
            {r > 0 && `\n${pad}`}
            {row.map((seg, i) => (
              <SegmentText key={i} segment={seg} theme={theme} />
            ))}
          </Fragment>
        ))}
      </>
    );
  }
  return (
    <>
      {segs.map((seg, i) => (
        <SegmentText key={i} segment={seg} theme={theme} />
      ))}
    </>
  );
}

// ── Code Block Renderer (with Syntax Highlighting) ──

function CodeBlockBlock({
  text,
  theme,
}: {
  text: string;
  theme?: MarkdownTextProps["theme"];
}) {
  const lines = text.split("\n");
  const info = lines[0].length > 3 ? lines[0].slice(3).trim() : "";
  // Exclude closing fence
  const content = lines.slice(1, lines[lines.length - 1] === "```" ? -1 : undefined);

  const language = detectLanguage(info);
  const body = content.join("\n");

  // No "── lang ──" header: Claude Code draws the body alone, flush with the
  // gutter (the highlighted body carries no extra indent either).
  if (content.length === 0) return null;

  if (theme?.colorEnabled && language !== "text") {
    return (
      <Text>
        <SyntaxHighlighter code={body} language={language} theme={theme as any} />
      </Text>
    );
  }

  // Nothing to highlight: Claude Code colours an unlabelled block with its
  // `permission` tone (nib's `accent`) rather than a dim grey. With no theme at
  // all, terminal dim is the only available weight.
  const paint = theme
    ? (s: string) => theme.fg(theme.theme.accent, s)
    : (s: string) => `\x1b[2m${s}\x1b[0m`;
  return <Text>{paint(body)}</Text>;
}

// ── List block parsing ──

/**
 * A parsed list item. `depth` is 1 for a top-level item and 2 for one level of
 * nesting ("  - x" under "- x"); deeper indents stay a continuation, since the
 * renderer only lays out two levels.
 */
interface ListItem {
  /** The rendered marker glyph, without its trailing space. */
  marker: string;
  /** Nesting level, 1-based. */
  depth: number;
  /** Item text, including any wrapped continuation lines (kept verbatim). */
  content: string;
}

/** A depth-1 unordered marker, a depth-1 ordered marker, or "1)"-style. */
const TOP_ITEM_RE = /^([-*+]|\d+\.)\s+(.*)$/;
/** The same markers, indented by two or more columns. */
const NESTED_ITEM_RE = /^ {2,}([-*+]|\d+\.)\s+(.*)$/;

/** "a", "b", … for a nested ordered item. */
function ordinalLetter(i: number): string {
  return String.fromCharCode(97 + (i % 26));
}

/**
 * Split a (possibly multi-line) entry into list items, top-level and one level
 * of nesting. A line matching an item marker starts a new item; any other line
 * is a continuation of the current item and is kept verbatim (its leading
 * indent included), so a wrapped item reads as markdown wrote it. Returns null
 * when the first line isn't an item.
 *
 * A nested ordered item is re-lettered ("a.", "b.", …) from its own sequence,
 * which restarts at each top-level item — the numbers the source wrote at
 * depth 2 are not used.
 */
function splitListItems(text: string): ListItem[] | null {
  const items: ListItem[] = [];
  let subCounter = 0;
  for (const line of text.split("\n")) {
    const top = line.match(TOP_ITEM_RE);
    const nested = line.match(NESTED_ITEM_RE);
    if (top) {
      subCounter = 0;
      items.push({ marker: top[1], depth: 1, content: top[2] });
    } else if (nested) {
      const raw = nested[1];
      const marker = /^\d+\.$/.test(raw) ? `${ordinalLetter(subCounter++)}.` : raw;
      items.push({ marker, depth: 2, content: nested[2] });
    } else if (items.length > 0) {
      items[items.length - 1].content += "\n" + line;
    } else {
      return null;
    }
  }
  return items;
}

/** Columns the item's own text starts at: 2 per nesting level, then the marker. */
function itemContentIndent(item: ListItem): number {
  return (item.depth - 1) * 2 + item.marker.length + 1;
}

/** Render the items of one list block, each with its marker and hanging text. */
function renderListItems(items: ListItem[], theme?: MarkdownTextProps["theme"], width?: number) {
  const dim = theme ? (s: string) => theme.fg(theme.theme.textDim, s) : ((s: string) => `\x1b[2m${s}\x1b[0m`);
  return (
    <Text>
      {items.map((item, i) => (
        <Fragment key={i}>
          {i > 0 && "\n"}
          {item.depth > 1 && "  "}
          <Text>{dim(item.marker)}</Text>{" "}
          <Inline text={item.content} theme={theme} width={width} indent={itemContentIndent(item)} />
        </Fragment>
      ))}
    </Text>
  );
}

// ── Main Markdown Renderer ──

function MarkdownText({ children, theme, width }: MarkdownTextProps) {
  const text = children;

  // An empty string is an intentional blank line (used for spacing between
  // blocks). Render it as a real empty line rather than collapsing to null,
  // otherwise the surrounding output runs together with no breathing room.
  if (text === "") return <Text>{" "}</Text>;
  if (!text) return null;

  // ── Fenced code block (multi-line, starts with ```) ──
  if (text.startsWith("```") && text.includes("\n")) {
    return <CodeBlockBlock text={text} theme={theme} />;
  }

  // ── Code fence opener alone (no content yet — streaming) ──
  // Nothing to draw: the header line was dropped (Claude Code renders a code
  // block as its body alone), and the body has not streamed yet. The preview
  // fills in as soon as the first line arrives.
  if (text.startsWith("```")) return null;

  // ── Table: multi-line pipe-separated with separator row ──
  if (isTableBlock(text)) {
    return <MarkdownTable theme={theme} width={width}>{text}</MarkdownTable>;
  }

  // ── Heading: #, ##, ###, etc. (first line; a merged paragraph may carry
  // continuation lines after a span closed across newlines — render the
  // remainder as plain text rather than swallowing it). ──
  const firstLine = text.split("\n")[0];
  const headingMatch = firstLine.match(/^(#{1,6})\s+(.+)$/);
  if (headingMatch) {
    const level = headingMatch[1].length;
    // h1 reads bold + italic + underlined; h2-h6 bold (Claude Code's heading
    // weights). Headings carry inline formatting too: "# **Bold** plan" must
    // render the bold, not a literal "**Bold**". They wrap to `width` like any
    // paragraph — a long heading used to run past the terminal and get
    // re-wrapped by Ink.
    const rest = text.split("\n").slice(1).join("\n");
    return (
      <Text bold italic={level === 1} underline={level === 1}>
        <Inline text={headingMatch[2]} theme={theme} width={width} />
        {rest && (
          <>
            {"\n"}
            <Inline text={rest} theme={theme} width={width} />
          </>
        )}
      </Text>
    );
  }

  // ── Horizontal rule: ---, ***, ___ (3+ chars) ──
  // Three dashes, dim — Claude Code's rule, not a full-width bar.
  if (/^[-*_]{3,}$/.test(text.trim())) {
    const dim = theme ? (s: string) => theme.fg(theme.theme.textDim, s) : ((s: string) => `\x1b[2m${s}\x1b[0m`);
    return <Text>{dim("---")}</Text>;
  }

  // ── Blockquote: > text (one or more lines) ──
  // A multi-line entry arrives when the streamer held a quote paragraph (e.g.
  // a span closed across its lines); each line gets its own ▎ marker, and a
  // line without ">" is a lazy continuation shown as-is. The body is italic
  // (Claude Code's quote weight) and wraps two columns in, hanging under the
  // text rather than under the marker.
  if (text.startsWith(">")) {
    const dim = theme ? (s: string) => theme.fg(theme.theme.textDim, s) : ((s: string) => `\x1b[2m${s}\x1b[0m`);
    return (
      <Text>
        {text.split("\n").map((raw, i) => (
          <Fragment key={i}>
            {i > 0 && "\n"}
            <Text>{dim("▎")}</Text>{" "}
            <Text italic>
              <Inline
                text={raw.startsWith(">") ? raw.replace(/^>\s?/, "") : raw}
                theme={theme}
                width={width}
                indent={2}
              />
            </Text>
          </Fragment>
        ))}
      </Text>
    );
  }

  // ── Unordered list: "- text", "* text" or "+ text" (but not "**bold**") ──
  // Multi-line: each marker line is its own item; wrapped lines under an item
  // stay as its continuation (the streamer holds them into one entry). The
  // marker is "-" at column 0, and an indented marker is one level of nesting.
  const ulFirst = firstLine.match(/^([-*+])\s+/);
  if (ulFirst && !text.startsWith("**")) {
    return renderListItems(splitListItems(text) ?? [], theme, width);
  }

  // ── Ordered list: 1. text, 2. text, etc. ──
  const olFirst = firstLine.match(/^(\d+)\.\s+/);
  if (olFirst) {
    return renderListItems(splitListItems(text) ?? [], theme, width);
  }

  // ── Default: inline formatting only ──
  return (
    <Text>
      <Inline text={text} theme={theme} width={width} />
    </Text>
  );
}

export default React.memo(MarkdownText);
