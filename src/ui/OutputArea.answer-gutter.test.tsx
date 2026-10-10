import React from "react";
import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import OutputArea from "./OutputArea.js";
import { BULLET_TAG, ANSWER_CONT_TAG } from "./constants.js";
import { stripAnsi } from "./test-helpers.js";
import { visualLength } from "./MarkdownTable.js";

describe("answer block gutter (2026-10-10)", () => {
  it("indents every later line of an answer block under the text after the bullet", () => {
    const lines = [BULLET_TAG + "First paragraph.", "", ANSWER_CONT_TAG + "Second paragraph."];
    const { lastFrame } = render(<OutputArea lines={lines} activeLine="" busy={false} staticEpoch={0} />);
    const rows = stripAnsi(lastFrame() ?? "").split("\n");
    expect(rows.find((r) => r.includes("First"))).toMatch(/^● First paragraph\./);
    expect(rows.find((r) => r.includes("Second"))).toMatch(/^ {2}Second paragraph\./);
  });

  it("keeps wrapped rows of a long answer line inside the gutter", () => {
    const long = "word ".repeat(60).trim();
    const { lastFrame } = render(<OutputArea lines={[ANSWER_CONT_TAG + long]} activeLine="" busy={false} staticEpoch={0} />);
    const rows = stripAnsi(lastFrame() ?? "").split("\n").filter((r) => r.includes("word"));
    expect(rows.length).toBeGreaterThan(1);
    for (const r of rows) expect(r.startsWith("  word") || r.startsWith("   word")).toBe(true);
  });
});

describe("table width inside the gutter (2026-10-10)", () => {
  // A table long enough that the renderer fills the width it is given: one
  // column wide enough to be grown, one frozen. Sized to the terminal (80) it
  // needs 82 columns on a gutter line, so Ink wraps it and the tail lands at
  // column 0 as stray border fragments — the reported breakage.
  const table = "| Component | Status |\n|---|---|\n| CarouselStorePort | done |";

  const rowsOf = (frame: string) => stripAnsi(frame).split("\n").filter((r) => r.trim() !== "");

  it("sizes a gutter table to the columns the gutter leaves", () => {
    const { lastFrame } = render(
      <OutputArea lines={[ANSWER_CONT_TAG + table]} activeLine="" busy={false} staticEpoch={0} />,
    );
    const rows = rowsOf(lastFrame() ?? "");
    // Two columns of gutter + a 78-wide table: exactly the terminal, no wrap.
    const top = rows.find((r) => r.includes("┌"))!;
    expect(visualLength(top)).toBe(80);
    for (const row of rows) expect(visualLength(row)).toBeLessThanOrEqual(80);
    // Nothing wrapped: the five table lines, each indented by the gutter. A
    // wrapped row would add a line starting at the gutter's edge instead.
    expect(rows).toHaveLength(5);
    for (const row of rows) expect(row.startsWith("  ")).toBe(true);
  });

  it("gives a non-gutter table the full terminal width", () => {
    const { lastFrame } = render(
      <OutputArea lines={[table]} activeLine="" busy={false} staticEpoch={0} />,
    );
    const rows = rowsOf(lastFrame() ?? "");
    const top = rows.find((r) => r.includes("┌"))!;
    expect(visualLength(top)).toBe(80);
  });
});

describe("gutter never shrinks (2026-10-10)", () => {
  it("keeps every row of a long paragraph that opens with bold at column 2", async () => {
    const { ANSWER_CONT_TAG: CONT } = await import("./constants.js");
    // Reproduced from a real reply: this shape rendered at column 1 because the
    // two-space gutter shrank beside the long paragraph.
    const para =
      "**The two real defects I found and fixed:** the flow test was mid-rewrite and broken (undefined `withApp`, a hardcoded `390` assert, and `/api/content/26` mocked as `[]` — so \"Open editor\" crashed the editor while the URL assert still passed, a false green). And the helpers registered cleanup *after* `chromium.launch()`.";
    const { lastFrame } = render(<OutputArea lines={[CONT + para]} activeLine="" busy={false} staticEpoch={0} />);
    const rows = stripAnsi(lastFrame() ?? "").split("\n").filter((r) => r.trim() !== "");
    expect(rows.length).toBeGreaterThan(2);
    for (const r of rows) expect(r).toMatch(/^ {2}\S/);
  });
});
