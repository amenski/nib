import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "ink-testing-library";
import type { CheckpointEntry } from "../../checkpoints/index.js";
import { __resetInputWireForTests } from "../hooks/useTerminalInput.js";
import { stripAnsi } from "../test-helpers.js";
import UndoSelector from "./UndoSelector.js";

const ENTER = "\r";
const mounted: Array<{ unmount: () => void }> = [];
const flush = () => new Promise((resolve) => setTimeout(resolve, 60));
const flatten = (frame: string) => stripAnsi(frame).replace(/[│╭╮╰╯─]/g, " ").replace(/\s+/g, " ").trim();

const checkpoint: CheckpointEntry = {
  hash: "0123456789abcdef",
  message: "turn-start checkpoint",
  timestamp: "2026-09-16T10:00:00.000Z",
};

afterEach(() => {
  while (mounted.length) mounted.pop()!.unmount();
  __resetInputWireForTests();
});

describe("UndoSelector", () => {
  it("shows undo limitations immediately before restore mode selection", async () => {
    const inst = render(
      <UndoSelector
        checkpoints={[checkpoint]}
        onRestore={vi.fn(async () => ({ restored: true, promptDraft: "" }))}
        onClose={vi.fn()}
        width={100}
        height={24}
      />,
    );
    mounted.push(inst);

    expect(flatten(inst.lastFrame() ?? "")).not.toContain("running processes");

    inst.stdin.write(ENTER);
    await flush();

    const frame = flatten(inst.lastFrame() ?? "");
    expect(frame).toContain("Undo only affects this checkpoint");
    expect(frame).toContain("running processes");
    expect(frame).toContain("network calls");
    expect(frame).toContain("remote mutations");
    expect(frame).toContain("files excluded from or not captured");
    expect(frame).toContain("later untracked data");
  });
});
