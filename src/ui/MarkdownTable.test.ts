import React from "react";
import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import MarkdownTable from "./MarkdownTable.js";
import { stripAnsi } from "./test-helpers.js";
import {
  visualWidth,
  visualLength,
  parseTable,
  isTableBlock,
  wrapCell,
  renderTable,
} from "./MarkdownTable.js";

describe("visualWidth", () => {
  it("returns 1 for ASCII characters", () => {
    expect(visualWidth("a")).toBe(1);
    expect(visualWidth("1")).toBe(1);
    expect(visualWidth(" ")).toBe(1);
  });

  it("returns 2 for CJK characters", () => {
    expect(visualWidth("你")).toBe(2);
    expect(visualWidth("好")).toBe(2);
  });

  it("returns 2 for fullwidth forms", () => {
    expect(visualWidth("\uff21")).toBe(2);
  });

  it("returns 0 for zero-width characters", () => {
    expect(visualWidth("\u200d")).toBe(0);
    expect(visualWidth("\ufe0f")).toBe(0);
  });
});

describe("visualLength", () => {
  it("computes visual length for mixed text", () => {
    expect(visualLength("abc")).toBe(3);
    expect(visualLength("你好")).toBe(4);
    expect(visualLength("a你b")).toBe(4);
  });

  it("does not count ANSI SGR sequences as columns (2026-10-11)", () => {
    // Every replayed entry carries colour codes: a dim tool result, a
    // reasoning echo, a diff. Counting the escapes made those lines measure
    // ~15 columns wider than they draw, so the wrappers broke them rows early.
    const dim = "\x1b[38;5;246mhello world\x1b[0m";
    expect(visualLength(dim)).toBe(11);
    expect(visualLength(`\x1b[1m\x1b[38;5;231mabc\x1b[22m\x1b[39m`)).toBe(3);
    expect(visualLength("你好")).toBe(visualLength("\x1b[2m你好\x1b[0m"));
  });
});

describe("isTableBlock", () => {
  it("detects a valid table", () => {
    const text = "| a | b |\n|----|----|\n| 1 | 2 |";
    expect(isTableBlock(text)).toBe(true);
  });

  it("returns false for non-table text", () => {
    expect(isTableBlock("hello world")).toBe(false);
    expect(isTableBlock("| just | pipes |")).toBe(false);
  });

  it("returns false for single line", () => {
    expect(isTableBlock("| a | b |")).toBe(false);
  });
});

describe("parseTable", () => {
  it("parses headers and rows", () => {
    const text = "| Name | Value |\n|------|-------|\n| foo  | 42    |";
    const result = parseTable(text);
    expect(result).not.toBeNull();
    expect(result!.headers).toEqual(["Name", "Value"]);
    expect(result!.rows).toEqual([["foo", "42"]]);
  });

  it("detects alignment", () => {
    const text = "| L | C | R |\n|:---|:---:|---:|\n| a | b | c |";
    const result = parseTable(text);
    expect(result!.alignments).toEqual(["left", "center", "right"]);
  });

  it("handles empty cells", () => {
    const text = "| a | | c |\n|---|---|\n| 1 | | 3 |";
    const result = parseTable(text);
    expect(result!.rows[0]).toEqual(["1", "", "3"]);
  });

  it("returns null for non-table input", () => {
    expect(parseTable("not a table")).toBeNull();
  });

  it("handles tables without trailing pipes on all lines", () => {
    const text = "| a | b |\n|---|---|\n| 1 | 2 |";
    const result = parseTable(text);
    expect(result).not.toBeNull();
    expect(result!.headers).toEqual(["a", "b"]);
  });
});

describe("wrapCell", () => {
  it("returns single element for text that fits", () => {
    expect(wrapCell("hello", 10)).toEqual(["hello"]);
  });

  it("wraps at space when past threshold", () => {
    const result = wrapCell("hello world foo bar", 12);
    expect(visualLength(result[0])).toBeLessThanOrEqual(12);
  });

  it("force-breaks when no space available", () => {
    const result = wrapCell("abcdefghijklmnop", 5);
    expect(result.every((l) => visualLength(l) <= 5)).toBe(true);
  });

  it("returns empty string array for empty input", () => {
    expect(wrapCell("", 10)).toEqual([""]);
  });
});

describe("renderTable (simple ASCII)", () => {
  it("renders a simple table with box-drawing borders", () => {
    const text = "| Name | Age |\n|------|-----|\n| Alice | 30 |\n| Bob | 25 |";
    const result = renderTable(text, 80);
    expect(result).not.toBeNull();
    expect(result).toContain("Alice");
    expect(result).toContain("Bob");
    expect(result).toContain("Name");
    expect(result).toContain("Age");
    expect(result).toContain("\u250c");
    expect(result).toContain("\u2510");
    expect(result).toContain("\u2514");
    expect(result).toContain("\u2518");
    expect(result).toContain("\u2502");
    expect(result).toContain("\u2500");
  });

  it("renders table with consistent column widths", () => {
    const text = "| A | B |\n|---|---|\n| x | yy |\n| zzz | w |";
    const result = renderTable(text, 80);
    const lines = result!.split("\n");
    const dataLine = lines[1];
    expect(dataLine).toContain("A");
    expect(dataLine).toContain("B");
  });
});

describe("renderTable (CJK + ASCII mix)", () => {
  it("aligns columns with mixed CJK and ASCII text", () => {
    const text = "| 名称 | Value |\n|------|-------|\n| 苹果 | 100 |\n| 橘子 | 50 |";
    const result = renderTable(text, 80);
    expect(result).not.toBeNull();
    expect(result).toContain("名称");
    expect(result).toContain("Value");
    expect(result).toContain("苹果");
    expect(result).toContain("100");
    expect(result).toContain("橘子");
    expect(result).toContain("50");

    const lines = result!.split("\n");
    for (const line of lines) {
      if (line.includes("│")) {
        const parts = line.split("│");
        for (const part of parts) {
          const trimmed = part.trim();
          for (let i = 1; i < lines.length; i++) {
            if (lines[i].includes("│")) {
              const otherParts = lines[i].split("│");
              for (let j = 0; j < Math.min(parts.length, otherParts.length); j++) {
                if (parts[j].trim() && otherParts[j].trim()) {
                  expect(visualLength(parts[j])).toBe(visualLength(otherParts[j]));
                }
              }
            }
          }
          break;
        }
        break;
      }
    }
  });

  it("handles CJK headers and ASCII data", () => {
    const text = "| 序号 | 姓名 |\n|------|------|\n| 1 | Alice |\n| 2 | Bob |";
    const result = renderTable(text, 80);
    expect(result).not.toBeNull();

    const lines = result!.split("\n");
    const headerLine = lines[1];
    const dataLine = lines[3];

    expect(headerLine).toContain("序号");
    expect(headerLine).toContain("姓名");
    expect(dataLine).toContain("1");
    expect(dataLine).toContain("Alice");
  });
});

describe("renderTable (compression)", () => {
  it("compresses tables wider than terminal", () => {
    const text =
      "| FirstColumnName | SecondColumnName | ThirdColumnName | FourthColumnName |\n" +
      "|-----------------|------------------|-----------------|------------------|\n" +
      "| data1 | data2 | data3 | data4 |\n" +
      "| moreAAAAAAAAAAAA | moreBBBBBBBBBBBB | moreCCCCCCCCCCCC | moreDDDDDDDDDDDD |";
    const wideResult = renderTable(text, 80);
    const narrowResult = renderTable(text, 50);
    expect(wideResult).not.toBeNull();
    expect(narrowResult).not.toBeNull();
    const wideLen = wideResult!.split("\n")[0].length;
    const narrowLen = narrowResult!.split("\n")[0].length;
    expect(narrowLen).toBeLessThan(wideLen);
  });

  it("never exceeds the specified width", () => {
    const text =
      "| Col1 | Col2 | Col3 | Col4 | Col5 |\n" +
      "|------|------|------|------|------|\n" +
      "| data1 | data2 | data3 | data4 | data5 |";
    const result = renderTable(text, 50);
    expect(result).not.toBeNull();
    for (const line of result!.split("\n")) {
      expect(visualLength(line)).toBeLessThanOrEqual(50);
    }
  });
});

describe("renderTable (label column heuristic)", () => {
  it("preserves narrow label columns", () => {
    const text = "| ID | Description |\n|---|---|\n| 1 | Short |\n| 2 | Also short |";
    const result = renderTable(text, 80);
    expect(result).not.toBeNull();
    const lines = result!.split("\n");
    const headerLine = lines[1];
    const parts = headerLine.split("│");
    const idPart = parts[1];
    expect(visualLength(idPart)).toBeLessThanOrEqual(2 + 2 + 2);
  });
});

describe("renderTable (empty cells)", () => {
  it("handles empty cells gracefully", () => {
    const text = "| A | B | C |\n|---|---|---|\n| | x | |\n| y | | z |";
    const result = renderTable(text, 80);
    expect(result).not.toBeNull();
    expect(result).toContain("x");
    expect(result).toContain("y");
    expect(result).toContain("z");
  });
});

describe("cells render as text, not markdown (2026-10-10)", () => {
  const text = "| Port | Value |\n|---|---|\n| **all** `MediaStore` | [docs](https://x.y) |";

  it("strips inline markers, using the renderer's own parser", () => {
    const parsed = parseTable(text)!;
    expect(parsed.headers).toEqual(["Port", "Value"]);
    expect(parsed.rows[0]).toEqual(["all MediaStore", "docs (https://x.y)"]);
  });

  it("sizes columns from the stripped text", () => {
    // Both widths stay under the width that would trigger filling, so the
    // column keeps its natural size and the padding is readable directly.
    const rendered = renderTable("| tag | n |\n|---|---|\n| **all** | 1 |", 80)!;
    expect(rendered).not.toContain("*");
    const rows = rendered.split("\n");
    expect(rows[1]!.split("│")[1]).toBe(" tag ");
    // " all ", not " **all** ": the column is as wide as the text drawn in it.
    expect(rows.find((r) => r.includes("all"))!.split("│")[1]).toBe(" all ");
  });

  it("leaves text that is not markup alone", () => {
    const snake = "| snake_case_name | a*b |\n|---|---|\n| x | y |";
    expect(parseTable(snake)!.headers).toEqual(["snake_case_name", "a*b"]);
  });
});

describe("table colour (2026-10-10)", () => {
  it("dims the borders only, leaving the cells at normal contrast", () => {
    // A whole-table dim made the content hard to read; the border characters
    // are what should recede. A sentinel `fg` makes the assertion exact — the
    // component's only colouring call is the one under test.
    const theme = {
      colorEnabled: true,
      theme: { textDim: 246 },
      fg: (_color: number, s: string) => `[dim:${s}]`,
    };
    const table = React.createElement(
      MarkdownTable,
      { theme, children: "| Component | Status |\n|---|---|\n| CarouselStorePort | done |" },
    );
    const frame = stripAnsi(render(table).lastFrame() ?? "");

    expect(frame).toContain("[dim:┌]");
    expect(frame).toContain("[dim:│]");
    expect(frame).toContain("[dim:─]");
    // The content is drawn as-is: no dim wrapper around a cell's text.
    expect(frame).not.toContain("[dim:C]");
    expect(frame).not.toContain("[dim:CarouselStorePort]");
  });

  it("bolds the header row and leaves the body plain (2026-10-11)", () => {
    const theme = { colorEnabled: true, theme: { textDim: 246 }, fg: (_c: number, s: string) => s };
    const table = React.createElement(
      MarkdownTable,
      { theme, children: "| Component | Status |\n|---|---|\n| CarouselStorePort | done |" },
    );
    const frame = render(table).lastFrame() ?? "";
    const rows = frame.split("\n").filter((r) => r.includes("Component") || r.includes("Carousel"));
    // Bold, built as an escape by the renderer (Ink's gradient-free text has no
    // attribute-only prop through this path), opens before the header's padding.
    expect(rows[0]).toContain("\x1b[1m");
    expect(stripAnsi(rows[0]!)).toContain("Component");
    expect(rows[1]).not.toContain("\x1b[1m");
  });
});
