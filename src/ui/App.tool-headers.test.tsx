import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render } from "ink-testing-library";
import App from "./App.js";
import type { AppContext } from "./types.js";
import { __resetInputWireForTests } from "./hooks/useTerminalInput.js";
import { stripAnsi } from "./test-helpers.js";

vi.mock("./core/history-store.js", () => ({
  loadPromptHistory: () => [],
  appendPromptHistory: () => Promise.resolve(),
  HISTORY_CAP: 1000,
}));

function makeCtx(runAgentTurnCore: AppContext["runAgentTurnCore"]): AppContext {
  return {
    mutable: { conversationHistory: [], sessionInput: 0, sessionOutput: 0, lastContextTokens: 0, sessionUserInputs: [] },
    getProvider: () => ({}) as any,
    sessionId: "test-session",
    activeMode: null,
    permissions: {
      resolve: () => ({ action: "allow", winningRule: null, wasUnresolved: false, isGuarded: false }),
      buildDefaultRule: () => null,
      folderScopeRule: () => null,
      externalTreeRule: () => null,
      approveForSession: () => {},
      approveAlways: () => {},
    } as any,
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
    buildStatusBar: () => [],
    getPromptStr: () => "❯",
    getColorEnabled: () => false,
    logSessionEnd: async () => null,
    onExit: () => {},
    handleSlash: async () => [],
    getModelEntries: () => [],
    runAgentTurnCore,
    theme: undefined,
    keybindings: undefined,
    keybindingConfig: undefined,
    workflowConfig: undefined,
    gitStatus: null,
  } as any as AppContext;
}

const flush = () => new Promise((r) => setTimeout(r, 60));
const mounted: Array<{ unmount: () => void }> = [];

afterEach(() => {
  while (mounted.length) mounted.pop()!.unmount();
  __resetInputWireForTests();
});

const count = (frame: string, needle: string) => frame.split(needle).length - 1;

/**
 * Starts a turn whose agent is driven step by step: `step(fn)` runs fn with the
 * turn's callbacks, `finish()` ends the turn.
 */
async function startTurn() {
  let cb: any;
  let finish!: () => void;
  const done = new Promise<void>((r) => (finish = r));
  const frameRef: { inst?: ReturnType<typeof render> } = {};
  const ready = new Promise<void>((resolveReady) => {
    const ctx = makeCtx(async (_input: string, callbacks: any) => {
      cb = callbacks;
      resolveReady();
      await done;
      return { stopReason: "done", messages: [], newMessages: [] };
    });
    const inst = render(<App ctx={ctx} />);
    mounted.push(inst);
    frameRef.inst = inst;
    inst.stdin.write("go");
    setTimeout(() => inst.stdin.write("\r"), 60);
  });
  await ready;
  const frame = () => stripAnsi(frameRef.inst!.lastFrame() ?? "");
  const step = async (fn: (cb: any) => void) => {
    fn(cb);
    await flush();
    await flush();
  };
  return { step, frame, finish: async () => { finish(); await flush(); await flush(); } };
}

describe("tool headers wait for their result", () => {
  it("shows a running tool's header once, and still once after its result", async () => {
    const t = await startTurn();
    await t.step((cb) => cb.onToolStart("run_bash", { command: "sleep 1" }));
    expect(count(t.frame(), "Bash(sleep 1)")).toBe(1);

    await t.step((cb) => cb.onToolResult("run_bash", { content: "slept" }));
    const frame = t.frame();
    expect(count(frame, "Bash(sleep 1)")).toBe(1);
    expect(frame.indexOf("Bash(sleep 1)")).toBeLessThan(frame.indexOf("⎿  slept"));
    await t.finish();
  });

  it("keeps a parallel batch in call order, each header above its own result", async () => {
    const t = await startTurn();
    await t.step((cb) => {
      cb.onToolStart("run_bash", { command: "echo a" });
      cb.onToolStart("run_bash", { command: "echo b" });
    });
    expect(count(t.frame(), "Bash(echo a)")).toBe(1);
    expect(count(t.frame(), "Bash(echo b)")).toBe(1);

    await t.step((cb) => {
      cb.onToolResult("run_bash", { content: "out-a" });
      cb.onToolResult("run_bash", { content: "out-b" });
    });
    const f = t.frame();
    const order = ["Bash(echo a)", "out-a", "Bash(echo b)", "out-b"].map((s) => f.indexOf(s));
    expect(order.every((pos) => pos >= 0)).toBe(true);
    expect([...order].sort((x, y) => x - y)).toEqual(order);
    expect(count(f, "Bash(echo a)")).toBe(1);
    expect(count(f, "Bash(echo b)")).toBe(1);
    await t.finish();
  });

  it("keeps the header of a call that never reports a result", async () => {
    const t = await startTurn();
    await t.step((cb) => cb.onToolStart("run_bash", { command: "denied cmd" }));
    await t.finish();
    expect(count(t.frame(), "Bash(denied cmd)")).toBe(1);
  });

  it("commits a waiting header before other output, so the order never changes", async () => {
    const t = await startTurn();
    await t.step((cb) => {
      cb.onToolStart("edit", { path: "a.ts", old_string: "x", new_string: "y" });
      cb.onDiagnostic("lsp: 1 error(s) in a.ts");
    });
    await t.step((cb) => cb.onToolResult("edit", { content: "ok" }));
    const f = t.frame();
    expect(count(f, "Edit(a.ts)")).toBe(1);
    expect(f.indexOf("Edit(a.ts)")).toBeLessThan(f.indexOf("lsp: 1 error(s)"));
    await t.finish();
  });
});
