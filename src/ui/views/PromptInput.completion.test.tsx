import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render } from "ink-testing-library";
import PromptInput, { type PromptSubmission } from "./PromptInput.js";
import { __resetInputWireForTests } from "../hooks/useTerminalInput.js";
import { stripAnsi } from "../test-helpers.js";

const TAB = "\t";
const SHIFT_TAB = "\x1b[Z";
const LEFT = "\x1b[D";

const flush = () => new Promise((r) => setTimeout(r, 60));

const mounted: Array<{ unmount: () => void }> = [];
afterEach(() => {
  while (mounted.length) mounted.pop()!.unmount();
  __resetInputWireForTests();
});

function setup(completer: (line: string) => [string[], string]) {
  const onSubmit = vi.fn<(s: PromptSubmission) => void>();
  const onCyclePosture = vi.fn();
  const completerMock = vi.fn(completer);
  const inst = render(
    <PromptInput
      onSubmit={onSubmit}
      onCyclePosture={onCyclePosture}
      completer={completerMock}
      screenWidth={80}
      promptHistory={[]}
      busy={false}
    />,
  );
  mounted.push(inst);
  return { ...inst, onSubmit, onCyclePosture, completerMock };
}

/**
 * Tab completion via ctx.completer (feature-plans §5). The slash menu and
 * @-file picker keep precedence where they apply; a bare Tab with neither
 * open falls back to the completer — slash commands at the start of the line,
 * path completion for mid-word tokens. The completer's contract: [hits, base]
 * where base is the typed stem (a suffix of the line) the hit replaces.
 */
describe("PromptInput Tab completion via ctx.completer", () => {
  it("bare Tab at line start completes a slash command", async () => {
    const { stdin, lastFrame, completerMock } = setup((line) => {
      if (line.trim() === "") return [["/skills", "/model"], line];
      return [[], line];
    });
    stdin.write(TAB);
    await flush();
    expect(completerMock).toHaveBeenCalledWith("");

    // The menu renders from state the key handler sets, so the frame can still be
    // one tick behind when `flush()` returns. This was seen to fail exactly once —
    // completer already called, frame stale — with three suites sharing one
    // checkout, and has not been reproduced since: 12 runs under 12 CPU burners,
    // three concurrent suites in isolated clones, and 24 concurrent single-file
    // runs were all clean. So it is a hardening, not a verified fix. The shape
    // matches App.streaming's picker test, whose fixed sleep did reproduce, and
    // polling still asserts exactly what the sleep was reaching for: "/skills" has
    // no other source in this test, so it can only come from the completer's hits.
    // The deadline keeps a genuinely broken menu loud rather than hung.
    const deadline = Date.now() + 5000;
    let frame = stripAnsi(lastFrame() ?? "");
    while (!frame.includes("/skills") && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
      frame = stripAnsi(lastFrame() ?? "");
    }
    expect(frame).toContain("/skills");
  });

  it("mid-word Tab replaces the typed stem with the completion", async () => {
    const { stdin, lastFrame, completerMock } = setup((line) => {
      if (line === "check src/ma") return [["src/main.ts"], "src/ma"];
      return [[], line];
    });
    stdin.write("check src/ma");
    await flush();
    stdin.write(TAB);
    await flush();
    expect(completerMock).toHaveBeenCalledWith("check src/ma");
    expect(stripAnsi(lastFrame() ?? "")).toContain("check src/main.ts");
  });

  it("the completer sees the line only up to the cursor", async () => {
    const { stdin, completerMock } = setup(() => [["x"], ""]);
    stdin.write("abc");
    await flush();
    stdin.write(`${LEFT}${LEFT}`); // cursor moves from 3 to 1
    await flush();
    stdin.write(TAB);
    await flush();
    expect(completerMock).toHaveBeenCalledWith("a");
  });

  it("@-mention picker takes precedence and the completer never runs", async () => {
    const { stdin, lastFrame, completerMock } = setup(() => [["@from-completer.ts"], ""]);
    stdin.write("@package");
    await flush();
    stdin.write(TAB);
    await flush();
    // The picker inserted the highlighted file; the completer was not consulted.
    expect(stripAnsi(lastFrame() ?? "")).toContain("@package.json ");
    expect(completerMock).not.toHaveBeenCalled();
  });

  it("slash menu Tab completion takes precedence and the completer never runs", async () => {
    const { stdin, lastFrame, completerMock } = setup(() => [["/whatever"], ""]);
    stdin.write("/");
    await flush();
    stdin.write(TAB);
    await flush();
    expect(stripAnsi(lastFrame() ?? "")).toContain("/skills");
    expect(completerMock).not.toHaveBeenCalled();
  });

  it("a Tab with no completion hits still swallows the key (no literal tab)", async () => {
    const { stdin, lastFrame } = setup(() => [[], "anything"]);
    stdin.write("hello");
    await flush();
    stdin.write(TAB);
    await flush();
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("hello");
    expect(frame).not.toContain("\t");
  });

  it("Shift+Tab still cycles posture and never reaches the completer", async () => {
    const { stdin, onCyclePosture, completerMock } = setup(() => [["/skills"], ""]);
    stdin.write(SHIFT_TAB);
    await flush();
    expect(onCyclePosture).toHaveBeenCalledTimes(1);
    expect(completerMock).not.toHaveBeenCalled();
  });
});
