import React from "react";
import { describe, it, expect } from "vitest";
import { render } from "ink";
import OutputArea from "./OutputArea.js";
import { TOOL_HEADER_TAG, TOOL_RESULT_TAG, ANSWER_CONT_TAG, USER_ECHO_TAG } from "./constants.js";
import { fakeStdout, stripAnsi } from "./test-helpers.js";

/**
 * Rows as a real 80-column terminal receives them. ink-testing-library's frame
 * hides the bug (its stdout is 100 wide), so this renders through Ink itself.
 */
async function rowsAt80(lines: string[]): Promise<string[]> {
  const { writes, stream } = fakeStdout();
  (stream as { columns: number }).columns = 80;
  const inst = render(<OutputArea lines={lines} activeLine="" busy={false} staticEpoch={0} />, {
    stdout: stream,
    interactive: true,
    patchConsole: false,
  } as Parameters<typeof render>[1]);
  await new Promise((r) => setTimeout(r, 50));
  inst.unmount();
  return stripAnsi(writes.join(""))
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
    .split("\n")
    .filter((r) => r.trim() !== "");
}

describe("OutputArea rows fit an 80-column terminal (2026-11-02)", () => {
  it("wraps a long tool-output line under its text instead of past the edge", async () => {
    const rows = await rowsAt80([
      TOOL_RESULT_TAG +
        "     one long output line: alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike",
    ]);
    expect(rows.length).toBe(2);
    for (const r of rows) expect(r.length).toBeLessThanOrEqual(80);
    expect(rows[1]!.startsWith("     ")).toBe(true);
  });

  it("expands tabs so the terminal does not push the tail past the edge", async () => {
    const rows = await rowsAt80([
      TOOL_RESULT_TAG + "  ⎿  c1\tc2\tc3\tc4\tc5\tc6\tc7\tc8\tc9\tc10\tc11",
      ANSWER_CONT_TAG + "Cols:\tA\tB\tC\tD\tE\tF\tG\tH\tI\tJ\tK",
    ]);
    for (const r of rows) {
      expect(r).not.toContain("\t");
      expect(r.length).toBeLessThanOrEqual(80);
    }
    expect(rows.find((r) => r.includes("c11"))!.startsWith("     ")).toBe(true);
  });

  it("hangs a wrapped tool header under the text after its glyph", async () => {
    const rows = await rowsAt80([
      TOOL_HEADER_TAG + "    └ Bash(npm run test -- --reporter=verbose src/some/really/long/test/path.test.ts)",
    ]);
    expect(rows.length).toBe(2);
    expect(rows[1]!.startsWith("      ")).toBe(true);
  });

  it("hangs a wrapped prompt echo with a long path under its text", async () => {
    const rows = await rowsAt80([
      USER_ECHO_TAG +
        "Run cd /private/tmp/claude-502/-Users-amanuel-Documents-prg-proj-nib/781df727-f49d-4480/wraprepo/frontend && ls -a now",
    ]);
    for (const r of rows) expect(r.length).toBeLessThanOrEqual(80);
    for (const r of rows.slice(1)) expect(r.startsWith("  ")).toBe(true);
  });
});
