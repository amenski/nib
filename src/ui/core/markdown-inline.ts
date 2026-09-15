/**
 * Nib inline markdown parser (pure, no React).
 *
 * Parses inline formatting into segments:
 * **bold**, *italic*, _italic_, ***bold italic***, `code`, ~~strike~~,
 * [text](url) → "text (url)".
 *
 * Unclosed delimiters degrade to literal text (**unclosed → "**unclosed").
 * The tree building lives in scanInline (see there for nesting and flanking).
 */

export type Format = "bold" | "italic" | "code" | "strike";

export interface Segment {
  text: string;
  formats: Format[];
}

type Node =
  | { kind: "text"; text: string; code?: boolean }
  | { kind: "fmt"; formats: Format[]; children: Node[] };

type FmtNode = Extract<Node, { kind: "fmt" }>;

interface OpenDelim {
  char: string;
  /** Run length this delimiter represents (1 italic, 2 bold, 3 both, 2 strike). */
  count: number;
  /** The raw marker characters (e.g. "**") — restored if the span never closes. */
  literal: string;
  /** Index into `nodes` of this opener's fmt placeholder. */
  nodeIndex: number;
  node: FmtNode;
}

export function parseInline(input: string): Segment[] {
  const { nodes, stack } = scanInline(input);

  // Unclosed openers at end-of-input: their markers were consumed at open
  // time, so restore them as literal text. The content between them stayed
  // as plain siblings, so **unclosed renders exactly "**unclosed".
  for (const d of stack) {
    nodes[d.nodeIndex] = { kind: "text", text: d.literal };
  }

  return flatten(nodes);
}

/**
 * True when `input` ends mid-span: an emphasis/strike opener (`**`, `*`,
 * `~~`) is still open, or a backtick run is unmatched. The streaming layer
 * (core/stream-blocks.ts) holds such a line back so the span can rejoin with
 * its closer on a later line. Reuses the parser's own flanking rules, so list
 * bullets ("* item"), arithmetic ("2 * 3 * 4") and snake_case ("foo_bar")
 * never false-positive. An odd total backtick count is OR'd in because an
 * unclosed code span degrades to literal backticks — it leaves no stack entry.
 */
export function inlineSpanOpen(input: string): boolean {
  if (scanInline(input).stack.length > 0) return true;
  const backticks = (input.match(/`/g) ?? []).length;
  return backticks % 2 === 1;
}

/**
 * Single left-to-right scan over a node tree with an opener stack, instead of
 * the old flat pattern scan that rejected any overlapping match:
 * - Code spans are atomic — their content is never scanned for emphasis or
 *   links, so `[x](y)` or ** inside backticks stays verbatim.
 * - Emphasis nests: **bold *italic* inside** wraps the inner span, and a code
 *   span inside bold picks up the bold format (**install `npm i -g x`**).
 * - ***both*** renders as bold+italic on one span.
 * - CommonMark-style flanking: `2 * 3 * 4` and `foo_bar_baz` stay literal,
 *   because a `*`/`_` between word characters can neither open nor close.
 */
function scanInline(input: string): { nodes: Node[]; stack: OpenDelim[] } {
  const nodes: Node[] = [];
  const stack: OpenDelim[] = [];
  const n = input.length;
  let i = 0;

  while (i < n) {
    const ch = input[i];

    // ── Code span: a backtick run of length k closes with the same-length
    // run. Content is atomic — never scanned for emphasis or links, so
    // `**bold**` or `[x](y)` inside backticks stays verbatim.
    if (ch === "`") {
      let run = 0;
      while (i + run < n && input[i + run] === "`") run++;
      const close = findBacktickClose(input, i + run, run);
      if (close !== -1) {
        nodes.push({ kind: "text", text: input.slice(i + run, close), code: true });
        i = close + run;
        continue;
      }
      nodes.push({ kind: "text", text: "`".repeat(run) });
      i += run;
      continue;
    }

    // ── Link: [text](url) → "text (url)". Only reached on non-code text,
    // because code spans were consumed atomically above.
    if (ch === "[") {
      const m = input.slice(i).match(/^\[([^\[\]]+)\]\(([^)\s]+)\)/);
      if (m) {
        nodes.push({ kind: "text", text: `${m[1]} (${m[2]})` });
        i += m[0].length;
        continue;
      }
    }

    // ── Emphasis / strike delimiter runs: *, _, ~ ──
    if (ch === "*" || ch === "_" || ch === "~") {
      let run = 0;
      while (i + run < n && input[i + run] === ch) run++;
      const prev = i > 0 ? input[i - 1] : "";
      const next = i + run < n ? input[i + run] : "";
      const leftFlanking =
        next !== "" &&
        !isWhitespace(next) &&
        (!isPunct(next) || prev === "" || isWhitespace(prev) || isPunct(prev));
      const rightFlanking =
        prev !== "" &&
        !isWhitespace(prev) &&
        (!isPunct(prev) || next === "" || isWhitespace(next) || isPunct(next));
      // A run that is both left- and right-flanking with no punctuation
      // involved (e.g. `_` in foo_bar_baz) can neither open nor close — the
      // CommonMark tie-break: both-flanking delimiters open only when preceded
      // by punctuation, close only when followed by it.
      const canOpen = leftFlanking && (!rightFlanking || isPunct(prev));
      const canClose = rightFlanking && (!leftFlanking || isPunct(next));

      let formats: Format[] | null = null;
      let delimCount = 0;
      if (ch === "~") {
        if (run >= 2) {
          formats = ["strike"];
          delimCount = 2;
        }
      } else if (run >= 3) {
        formats = ["bold", "italic"];
        delimCount = 3;
      } else if (run === 2) {
        formats = ["bold"];
        delimCount = 2;
      } else if (run === 1) {
        formats = ["italic"];
        delimCount = 1;
      }

      if (formats) {
        // Closing takes priority: match the innermost opener of the same char
        // and length (so **bold *italic* inside** closes italic before bold).
        if (canClose) {
          const k = findOpener(stack, ch, delimCount);
          if (k !== -1) {
            // Delimiters above the match never closed — restore their markers
            // as literal text instead of letting them vanish.
            for (let t = stack.length - 1; t > k; t--) {
              const d = stack[t];
              nodes[d.nodeIndex] = { kind: "text", text: d.literal };
            }
            const opener = stack[k];
            stack.length = k;
            opener.node.children = nodes.splice(opener.nodeIndex + 1);
            const leftover = run - delimCount;
            if (leftover > 0) nodes.push({ kind: "text", text: ch.repeat(leftover) });
            i += run;
            continue;
          }
        }
        if (canOpen) {
          const node: FmtNode = { kind: "fmt", formats, children: [] };
          nodes.push(node);
          stack.push({
            char: ch,
            count: delimCount,
            literal: ch.repeat(delimCount),
            nodeIndex: nodes.length - 1,
            node,
          });
          const leftover = run - delimCount;
          if (leftover > 0) nodes.push({ kind: "text", text: ch.repeat(leftover) });
          i += run;
          continue;
        }
      }

      nodes.push({ kind: "text", text: ch.repeat(run) });
      i += run;
      continue;
    }

    // ── Plain character ──
    nodes.push({ kind: "text", text: ch });
    i++;
  }

  return { nodes, stack };
}

const isWhitespace = (c: string): boolean => /\s/.test(c);
// CommonMark treats Unicode punctuation AND symbols as punctuation for
// flanking purposes; \p{P} + \p{S} with the u flag is the ES2018+ way.
const isPunct = (c: string): boolean => /[\p{P}\p{S}]/u.test(c);

/** Find a same-length backtick run closing a code span, or -1 if unclosed. */
function findBacktickClose(input: string, from: number, run: number): number {
  let j = from;
  while (j <= input.length - run) {
    let k = 0;
    while (j + k < input.length && input[j + k] === "`") k++;
    if (k === run) return j;
    j += Math.max(1, k);
  }
  return -1;
}

/** Innermost stack entry with the same char and count, or -1. */
function findOpener(stack: OpenDelim[], char: string, count: number): number {
  for (let k = stack.length - 1; k >= 0; k--) {
    if (stack[k].char === char && stack[k].count === count) return k;
  }
  return -1;
}

/** Flatten the node tree into leaf segments, accumulating ancestor formats. */
function flatten(nodes: Node[], inherited: Format[] = []): Segment[] {
  const segments: Segment[] = [];
  for (const node of nodes) {
    if (node.kind === "text") {
      segments.push({
        text: node.text,
        formats: node.code ? [...inherited, "code"] : inherited,
      });
    } else {
      segments.push(...flatten(node.children, [...inherited, ...node.formats]));
    }
  }
  return mergeAdjacent(segments);
}

/** Merge adjacent segments that carry identical formats. */
function mergeAdjacent(segments: Segment[]): Segment[] {
  const out: Segment[] = [];
  for (const seg of segments) {
    const last = out[out.length - 1];
    if (last && last.formats.join(",") === seg.formats.join(",")) {
      last.text += seg.text;
    } else {
      out.push({ text: seg.text, formats: [...seg.formats] });
    }
  }
  return out;
}
