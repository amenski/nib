import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render } from "ink-testing-library";
import { Text } from "ink";
import PromptInput from "./PromptInput.js";
import { __resetInputWireForTests } from "../hooks/useTerminalInput.js";
import { stripAnsi as strip } from "../test-helpers.js";
const rowsOf = (f: string | undefined) => strip(f ?? "").split("\n").length;
const flush = () => new Promise((r) => setTimeout(r, 60));

const mounted: Array<{ unmount: () => void }> = [];
afterEach(() => {
  while (mounted.length) mounted.pop()!.unmount();
  __resetInputWireForTests();
});

function setup(props: Partial<React.ComponentProps<typeof PromptInput>> = {}) {
  const inst = render(
    <PromptInput
      onSubmit={vi.fn()}
      screenWidth={80}
      promptHistory={[]}
      busy={false}
      statusLine={<Text>Build · Model · max</Text>}
      {...props}
    />,
  );
  mounted.push(inst);
  return inst;
}

/**
 * Frame-height stability.
 *
 * Ink's incremental renderer can only skip a row that stayed at the same index.
 * A row that appears or disappears shifts everything below it, forcing a
 * repaint of the rest of the frame — which is what flicker looks like. The
 * input area therefore holds a constant height regardless of what it has to
 * say, so ordinary typing never moves anything.
 */
describe("PromptInput frame height", () => {
  it("keeps the same height with and without a status line", () => {
    const withStatus = rowsOf(setup().lastFrame());
    const withoutStatus = rowsOf(setup({ statusLine: undefined }).lastFrame());
    expect(withoutStatus).toBe(withStatus);
  });

  it("does not grow while typing a single line", async () => {
    const { stdin, lastFrame } = setup();
    const before = rowsOf(lastFrame());
    stdin.write("hello world");
    await flush();
    expect(rowsOf(lastFrame())).toBe(before);
  });

  it("does not change height when a transient notice appears", async () => {
    // Ctrl+X with no attachments sets a status message; the notice row exists
    // either way, so the height must not move.
    const { stdin, lastFrame } = setup();
    const before = rowsOf(lastFrame());
    stdin.write("\x18"); // ctrl+x
    await flush();
    expect(rowsOf(lastFrame())).toBe(before);
  });

  it("raises the input with rules, not the status", () => {
    // The INPUT is the raised element — it is where attention belongs. The
    // status sits flat below it. This was inverted at one point (status boxed,
    // input bare), which read backwards.
    // Claude Code's prompt draws only the rules above and below, with the
    // chevron marking the text column — no side borders.
    const rows = strip(setup().lastFrame() ?? "").split("\n");
    const inputRow = rows.findIndex((r) => r.includes("❯"));
    expect(inputRow).toBeGreaterThan(0);
    expect(rows[inputRow - 1]).toMatch(/^─+$/);
    expect(rows[inputRow + 1]).toMatch(/^─+$/);
    expect(rows[inputRow]).not.toMatch(/^[│╭╰]/);
  });

  it("renders the status flat, outside the box", () => {
    const rows = strip(setup().lastFrame() ?? "").split("\n");
    const statusRow = rows.findIndex((r) => r.includes("Build"));
    expect(statusRow).toBeGreaterThan(0);
    expect(rows[statusRow]).not.toMatch(/^│/);
  });

  it("swallows a bare Tab instead of typing a literal tab", async () => {
    // Regression: Tab carries a `value` of "\t", so with no slash menu open it
    // fell through to the catch-all insert and typed a tab into the prompt.
    // Each press widened the row past the box and wrapped the model pill onto
    // its own line, cascading with every further press.
    const { stdin, lastFrame } = setup();
    const before = rowsOf(lastFrame());
    for (let i = 0; i < 6; i++) {
      stdin.write("\t");
      await flush();
    }
    expect(strip(lastFrame() ?? "")).not.toContain("\t");
    expect(rowsOf(lastFrame())).toBe(before);
  });

  it("does not submit a tab-only buffer", async () => {
    // If Tab were still inserted, this would submit whitespace.
    const onSubmit = vi.fn();
    const { stdin } = setup({ onSubmit });
    stdin.write("\t\t\t");
    await flush();
    stdin.write("\r");
    await flush();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("keeps the model pill pinned to the first input row when text is long", async () => {
    // The pill is fixed chrome: long input wraps inside the text column rather
    // than squeezing the pill onto a line of its own. (The box itself DOES grow
    // downward for multi-line input — that is correct; what must not happen is
    // the pill being displaced.)
    const { stdin, lastFrame } = setup({ modelPill: "[ DeepSeek V4 Flash ]" });
    stdin.write("x".repeat(200));
    await flush();
    const rows = strip(lastFrame() ?? "").split("\n");
    const pillRows = rows
      .map((r, i) => ({ r, i }))
      .filter(({ r }) => r.includes("DeepSeek V4 Flash"));
    // Exactly one row carries the pill, and it is the row with the input caret.
    expect(pillRows).toHaveLength(1);
    expect(pillRows[0].r).toContain("❯");
  });

  it("reserves the notice row even when there is nothing to show", () => {
    // The blank row is load-bearing: without it, the first status message
    // pushes every row below the input down by one.
    const frame = strip(setup().lastFrame() ?? "");
    expect(frame.split("\n").length).toBeGreaterThanOrEqual(4);
  });

  it("gapAbove adds exactly one blank row above the input", () => {
    // The host applies this only when the transcript has not already left a
    // blank row there (see core/composer-gap.ts). One row — not two: an
    // unconditional margin doubled the gap under "✳ Worked for Ns", which
    // already ends with a blank line of its own.
    const without = strip(setup().lastFrame() ?? "").split("\n");
    const withGap = strip(setup({ gapAbove: true }).lastFrame() ?? "").split("\n");

    expect(withGap.length).toBe(without.length + 1);
    const inputRow = withGap.findIndex((r) => r.includes("❯"));
    expect(inputRow).toBeGreaterThan(1);
    // Exactly one blank row between the top rule and whatever precedes it.
    expect(withGap[inputRow - 1]).toMatch(/^─+$/);
    expect(withGap[inputRow - 2]).toBe("");
    expect(withGap[inputRow - 3]).not.toBe("");
  });
});
