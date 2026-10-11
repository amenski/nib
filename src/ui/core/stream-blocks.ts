/**
 * Streaming chunk → output-entry state machine (pure, no React).
 *
 * The agent streams text in arbitrary chunks. This module turns the chunk
 * stream into COMMITTED output entries while holding back what may still
 * rejoin later:
 *
 * - Inline paragraphs — an emphasis/code/strike span may close on a later
 *   streamed line (inlineSpanOpen), so the whole paragraph commits as ONE
 *   entry once closed; bold/code renders across newlines.
 * - List blocks — a wrapped item's continuation ("  text" under "- item")
 *   belongs to the same entry, so the renderer can bullet the item once and
 *   show the continuation beneath it instead of a bare literal line.
 * - Blockquote blocks — "> a\n> b" is one blockquote, so quote lines hold
 *   and commit together (the renderer draws a ▎ marker per line), and a span
 *   inside the quote can close across its lines.
 * - Fenced code blocks — content accumulates in the fence and commits as one
 *   entry at the closing fence.
 *
 * Block-enders (blank line, fence, heading, blockquote, horizontal rule) end
 * any held paragraph first — a span or list item can't cross one in CommonMark.
 * An unclosed span that never closes (e.g. literal "python **kwargs") is
 * bounded by MAX_HELD_LINES: after that many held lines the paragraph commits
 * as literal text rather than blocking the turn.
 *
 * The caller (App) applies bullets, blank-line separators, and queue batching.
 */

import { inlineSpanOpen } from "./markdown-inline.js";

/** Escape hatch: how many lines may wait for a closer before committing literal. */
export const MAX_HELD_LINES = 3;

export interface StreamBlockState {
  /** Unconsumed tail of the incoming stream (may be a partial line). */
  buffer: string;
  /** Lines of the current paragraph waiting to commit (span open or list block). */
  pending: string[];
  /** Open fenced code block: lines so far, or null when not inside a fence. */
  fence: string[] | null;
  /**
   * A blank line was just emitted after a heading (Claude Code's heading
   * separator). If the source's own next line is also blank, it is swallowed
   * so the gap stays one line rather than two.
   */
  headingBlank: boolean;
}

export function createStreamBlockState(): StreamBlockState {
  return { buffer: "", pending: [], fence: null, headingBlank: false };
}

export type LineKind =
  | "fence"
  | "blank"
  | "heading"
  | "quote"
  | "hr"
  | "item"
  | "continuation"
  | "text";

/**
 * Classify a complete line (no trailing newline). Order matters: a blockquote
 * containing a list ("> - x") is a quote; an indented line ("  - sub") is a
 * continuation of the surrounding item, not a top-level item.
 */
export function classifyLine(line: string): LineKind {
  if (line.startsWith("```")) return "fence";
  if (line.trim() === "") return "blank";
  if (/^#{1,6}\s+/.test(line)) return "heading";
  if (line.startsWith(">")) return "quote";
  if (/^[-*_]{3,}$/.test(line)) return "hr";
  if (isListItem(line)) return "item";
  if (/^\s+\S/.test(line)) return "continuation";
  return "text";
}

/** "- item", "* item", "+ item" (but not "**bold**"), "1. item", "10) item"-style. */
export function isListItem(line: string): boolean {
  return /^([-*+])\s+/.test(line) || /^(\d+)\.\s+/.test(line);
}

/**
 * True when the paragraph so far reads as one list block: the first line is
 * an item and every later line is another item or an indented continuation.
 * A lone item line is a (vacuous) list block — the streamer holds it in case
 * a continuation follows on the next line; a flush site commits it alone.
 */
export function isListBlock(lines: string[]): boolean {
  if (lines.length === 0 || !isListItem(lines[0])) return false;
  for (let i = 1; i < lines.length; i++) {
    const kind = classifyLine(lines[i]);
    if (kind !== "item" && kind !== "continuation") return false;
  }
  return true;
}

/**
 * True when the paragraph so far reads as one blockquote: the first line is
 * a quote and every later line is another quote or an indented continuation
 * (CommonMark lazy continuation inside the quote). A lone quote line is a
 * (vacuous) quote block — the streamer holds it in case another quote line
 * follows; a flush site commits it alone. A plain text line does NOT join:
 * in a stream we can't know whether it lazily continues the quote or starts
 * a new paragraph, and merging it would swallow the following paragraph.
 */
export function isQuoteBlock(lines: string[]): boolean {
  if (lines.length === 0 || classifyLine(lines[0]) !== "quote") return false;
  for (let i = 1; i < lines.length; i++) {
    const kind = classifyLine(lines[i]);
    if (kind !== "quote" && kind !== "continuation") return false;
  }
  return true;
}

/** True when the paragraph should wait for more lines before committing. */
export function paragraphShouldHold(lines: string[]): boolean {
  if (inlineSpanOpen(lines.join("\n"))) return true;
  return isListBlock(lines) || isQuoteBlock(lines);
}

export interface StreamBlockResult {
  /** Committed entries: paragraphs, blank lines, completed fence blocks. */
  lines: string[];
  state: StreamBlockState;
  /**
   * Live-tail preview: the held paragraph (if any) plus the partial buffer,
   * or the open fence plus the partial buffer. No bullet — the caller adds it.
   */
  activeLine: string;
}

/**
 * Feed one streamed chunk through the state machine.
 *
 * Complete lines (those followed by a newline inside the chunk) are
 * classified and either committed or held; the partial tail stays in
 * `state.buffer` for the next call.
 */
export function streamTextChunk(prev: StreamBlockState, chunk: string): StreamBlockResult {
  const state: StreamBlockState = {
    buffer: prev.buffer + chunk,
    pending: [...prev.pending],
    fence: prev.fence ? [...prev.fence] : null,
    headingBlank: prev.headingBlank,
  };
  const lines: string[] = [];

  const flushPending = () => {
    if (state.pending.length === 0) return;
    const block = state.pending.join("\n");
    state.pending = [];
    lines.push(block);
    // Claude Code separates a heading from what follows with one blank line.
    // It is emitted here, at the commit site, and not while the heading is
    // still held: a heading waiting on a closing inline span must not print
    // its separator above the text that closes it.
    if (classifyLine(block.split("\n")[0]!) === "heading") {
      lines.push("");
      state.headingBlank = true;
    }
  };

  const rawLines = state.buffer.split("\n");
  let consumed = 0;
  for (let i = 0; i < rawLines.length - 1; i++) {
    const line = rawLines[i];
    const kind = classifyLine(line);

    // A code fence boundary ends any held paragraph — a span cannot continue
    // into a fence. Fence content accumulates; the whole block commits at the
    // closing fence.
    if (kind === "fence") {
      flushPending();
      if (state.fence) {
        state.fence.push(line);
        lines.push(state.fence.join("\n"));
        state.fence = null;
      } else {
        state.fence = [line];
      }
      consumed = i + 1;
      continue;
    }

    if (state.fence) {
      state.fence.push(line);
      consumed = i + 1;
      continue;
    }

    // Blank line = paragraph boundary. Commit any held paragraph (an unclosed
    // span renders as literal markers — a span can't cross a blank line in
    // CommonMark) and pass the blank through for spacing. Exception: the blank
    // immediately after a heading is the one the heading separator already
    // contributed, so it is swallowed to keep a single blank line.
    if (kind === "blank") {
      flushPending();
      if (state.headingBlank) {
        state.headingBlank = false;
      } else {
        lines.push("");
      }
      consumed = i + 1;
      continue;
    }
    state.headingBlank = false;

    // Headings, blockquotes and rules are their own blocks and may interrupt a
    // paragraph, so any held lines commit before this line joins a new one.
    // Exception: a ">" line CONTINUING a held quote block is not an interrupt —
    // "> a\n> b" is ONE blockquote, so the new line joins the held entry
    // instead of flushing it.
    if (kind === "heading" || kind === "hr" || (kind === "quote" && !isQuoteBlock(state.pending))) {
      flushPending();
    }

    // A held LIST block (its first line is an item and everything so far is an
    // item/continuation) is complete the moment a non-item, non-continuation
    // line arrives — a following paragraph must NOT merge into the list entry.
    // Exception: when an inline span is still open in the held block (e.g.
    // "- **bold"), the new line may close it and belongs to the same
    // paragraph, so let it join (CommonMark lazy continuation).
    if (
      state.pending.length > 0 &&
      isListBlock(state.pending) &&
      kind !== "item" &&
      kind !== "continuation" &&
      !inlineSpanOpen(state.pending.join("\n"))
    ) {
      flushPending();
    }

    // A held QUOTE block (its first line is a quote and everything so far is a
    // quote/continuation) is complete the moment a non-quote line arrives — a
    // following paragraph must NOT merge into the quote. Same span-open
    // exception as the list case, so "> **bold" may still close on the next
    // streamed line.
    if (
      state.pending.length > 0 &&
      isQuoteBlock(state.pending) &&
      kind !== "quote" &&
      kind !== "continuation" &&
      !inlineSpanOpen(state.pending.join("\n"))
    ) {
      flushPending();
    }

    // Append to the current paragraph, then hold while a span is still open
    // or the paragraph is a list/quote block (its closer / continuation may
    // arrive on a later streamed line). The whole paragraph commits as ONE
    // entry. A heading whose inline span is still open ("## **bold") is held
    // the same way; flushPending recognises it by its first line and emits the
    // heading separator at that later commit.
    state.pending.push(line);
    if (paragraphShouldHold(state.pending) && state.pending.length < MAX_HELD_LINES) {
      consumed = i + 1;
      break;
    }
    flushPending();
    consumed = i + 1;
  }

  state.buffer = rawLines.slice(consumed).join("\n");

  let activeLine: string;
  if (state.fence) {
    activeLine =
      state.fence.join("\n") + (state.buffer ? "\n" + state.buffer : "");
  } else {
    const held = state.pending.length > 0 ? state.pending.join("\n") : "";
    activeLine = held ? (state.buffer ? held + "\n" + state.buffer : held) : state.buffer;
  }

  return { lines, state, activeLine };
}
