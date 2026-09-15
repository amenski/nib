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
  type Segment,
} from "./core/markdown-inline.js";
import SyntaxHighlighter, { detectLanguage, type Language } from "./SyntaxHighlighter.js";
import MarkdownTable, { isTableBlock } from "./MarkdownTable.js";

// Re-exported so callers/tests importing from "./MarkdownText.js" keep working
// after the parser moved to core/markdown-inline.ts.
export { parseInline, inlineSpanOpen };
export type { Segment };

interface MarkdownTextProps {
  children: string;
  /** Optional theme context for syntax highlighting and colors */
  theme?: {
    colorEnabled: boolean;
    theme: {
      syntax: any;
      text: number;
      textDim: number;
      textBright: number;
      textInverse: number;
    };
    syntax: (key: string, text: string) => string;
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
  if (segment.formats.includes("code")) props.dimColor = true;

  return <Text {...props}>{segment.text}</Text>;
}

/** Render a parsed inline string (which may contain embedded newlines). */
function Inline({ text, theme }: { text: string; theme?: MarkdownTextProps["theme"] }) {
  const segs = parseInline(text);
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
  const langLabel = language !== "text" ? language : (info || "code");

  const dim = theme?.dim ?? ((s: string) => `\x1b[2m${s}\x1b[0m`);
  const fg = theme?.fg;

  if (!theme || !theme.colorEnabled || language === "text") {
    // Fallback: plain dim text
    const header = dim(`  ── ${langLabel} ──`);
    const body = content.map((l) => dim(`  ${l}`)).join("\n");
    return <Text>{header}{"\n"}{body}</Text>;
  }

  // Use syntax highlighting
  const joinedCode = content.join("\n");

  return (
    <Text>
      <Text dimColor>{dim(`  ── ${langLabel} ──`)}</Text>
      {"\n"}
      {content.length > 0 && (
        <SyntaxHighlighter
          code={joinedCode}
          language={language}
          theme={theme as any}
        />
      )}
    </Text>
  );
}

// ── List block parsing ──

interface ListItem {
  /** Marker: the "-"/"*" char for unordered, the number for ordered. */
  marker: string;
  /** Item text, including any wrapped continuation lines (kept verbatim). */
  content: string;
}

/**
 * Split a (possibly multi-line) entry into list items. A line matching
 * `itemRe` starts a new item; any other line is a continuation of the current
 * item and is kept verbatim (its leading indent included), so a wrapped item
 * reads as markdown wrote it. Returns null when the first line isn't an item.
 */
function splitListItems(text: string, itemRe: RegExp): ListItem[] | null {
  const items: ListItem[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(itemRe);
    if (m) {
      items.push({ marker: m[1], content: m[2] });
    } else if (items.length > 0) {
      items[items.length - 1].content += "\n" + line;
    } else {
      return null;
    }
  }
  return items;
}

// ── Main Markdown Renderer ──

function MarkdownText({ children, theme }: MarkdownTextProps) {
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
  if (text.startsWith("```")) {
    const lang = text.length > 3 ? text.slice(3).trim() : "";
    const dim = theme?.dim ?? ((s: string) => `\x1b[2m${s}\x1b[0m`);
    return <Text dimColor>{dim(lang ? `  ── ${lang} ──` : "  ── code ──")}</Text>;
  }

  // ── Table: multi-line pipe-separated with separator row ──
  if (isTableBlock(text)) {
    return <MarkdownTable theme={theme}>{text}</MarkdownTable>;
  }

  // ── Heading: #, ##, ###, etc. (first line; a merged paragraph may carry
  // continuation lines after a span closed across newlines — render the
  // remainder as plain text rather than swallowing it). ──
  const firstLine = text.split("\n")[0];
  const headingMatch = firstLine.match(/^(#{1,6})\s+(.+)$/);
  if (headingMatch) {
    const level = headingMatch[1].length;
    // Headings carry inline formatting too: "# **Bold** plan" must render the
    // bold, not a literal "**Bold**".
    const rest = text.split("\n").slice(1).join("\n");
    return (
      <Text bold={level <= 3}>
        <Inline text={headingMatch[2]} theme={theme} />
        {rest && (
          <>
            {"\n"}
            <Inline text={rest} theme={theme} />
          </>
        )}
      </Text>
    );
  }

  // ── Horizontal rule: ---, ***, ___ (3+ chars) ──
  if (/^[-*_]{3,}$/.test(text.trim())) {
    const dim = theme?.dim ?? ((s: string) => `\x1b[2m${s}\x1b[0m`);
    return <Text dimColor>{dim("─".repeat(48))}</Text>;
  }

  // ── Blockquote: > text (one or more lines) ──
  // A multi-line entry arrives when the streamer held a quote paragraph (e.g.
  // a span closed across its lines); each line gets its own ▎ marker, and a
  // line without ">" is a lazy continuation shown as-is.
  if (text.startsWith(">")) {
    const dim = theme?.dim ?? ((s: string) => `\x1b[2m${s}\x1b[0m`);
    return (
      <Text>
        {text.split("\n").map((raw, i) => (
          <Fragment key={i}>
            {i > 0 && "\n"}
            <Text dimColor>{dim("▎")}</Text>{" "}
            <Inline text={raw.startsWith(">") ? raw.replace(/^>\s?/, "") : raw} theme={theme} />
          </Fragment>
        ))}
      </Text>
    );
  }

  // ── Unordered list: "- text" or "* text" (but not "**bold**") ──
  // Multi-line: each "- " line is its own bulleted item; wrapped lines under
  // an item stay as its continuation (the streamer holds them into one entry).
  const ulFirst = firstLine.match(/^([-*])\s+(.+)$/);
  if (ulFirst && !text.startsWith("**")) {
    const items = splitListItems(text, /^([-*])\s+(.+)$/) ?? [];
    const dim = theme?.dim ?? ((s: string) => `\x1b[2m${s}\x1b[0m`);
    return (
      <Text>
        {items.map((item, i) => (
          <Fragment key={i}>
            {i > 0 && "\n"}
            <Text dimColor>{dim(" •")}</Text>{" "}
            <Inline text={item.content} theme={theme} />
          </Fragment>
        ))}
      </Text>
    );
  }

  // ── Ordered list: 1. text, 2. text, etc. ──
  const olFirst = firstLine.match(/^(\d+)\.\s+(.+)$/);
  if (olFirst) {
    const items = splitListItems(text, /^(\d+)\.\s+(.+)$/) ?? [];
    const dim = theme?.dim ?? ((s: string) => `\x1b[2m${s}\x1b[0m`);
    return (
      <Text>
        {items.map((item, i) => (
          <Fragment key={i}>
            {i > 0 && "\n"}
            <Text dimColor>{dim(` ${item.marker}.`)}</Text>{" "}
            <Inline text={item.content} theme={theme} />
          </Fragment>
        ))}
      </Text>
    );
  }

  // ── Default: inline formatting only ──
  return (
    <Text>
      <Inline text={text} theme={theme} />
    </Text>
  );
}

export default React.memo(MarkdownText);
