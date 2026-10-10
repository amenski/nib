import React from "react";
import { Text } from "ink";

const BOX = {
  tl: "\u250C", tr: "\u2510", bl: "\u2514", br: "\u2518",
  hd: "\u252C", hu: "\u2534", vl: "\u251C", vr: "\u2524",
  cr: "\u253C", hz: "\u2500", vt: "\u2502",
} as const;

interface MarkdownTableProps {
  children: string;
  width?: number;
  theme?: {
    fg: (color: number, text: string) => string;
    theme: { textDim: number };
  };
}

interface ParsedTable {
  headers: string[];
  alignments: ("left" | "center" | "right")[];
  rows: string[][];
}

export function visualWidth(ch: string): number {
  const cp = ch.codePointAt(0);
  if (cp === undefined) return 0;

  if (cp === 0x200D) return 0;
  if (cp >= 0xFE00 && cp <= 0xFE0F) return 0;
  if (cp >= 0x0300 && cp <= 0x036F) return 0;

  if (
    (cp >= 0x1100 && cp <= 0x115F) ||
    (cp >= 0x2E80 && cp <= 0xA4CF) ||
    (cp >= 0xAC00 && cp <= 0xD7A3) ||
    (cp >= 0xF900 && cp <= 0xFAFF) ||
    (cp >= 0xFE10 && cp <= 0xFE6F) ||
    (cp >= 0xFF01 && cp <= 0xFFE6) ||
    (cp >= 0x1F004 && cp <= 0x1F0CF) ||
    (cp >= 0x1F200 && cp <= 0x1F251) ||
    (cp >= 0x1F300 && cp <= 0x1FAFF) ||
    (cp >= 0x2600 && cp <= 0x27BF) ||
    (cp >= 0x20000 && cp <= 0x3FFFD)
  ) {
    return 2;
  }

  return 1;
}

export function visualLength(str: string): number {
  let len = 0;
  for (const ch of str) {
    len += visualWidth(ch);
  }
  return len;
}

function splitCells(line: string): string[] {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) return [];
  return trimmed.slice(1, -1).split("|").map((c) => c.trim());
}

function parseAlignments(line: string, colCount: number): ("left" | "center" | "right")[] {
  const cells = splitCells(line);
  const result: ("left" | "center" | "right")[] = [];
  for (let i = 0; i < colCount; i++) {
    const cell = cells[i] || "";
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    if (left && right) result.push("center");
    else if (right) result.push("right");
    else result.push("left");
  }
  return result;
}

const sepRe = /^\|(\s*:?-+:?\s*\|)+\s*$/;

export function isTableBlock(text: string): boolean {
  const lines = text.split("\n").filter((l) => l.trim());
  if (lines.length < 2) return false;
  if (!lines[0].trimStart().startsWith("|")) return false;
  return lines.some((l, i) => i > 0 && sepRe.test(l.trim()));
}

export function parseTable(text: string): ParsedTable | null {
  const lines = text.split("\n").filter((l) => l.trim());
  if (lines.length < 2) return null;

  const headers = splitCells(lines[0]);
  if (headers.length === 0) return null;

  let sepIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (sepRe.test(lines[i].trim())) {
      sepIdx = i;
      break;
    }
  }
  if (sepIdx === -1) return null;

  const alignments = parseAlignments(lines[sepIdx], headers.length);
  const rows = lines.slice(sepIdx + 1)
    .map(splitCells)
    .filter((row) => row.some((c) => c !== ""));

  return { headers, alignments, rows };
}

export function wrapCell(text: string, width: number): string[] {
  if (visualLength(text) <= width) return [text];

  const lines: string[] = [];
  let remaining = text;

  while (visualLength(remaining) > width) {
    const threshold = Math.floor(width / 3);
    let lastSpaceIdx = -1;
    let lastSpaceVPos = 0;
    let vPos = 0;

    for (let i = 0; i < remaining.length; i++) {
      const vw = visualWidth(remaining[i]);
      if (vPos + vw > width) break;
      if (remaining[i] === " ") {
        lastSpaceIdx = i;
        lastSpaceVPos = vPos;
      }
      vPos += vw;
    }

    if (lastSpaceIdx >= 0 && lastSpaceVPos >= threshold) {
      lines.push(remaining.slice(0, lastSpaceIdx).trimEnd());
      remaining = remaining.slice(lastSpaceIdx + 1).trimStart();
    } else {
      let sliceIdx = 0;
      let sliceVPos = 0;
      for (let i = 0; i < remaining.length; i++) {
        const vw = visualWidth(remaining[i]);
        if (sliceVPos + vw > width) break;
        sliceVPos += vw;
        sliceIdx = i + 1;
      }
      if (sliceIdx === 0) sliceIdx = 1;
      lines.push(remaining.slice(0, sliceIdx));
      remaining = remaining.slice(sliceIdx).trimStart();
    }
  }

  if (remaining.length > 0) {
    lines.push(remaining);
  }

  return lines.length > 0 ? lines : [""];
}

function sum(arr: number[]): number {
  return arr.reduce((a, b) => a + b, 0);
}

function computeColumnWidths(
  headers: string[],
  rows: string[][],
  maxWidth: number,
): number[] {
  const colCount = headers.length;
  const minWidth = 3;

  const natural = headers.map((h, c) => {
    let max = visualLength(h);
    for (const row of rows) {
      const val = row[c] || "";
      max = Math.max(max, visualLength(val));
    }
    return Math.max(minWidth, max);
  });

  const frozen = natural.map((n) => n <= 12);
  const totalNatural = 1 + 3 * colCount + sum(natural);

  if (totalNatural <= maxWidth) {
    return growToFill(natural, frozen, minWidth, maxWidth);
  }

  return compressToFit(natural, frozen, minWidth, maxWidth);
}

function growToFill(
  natural: number[],
  frozen: boolean[],
  minWidth: number,
  maxWidth: number,
): number[] {
  const colCount = natural.length;
  const currentTotal = 1 + 3 * colCount + sum(natural);
  const slack = maxWidth - currentTotal;

  if (slack <= 0) return natural.slice();

  const growable = natural.map((_, i) => !frozen[i]);
  const growableCount = growable.filter(Boolean).length;

  if (growableCount === 0) return natural.slice();

  const widths = natural.slice();
  const extraPerCol = Math.floor(slack / growableCount);
  let remainder = slack % growableCount;

  for (let i = 0; i < colCount; i++) {
    if (growable[i]) {
      widths[i] += extraPerCol;
      if (remainder > 0) {
        widths[i] += 1;
        remainder--;
      }
    }
  }

  return widths;
}

function compressToFit(
  natural: number[],
  frozen: boolean[],
  minWidth: number,
  maxWidth: number,
): number[] {
  const colCount = natural.length;
  const requiredMin = 1 + 3 * colCount + sum(frozen.map((f, i) => f ? natural[i] : minWidth));
  const compressible = natural.map((_, i) => !frozen[i]);

  const compressibleCount = compressible.filter(Boolean).length;

  if (requiredMin > maxWidth || compressibleCount === 0) {
    const widths = natural.slice();
    for (let i = 0; i < colCount; i++) {
      if (compressible[i]) widths[i] = minWidth;
    }
    return widths;
  }

  const frozenWidth = sum(frozen.map((f, i) => (f ? natural[i] : 0)));
  const currentCompressible = sum(compressible.map((c, i) => (c ? natural[i] : 0)));
  const availableForCompressible = maxWidth - (1 + 3 * colCount + frozenWidth);

  const deficit = currentCompressible - availableForCompressible;

  if (deficit <= 0) return natural.slice();

  const widths = natural.slice();
  let remaining = deficit;

  for (let i = 0; i < colCount; i++) {
    if (!compressible[i]) continue;
    const excess = natural[i] - minWidth;
    const proportional = Math.round((excess / currentCompressible) * deficit);
    const reduction = Math.min(excess, proportional);
    widths[i] -= reduction;
    remaining -= reduction;
  }

  for (let i = 0; i < colCount && remaining > 0; i++) {
    if (!compressible[i]) continue;
    if (widths[i] > minWidth) {
      const take = Math.min(widths[i] - minWidth, remaining);
      widths[i] -= take;
      remaining -= take;
    }
  }

  return widths;
}

function padText(text: string, width: number, align: "left" | "center" | "right"): string {
  const v = visualLength(text);
  const deficit = width - v;
  if (deficit <= 0) return text;

  const left = align === "right" ? deficit : align === "center" ? Math.floor(deficit / 2) : 0;
  const right = deficit - left;

  return " ".repeat(left) + text + " ".repeat(right);
}

function renderRow(
  cols: string[],
  widths: number[],
  alignments: ("left" | "center" | "right")[],
  start: string,
  sep: string,
  end: string,
): string {
  const parts = cols.map((c, i) => {
    const a = alignments[i] || "left";
    return ` ${padText(c, widths[i], a)} `;
  });
  return start + parts.join(sep) + end;
}

function renderBorder(
  widths: number[],
  left: string,
  mid: string,
  right: string,
): string {
  const segs = widths.map((w) => BOX.hz.repeat(w + 2));
  return left + segs.join(mid) + right;
}

function renderTableBlock(
  headers: string[],
  alignments: ("left" | "center" | "right")[],
  rows: string[][],
  widths: number[],
): string {
  const result: string[] = [];

  result.push(renderBorder(widths, BOX.tl, BOX.hd, BOX.tr));
  result.push(renderRow(headers, widths, alignments, BOX.vt, BOX.vt, BOX.vt));

  for (const row of rows) {
    result.push(renderBorder(widths, BOX.vl, BOX.cr, BOX.vr));
    result.push(renderRow(row, widths, alignments, BOX.vt, BOX.vt, BOX.vt));
  }

  result.push(renderBorder(widths, BOX.bl, BOX.hu, BOX.br));

  return result.join("\n");
}

export function renderTable(text: string, maxWidth: number): string | null {
  const parsed = parseTable(text);
  if (!parsed) return null;

  const { headers, alignments, rows } = parsed;
  const colCount = headers.length;
  const widths = computeColumnWidths(headers, rows, maxWidth);

  const wrappedRows = rows.map((row) => {
    const cellLines = row.map((cell, ci) => wrapCell(cell, widths[ci]));
    const maxLines = Math.max(1, ...cellLines.map((cl) => cl.length));
    const aligned: string[][] = [];
    for (let l = 0; l < maxLines; l++) {
      const line = cellLines.map((cl, ci) => cl[l] || "");
      aligned.push(line);
    }
    return aligned;
  });

  const result: string[] = [];

  result.push(renderBorder(widths, BOX.tl, BOX.hd, BOX.tr));
  result.push(renderRow(headers, widths, alignments, BOX.vt, BOX.vt, BOX.vt));
  result.push(renderBorder(widths, BOX.vl, BOX.cr, BOX.vr));

  for (const rowLines of wrappedRows) {
    for (const line of rowLines) {
      result.push(renderRow(line, widths, alignments, BOX.vt, BOX.vt, BOX.vt));
    }
    if (rowLines !== wrappedRows[wrappedRows.length - 1]) {
      result.push(renderBorder(widths, BOX.vl, BOX.cr, BOX.vr));
    }
  }

  result.push(renderBorder(widths, BOX.bl, BOX.hu, BOX.br));

  return result.join("\n");
}

function MarkdownTable({ children, width, theme }: MarkdownTableProps) {
  if (!children) return null;

  const maxWidth = width ?? (process.stdout.columns || 80);
  const rendered = renderTable(children, maxWidth);

  if (!rendered) return <Text>{children}</Text>;

  const dim = theme ? (s: string) => theme.fg(theme.theme.textDim, s) : ((s: string) => `\x1b[2m${s}\x1b[0m`);
  const dimmed = dim(rendered);

  return <Text>{dimmed}</Text>;
}

export default MarkdownTable;
