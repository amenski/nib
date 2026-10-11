import React from "react";
import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import OutputArea from "./OutputArea.js";
import { TOOL_HEADER_TAG, TOOL_RESULT_TAG } from "./constants.js";
import { stripAnsi } from "./test-helpers.js";

function frameOf(lines: string[]): string {
  // See trap #4 in test-helpers.ts: lastFrame() is a full composite of Static
  // content + the live tail, so containment assertions work unchanged.
  const { lastFrame } = render(
    <OutputArea lines={lines} activeLine="" busy={false} staticEpoch={0} />,
  );
  return stripAnsi(lastFrame() ?? "");
}

/**
 * A tool-result preview is pre-styled text with meaningful leading spaces: the
 * "  ⎿  " opener and the aligned "     " gutter under it, plus whatever
 * indentation the payload itself carried (`      {showModelDropdown && (`).
 *
 * Rendered as markdown, the markdown wrapper drops a run of spaces at the start
 * of a row, so the gutter and the source indent vanished.
 */
describe("OutputArea tool-result preview indentation", () => {
  const INDENTED = "      const x = 1;";

  it("keeps the leading spaces of a tagged preview line", () => {
    const frame = frameOf([TOOL_HEADER_TAG + INDENTED]);
    expect(frame).toContain(INDENTED);
  });

  it("loses them when the same line is untagged (the bug being guarded)", () => {
    // Proves the tag is what preserves the indent, rather than the assertion
    // passing for some unrelated reason.
    const frame = frameOf([INDENTED]);
    expect(frame).not.toContain(INDENTED);
  });

  it("matches what formatToolResultPreview emits for a multi-line result", () => {
    const preview = ["  ⎿  first", "     second"];
    const frame = frameOf(preview.map((l) => TOOL_HEADER_TAG + l));

    for (const line of preview) expect(frame).toContain(line);
  });
});

/**
 * A preview line wider than the terminal wraps. Its overflow must hang under
 * the text (column 5, past the "  ⎿  " gutter), not fall back to column 0.
 */
describe("OutputArea tool-result preview wrapping", () => {
  const WORDS = Array.from({ length: 24 }, (_, i) => `word${i}`).join(" "); // ~190 cols
  const rows = (lines: string[]) => frameOf(lines).split("\n").filter((r) => r.trim() !== "");

  it("hangs wrapped rows under the text of the first line", () => {
    const out = rows([TOOL_RESULT_TAG + `  ⎿  ${WORDS}`]);
    expect(out.length).toBeGreaterThan(1);
    expect(out[0]!.startsWith("  ⎿  word0")).toBe(true);
    for (const r of out.slice(1)) expect(r.startsWith("     ")).toBe(true);
  });

  it("hangs wrapped rows under a continuation line, keeping the source indent", () => {
    const out = rows([TOOL_RESULT_TAG + `       ${WORDS}`]);
    expect(out[0]!.startsWith("       word0")).toBe(true);
    for (const r of out.slice(1)) expect(r.startsWith("     ")).toBe(true);
  });

  it("keeps short lines and an empty opener intact", () => {
    const frame = frameOf([TOOL_RESULT_TAG + "  ⎿  ", TOOL_RESULT_TAG + "     {open && (", TOOL_RESULT_TAG + "       <Child"]);
    expect(frame).toContain("  ⎿");
    expect(frame).toContain("     {open && (");
    expect(frame).toContain("       <Child");
  });

  it("styles the whole line when it arrives coloured", () => {
    const dim = (t: string) => `\x1b[38;5;246m${t}\x1b[39m`;
    const out = rows([TOOL_RESULT_TAG + dim(`  ⎿  ${WORDS}`)]);
    expect(out[0]!.startsWith("  ⎿  word0")).toBe(true);
    for (const r of out.slice(1)) expect(r.startsWith("     ")).toBe(true);
  });
});
