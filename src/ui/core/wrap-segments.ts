import type { Segment } from "./markdown-inline.js";
import { visualLength } from "../MarkdownTable.js";

/**
 * Word-wrap parsed inline segments to `width` columns, before Ink sees them.
 *
 * Ink wraps a <Text> with wrap-ansi (`trim: false`). A break next to a styled
 * span — code, bold — keeps the space it broke at, so the wrapped row starts
 * one column to the right (measured 2026-10-10 on a real reply: rows at column
 * 3 inside a 2-column gutter). Pre-wrapping here breaks only at spaces, drops
 * the space at each break, and keeps every row within `width`, so Ink never
 * re-wraps. A "word" runs across adjacent segments until a space
 * (`a`+`b` stays whole); embedded "\n" (merged paragraphs) are hard breaks;
 * a word longer than `width` is split.
 */
export function wrapSegments(segments: Segment[], width: number): Segment[][] {
  const w = Math.max(1, width);
  const rows: Segment[][] = [[]];
  let rowWidth = 0;
  let pendingSpace: Segment | null = null;
  let word: Segment[] = [];

  const push = (seg: Segment) => {
    const row = rows[rows.length - 1]!;
    const last = row[row.length - 1];
    if (last && sameFormats(last, seg)) last.text += seg.text;
    else row.push({ text: seg.text, formats: seg.formats });
    rowWidth += visualLength(seg.text);
  };
  const newRow = () => {
    rows.push([]);
    rowWidth = 0;
    pendingSpace = null;
  };

  const flushWord = () => {
    if (word.length === 0) return;
    const parts = word;
    word = [];
    const wordWidth = parts.reduce((n, p) => n + visualLength(p.text), 0);
    const spaceWidth = pendingSpace ? visualLength(pendingSpace.text) : 0;
    if (rowWidth > 0 && rowWidth + spaceWidth + wordWidth > w) newRow();
    if (pendingSpace) push(pendingSpace);
    pendingSpace = null;
    for (const part of parts) {
      let text = part.text;
      while (visualLength(text) > w - rowWidth) {
        const room = w - rowWidth;
        if (room <= 0) {
          newRow();
          continue;
        }
        const [head, tail] = splitAtWidth(text, room);
        push({ text: head, formats: part.formats });
        newRow();
        text = tail;
      }
      if (text) push({ text, formats: part.formats });
    }
  };

  for (const seg of segments) {
    for (const token of seg.text.split(/(\n| +)/)) {
      if (token === "") continue;
      if (token === "\n") {
        flushWord();
        newRow();
      } else if (token.startsWith(" ")) {
        flushWord();
        if (rowWidth > 0) pendingSpace = { text: token, formats: seg.formats };
      } else {
        word.push({ text: token, formats: seg.formats });
      }
    }
  }
  flushWord();
  return rows;
}

function sameFormats(a: Segment, b: Segment): boolean {
  return a.formats.length === b.formats.length && a.formats.every((f, i) => f === b.formats[i]);
}

/**
 * Split text into atoms that may not be broken apart: an ANSI SGR escape (zero
 * columns) or a single character. Without this, an overlong word containing
 * colour codes could be split *inside* one (`\x1b[38;5;2` / `46m`), leaving
 * literal escape fragments on screen.
 */
const ATOM_RE = /\x1b\[[0-9;]*m|[\s\S]/g;

function atoms(text: string): string[] {
  return text.match(ATOM_RE) ?? [];
}

function splitAtWidth(text: string, room: number): [string, string] {
  const parts = atoms(text);
  let used = 0;
  let i = 0;
  for (; i < parts.length; i++) {
    const cw = visualLength(parts[i]!);
    if (used + cw > room) break;
    used += cw;
  }
  const cut = Math.max(1, i);
  return [parts.slice(0, cut).join(""), parts.slice(cut).join("")];
}
