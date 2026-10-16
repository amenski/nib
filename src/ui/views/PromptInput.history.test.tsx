import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render } from "ink-testing-library";
import PromptInput from "./PromptInput.js";
import { __resetInputWireForTests } from "../hooks/useTerminalInput.js";
import { stripAnsi } from "../test-helpers.js";

const ESC = "\x1b";
const UP = `${ESC}[A`;
const DOWN = `${ESC}[B`;

const flush = () => new Promise((r) => setTimeout(r, 60));

/**
 * ↑/↓ recall of previously submitted prompts.
 *
 * Regression context: the hook (useHistoryNavigation) and the key bindings both
 * existed, but App rendered `promptHistory={[]}` — a hardcoded empty array — so
 * navigateHistory returned immediately and the arrows did nothing. These tests
 * drive the real component with a populated history so that wiring can't be
 * silently dropped again.
 */
// useTerminalInput keeps ONE module-level stdin listener for the process, so a
// component left mounted from a previous test keeps ownership of the wire and
// the next render's keys go nowhere. Unmount and reset between tests.
const mounted: Array<{ unmount: () => void }> = [];

afterEach(() => {
  while (mounted.length) mounted.pop()!.unmount();
  __resetInputWireForTests();
});

function setup(promptHistory: string[]) {
  const inst = render(
    <PromptInput
      onSubmit={vi.fn()}
      screenWidth={80}
      promptHistory={promptHistory}
      busy={false}
    />,
  );
  mounted.push(inst);
  return inst;
}

describe("PromptInput ↑/↓ prompt history", () => {
  it("Up recalls the most recent prompt", async () => {
    const { stdin, lastFrame } = setup(["older prompt", "newest prompt"]);
    stdin.write(UP);
    await flush();
    expect(stripAnsi(lastFrame() ?? "")).toContain("newest prompt");
  });

  it("repeated Up walks further back", async () => {
    const { stdin, lastFrame } = setup(["older prompt", "newest prompt"]);
    stdin.write(UP);
    await flush();
    stdin.write(UP);
    await flush();
    expect(stripAnsi(lastFrame() ?? "")).toContain("older prompt");
  });

  it("Down walks forward and returns to the empty draft", async () => {
    const { stdin, lastFrame } = setup(["older prompt", "newest prompt"]);
    stdin.write(UP);
    await flush();
    stdin.write(UP);
    await flush();
    expect(stripAnsi(lastFrame() ?? "")).toContain("older prompt");

    stdin.write(DOWN);
    await flush();
    expect(stripAnsi(lastFrame() ?? "")).toContain("newest prompt");

    stdin.write(DOWN);
    await flush();
    const frame = stripAnsi(lastFrame() ?? "");
    // Past the newest entry the draft is restored (empty here).
    expect(frame).not.toContain("newest prompt");
    expect(frame).not.toContain("older prompt");
  });

  it("does not blow up when there is no history", async () => {
    const { stdin, lastFrame } = setup([]);
    stdin.write(UP);
    await flush();
    stdin.write(DOWN);
    await flush();
    expect(lastFrame()).toBeTruthy();
  });

  it("leaves a part-typed draft alone when the caret is not at the start", async () => {
    // Up only enters history from the START of the buffer, so it can still move
    // the caret within multi-line input. With the caret at end-of-text after
    // typing, Up must NOT clobber what the user is writing.
    const { stdin, lastFrame } = setup(["recalled prompt"]);
    stdin.write("half-typed");
    await flush();
    stdin.write(UP);
    await flush();
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("half-typed");
    expect(frame).not.toContain("recalled prompt");
  });

  it("restores the draft when history is entered from the start of the line", async () => {
    const { stdin, lastFrame } = setup(["recalled prompt"]);
    stdin.write("half-typed");
    await flush();
    // Ctrl+A moves to the start, which is where Up hands off to history.
    stdin.write("\x01");
    await flush();
    stdin.write(UP);
    await flush();
    expect(stripAnsi(lastFrame() ?? "")).toContain("recalled prompt");

    stdin.write(DOWN);
    await flush();
    // The draft the user was mid-way through must come back, not be lost.
    expect(stripAnsi(lastFrame() ?? "")).toContain("half-typed");
  });

  it("walks history PAST a slash command instead of getting trapped in its menu", async () => {
    // Regression: recalling "/model" made getCurrentSlashToken non-null, the
    // completion menu opened, and its branch consumed the next Up-arrow for
    // menu navigation — so the entry BEFORE the command was unreachable.
    const { stdin, lastFrame } = setup(["first message", "/model"]);
    stdin.write(UP);
    await flush();
    const afterFirst = stripAnsi(lastFrame() ?? "");
    expect(afterFirst).toContain("/model");
    // The menu must be suppressed during recall — no completion row visible.
    expect(afterFirst).not.toContain("Select model");

    stdin.write(UP);
    await flush();
    expect(stripAnsi(lastFrame() ?? "")).toContain("first message");
  });
});

describe("PromptInput ↓ opens the background panel", () => {
  function setupWithBackground(promptHistory: string[]) {
    const onOpenBackground = vi.fn();
    const inst = render(
      <PromptInput
        onSubmit={vi.fn()}
        screenWidth={80}
        promptHistory={promptHistory}
        busy={false}
        onOpenBackground={onOpenBackground}
      />,
    );
    mounted.push(inst);
    return { ...inst, onOpenBackground };
  }

  it("calls onOpenBackground on an empty prompt", async () => {
    const { stdin, onOpenBackground } = setupWithBackground(["older prompt"]);
    stdin.write(DOWN);
    await flush();
    expect(onOpenBackground).toHaveBeenCalledTimes(1);
  });

  it("leaves a typed draft alone", async () => {
    const { stdin, onOpenBackground } = setupWithBackground([]);
    stdin.write("draft");
    await flush();
    stdin.write(DOWN);
    await flush();
    expect(onOpenBackground).not.toHaveBeenCalled();
  });

  it("still walks forward through history while browsing it", async () => {
    const { stdin, lastFrame, onOpenBackground } = setupWithBackground(["older prompt", "newest prompt"]);
    stdin.write(UP);
    await flush();
    stdin.write(UP);
    await flush();
    stdin.write(DOWN);
    await flush();
    expect(onOpenBackground).not.toHaveBeenCalled();
    expect(stripAnsi(lastFrame() ?? "")).toContain("newest prompt");
  });
});
