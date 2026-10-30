import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render } from "ink-testing-library";
import App from "./App.js";
import type { AppContext } from "./types.js";
import { __resetInputWireForTests } from "./hooks/useTerminalInput.js";
import { stripAnsi } from "./test-helpers.js";
import { todoStore } from "../tools/todo.js";

vi.mock("./core/history-store.js", () => ({
  loadPromptHistory: () => [],
  appendPromptHistory: () => Promise.resolve(),
  HISTORY_CAP: 1000,
}));

const { fakeStdout } = await import("./test-helpers.js");
fakeStdout();

type TurnResult = { stopReason: string; messages: never[]; newMessages: never[] };

function makeCtx(
  runTurn: () => Promise<TurnResult>,
  handleSlash: (input: string) => Promise<string[]> = async () => [],
): AppContext {
  return {
    mutable: {
      conversationHistory: [],
      sessionInput: 0,
      sessionOutput: 0,
      lastContextTokens: 0,
      sessionUserInputs: [],
    },
    getProvider: () => ({}) as any,
    sessionId: "test-session",
    activeMode: null,
    permissions: {
      resolve: () => ({ action: "allow", winningRule: null, wasUnresolved: false, isGuarded: false }),
      buildDefaultRule: () => null,
      approveForSession: () => {},
      approveAlways: () => {},
    },
    toolRegistry: null,
    compactor: null,
    diagnostics: null,
    skills: [],
    memoryInjection: undefined,
    memoryStore: null,
    sessionStore: { appendMessage: () => Promise.resolve(), appendPermission: () => Promise.resolve() },
    checkpoints: { list: () => Promise.resolve([]) },
    modeLoader: null,
    skillLoader: null,
    providerName: "test",
    activeModel: "test-model",
    effortValues: () => [],
    provideAbortController: () => new AbortController(),
    renewAbortController: () => {},
    completer: () => [[], ""],
    buildStatusBar: () => [{ id: "1", text: "STATUS-BAR" }],
    getPromptStr: () => "❯",
    getColorEnabled: () => false,
    logSessionEnd: async () => null,
    onExit: () => {},
    handleSlash,
    getModelEntries: () => [],
    runAgentTurnCore: vi.fn(runTurn),
    theme: undefined,
    keybindings: undefined,
    keybindingConfig: undefined,
    workflowConfig: undefined,
    gitStatus: null,
  } as any as AppContext;
}

const flush = () => new Promise((r) => setTimeout(r, 60));
async function until(check: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
}

const SPINNER_START = /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] /;
const DONE: TurnResult = { stopReason: "done", messages: [], newMessages: [] };

const mounted: Array<{ unmount: () => void }> = [];
afterEach(() => {
  while (mounted.length) mounted.pop()!.unmount();
  __resetInputWireForTests();
  todoStore.reset();
});

const frameOf = (inst: { lastFrame: () => string | undefined }) => stripAnsi(inst.lastFrame() ?? "");
/** Rows with trailing blank rows dropped: the last entry is the last painted row. */
const rowsOf = (frame: string) => frame.replace(/\s+$/, "").split("\n");

/** Start a turn that stays running until `release()`. */
async function startHeldTurn() {
  let release: () => void = () => {};
  const ctx = makeCtx(() => new Promise<TurnResult>((r) => { release = () => r(DONE); }));
  const inst = render(<App ctx={ctx} />);
  mounted.push(inst);
  inst.stdin.write("hello");
  await flush();
  inst.stdin.write("\r");
  await until(() => frameOf(inst).includes("working…"));
  return { inst, release: () => release() };
}

describe("bottom of the frame", () => {
  it("shows the placeholder with the command and mode hints", async () => {
    const inst = render(<App ctx={makeCtx(async () => DONE)} />);
    mounted.push(inst);
    await flush();
    expect(frameOf(inst)).toContain("Type your message… (/ commands · ⌃O mode)");
  });

  it("renders no working line and no hint row when idle", async () => {
    const inst = render(<App ctx={makeCtx(async () => DONE)} />);
    mounted.push(inst);
    await flush();
    const frame = frameOf(inst);
    expect(frame).not.toContain("working…");
    expect(frame).not.toContain("compacting…");
    expect(frame).not.toContain("interrupt");
    const rows = rowsOf(frame);
    // Status line is last and its spinner slot is blank when idle.
    expect(rows[rows.length - 1]).toMatch(/^ {2}STATUS-BAR/);
  });

  it("shows the working line, one blank row, then the input box while a turn runs", async () => {
    const { inst, release } = await startHeldTurn();
    const rows = rowsOf(frameOf(inst));
    const at = rows.findIndex((r) => r === "working… (esc to interrupt)");
    expect(at).toBeGreaterThanOrEqual(0);
    expect(rows[at + 1]).toBe("");
    expect(rows[at + 2]).toMatch(/^[─╭╮]/);
    release();
  });

  it("keeps the status line as the last row, led by a spinner glyph, while a turn runs", async () => {
    const { inst, release } = await startHeldTurn();
    const rows = rowsOf(frameOf(inst));
    expect(rows[rows.length - 1]).toMatch(SPINNER_START);
    expect(rows[rows.length - 1]).toContain("STATUS-BAR");
    release();
  });

  it("drops the working line and the spinner when the turn ends", async () => {
    const { inst, release } = await startHeldTurn();
    release();
    await until(() => !frameOf(inst).includes("working…"));
    const rows = rowsOf(frameOf(inst));
    expect(frameOf(inst)).not.toContain("working…");
    expect(rows[rows.length - 1]).toMatch(/^ {2}STATUS-BAR/);
  });

  it("says compacting… instead of working… during /compact", async () => {
    let finish: (lines: string[]) => void = () => {};
    const ctx = makeCtx(
      async () => DONE,
      (input) => (input === "/compact" ? new Promise((r) => { finish = r; }) : Promise.resolve([])),
    );
    const inst = render(<App ctx={ctx} />);
    mounted.push(inst);
    inst.stdin.write("/compact");
    await flush();
    inst.stdin.write("\r");
    await until(() => frameOf(inst).includes("compacting…"));
    const frame = frameOf(inst);
    expect(frame).toContain("compacting…");
    expect(frame).not.toContain("working…");
    const rows = rowsOf(frame);
    expect(rows[rows.length - 1]).toMatch(SPINNER_START);
    finish([]);
    await until(() => !frameOf(inst).includes("compacting…"));
    expect(frameOf(inst)).not.toContain("compacting…");
  });
});
