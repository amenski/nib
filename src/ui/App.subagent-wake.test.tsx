import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render } from "ink-testing-library";
import App from "./App.js";
import type { AppContext } from "./types.js";
import { __resetInputWireForTests } from "./hooks/useTerminalInput.js";
import { stripAnsi } from "./test-helpers.js";
import { todoStore } from "../tools/todo.js";
import { jobManager } from "../tools/jobs.js";

// Same doubles as App.streaming.test.tsx: point history-store at a throwaway
// dir and stub stdout for stray /raw writes.
vi.mock("./core/history-store.js", () => ({
  loadPromptHistory: () => [],
  appendPromptHistory: () => Promise.resolve(),
  HISTORY_CAP: 1000,
}));
const { fakeStdout } = await import("./test-helpers.js");
const { writes, stream } = fakeStdout();

// ── Fake AppContext ──

interface WakeHarness {
  ctx: AppContext;
  deliver: (taskId: string, message: string) => void;
  runAgentTurnCore: ReturnType<typeof vi.fn>;
  appendMessage: ReturnType<typeof vi.fn>;
  abortRunningTasks: ReturnType<typeof vi.fn>;
  /** Latest callbacks bundle handed to runAgentTurnCore (for mailbox polls). */
  lastCallbacks: () => any;
  /** Per-test turn script (replaces the default immediate-complete script). */
  script: (input: string, cb: any) => Promise<any>;
}

function makeHarness(): WakeHarness {
  let deliver: (taskId: string, message: string) => void = () => {};
  let callbacks: any = null;
  const appendMessage = vi.fn(() => Promise.resolve());
  const abortRunningTasks = vi.fn();
  // Per-test turn script: receives the input + callbacks bundle, returns the
  // bridge result (a test may gate it on a promise it resolves itself).
  let script: (input: string, cb: any) => Promise<any> = async () =>
    ({ stopReason: "done", messages: [], newMessages: [] });
  const runAgentTurnCore = vi.fn((input: string, cb: any) => {
    callbacks = cb;
    return script(input, cb);
  });
  const ctx: AppContext = {
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
    sessionStore: { appendMessage, appendPermission: () => Promise.resolve() },
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
    setSubagentResultHandler: (handler: (taskId: string, message: string) => void) => { deliver = handler; },
    abortRunningTasks,
    theme: undefined,
    keybindings: undefined,
    keybindingConfig: undefined,
    workflowConfig: undefined,
    gitStatus: null,
  } as any as AppContext;

  return {
    ctx,
    deliver: (taskId, message) => deliver(taskId, message),
    runAgentTurnCore,
    appendMessage,
    abortRunningTasks,
    lastCallbacks: () => callbacks,
    set script(fn: (input: string, cb: any) => Promise<any>) { script = fn; },
  } as WakeHarness;
}

const RESULT = "Sub-agent result (task task-1): **Result**: sub done";

const flush = () => new Promise((r) => setTimeout(r, 60));

const mounted: Array<{ unmount: () => void }> = [];
afterEach(() => {
  while (mounted.length) mounted.pop()!.unmount();
  __resetInputWireForTests();
  todoStore.reset();
  vi.restoreAllMocks();
});

describe("async sub-agent result wake (async-subagents.md §2)", () => {
  it("idle: a delivered result starts a turn with the result as its prompt and persists it like any message", async () => {
    const h = makeHarness();
    h.script = async (_input: string, cb: any) => {
      cb.onText("synthesis");
      return { stopReason: "done", messages: [], newMessages: [{ role: "assistant", content: "synthesis" }] };
    };
    const inst = render(<App ctx={h.ctx} />);
    mounted.push(inst);
    await flush();

    h.deliver("task-1", RESULT);
    await flush();
    await flush();

    // The wake turn ran with the result as its prompt.
    expect(h.runAgentTurnCore).toHaveBeenCalledTimes(1);
    expect(h.runAgentTurnCore.mock.calls[0][0]).toBe(RESULT);

    // Persisted exactly once, like any user message (role user + the reply).
    expect(h.appendMessage).toHaveBeenCalledWith("test-session", { role: "user", content: RESULT });
    expect(h.appendMessage).toHaveBeenCalledWith("test-session", { role: "assistant", content: "synthesis" });

    // The result renders as a normal message in the transcript.
    const frame = stripAnsi(inst.lastFrame() ?? "");
    expect(frame).toContain("Sub-agent result (task task-1)");
    expect(frame).toContain("synthesis");
  });

  it("active turn: the result rides the steering mailbox, no second turn starts", async () => {
    const h = makeHarness();
    let release!: (v: unknown) => void;
    h.script = () => new Promise((r) => { release = r; });

    const inst = render(<App ctx={h.ctx} />);
    mounted.push(inst);
    // Start a turn; it stays in flight (turnActiveRef true).
    inst.stdin.write("first prompt");
    await flush();
    inst.stdin.write("\r");
    await flush();

    h.deliver("task-1", RESULT);
    await flush();

    // No second turn while the first is active — the result is queued.
    expect(h.runAgentTurnCore).toHaveBeenCalledTimes(1);

    // …and the steering mailbox (pollSteeringMessage) hands it to the running
    // turn at the next decision point.
    expect(h.lastCallbacks().pollSteeringMessage()).toBe(RESULT);

    release({ stopReason: "done", messages: [], newMessages: [] });
    await flush();
    await flush();
    // The mailbox consumed the message, so the end-of-turn drain has nothing.
    expect(h.runAgentTurnCore).toHaveBeenCalledTimes(1);
  });

  it("mid-typing: the result queues behind the user's pending submission", async () => {
    const h = makeHarness();
    // Gate the FIRST turn so the drain can't race past the assertion that the
    // user's message runs before the result.
    let turn = 0;
    let release!: (v: unknown) => void;
    h.script = () => {
      turn++;
      if (turn === 1) return new Promise((r) => { release = r; });
      return Promise.resolve({ stopReason: "done", messages: [], newMessages: [] });
    };
    const inst = render(<App ctx={h.ctx} />);
    mounted.push(inst);
    await flush();

    // User is mid-typing… PromptInput reports its draft to App in a passive
    // effect on the buffer text, so the rendered frame can show the typed text a
    // tick before App's `draftTextRef` gate sees it. Wait for the draft to be on
    // screen and then let one macrotask pass (the flush below) so the effect has
    // landed: with a fixed sleep alone, a loaded machine delivered the result
    // first, the gate read "idle", and a turn started — measured, 4 of 4 runs
    // under six concurrent suites. The deadline keeps a broken input wire loud
    // rather than hung.
    inst.stdin.write("hello");
    const draftDeadline = Date.now() + 5000;
    while (!stripAnsi(inst.lastFrame() ?? "").includes("hello") && Date.now() < draftDeadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    await flush();
    h.deliver("task-1", RESULT);
    await flush();

    // …no turn starts; the result waits in the queue.
    expect(h.runAgentTurnCore).not.toHaveBeenCalled();

    // The user submits first…
    inst.stdin.write("\r");
    await flush();
    expect(h.runAgentTurnCore).toHaveBeenCalledTimes(1);
    expect(h.runAgentTurnCore.mock.calls[0][0]).toBe("hello");

    // …then the result drains behind it, as a normal turn.
    release({ stopReason: "done", messages: [], newMessages: [] });
    await flush();
    await flush();
    expect(h.runAgentTurnCore).toHaveBeenCalledTimes(2);
    expect(h.runAgentTurnCore.mock.calls[1][0]).toBe(RESULT);
  });

  it("/exit kills pending sub-runs (abortRunningTasks on the exit path)", async () => {
    const h = makeHarness();
    const inst = render(<App ctx={h.ctx} />);
    mounted.push(inst);
    await flush();

    inst.stdin.write("/exit");
    await flush();
    inst.stdin.write("\r");
    await flush();

    expect(h.abortRunningTasks).toHaveBeenCalledTimes(1);
  });
});

// jobManager is imported by App at module load; keep the linter satisfied that
// the import is intentional (App subscribes to it — the tests here never emit
// job events).
void jobManager;
void writes;
void stream;
