import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render } from "ink-testing-library";
import App from "./App.js";
import type { AppContext } from "./types.js";
import { __resetInputWireForTests } from "./hooks/useTerminalInput.js";
import { stripAnsi } from "./test-helpers.js";
import { todoStore } from "../tools/todo.js";
import { jobManager } from "../tools/jobs.js";
import { TaskRegistry, type TaskOutcome } from "../orchestrator/runner.js";
import type { SubagentProgress } from "../orchestrator/index.js";

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

interface TasksHarness {
  ctx: AppContext;
  registry: TaskRegistry;
  deliver: (taskId: string, message: string) => void;
  /** The App's mount-time progress sink, registered at render time. */
  progressSink: ((event: SubagentProgress) => void) | undefined;
  runAgentTurnCore: ReturnType<typeof vi.fn>;
  /** Per-test turn script (replaces the default immediate-complete script). */
  script: (input: string, cb: any) => Promise<any>;
}

function makeHarness(): TasksHarness {
  const registry = new TaskRegistry();
  let deliver: (taskId: string, message: string) => void = () => {};
  let progressSink: ((event: SubagentProgress) => void) | undefined;
  let callbacks: any = null;
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
    sessionStore: { appendMessage: vi.fn(() => Promise.resolve()), appendPermission: () => Promise.resolve() },
    checkpoints: { list: () => Promise.resolve([]) },
    modeLoader: null,
    skillLoader: null,
    providerName: "test",
    activeModel: "test-model",
    effortValues: () => [],
    provideAbortController: () => new AbortController(),
    renewAbortController: () => {},
    completer: () => [[], ""],
    // A live status bar: the task segment derives from the registry snapshot,
    // exactly how cli.tsx's buildStatusBar feeds it.
    buildStatusBar: () => [],
    getPromptStr: () => "❯",
    getColorEnabled: () => false,
    logSessionEnd: async () => null,
    onExit: () => {},
    handleSlash: async () => [],
    getModelEntries: () => [],
    runAgentTurnCore,
    setSubagentResultHandler: (handler: (taskId: string, message: string) => void) => { deliver = handler; },
    getTasks: () => registry.list(),
    abortTask: vi.fn((taskId: string) => registry.abortTask(taskId)),
    setSubagentProgress: (handler: ((event: SubagentProgress) => void) | undefined) => { progressSink = handler ?? undefined; },
    theme: undefined,
    keybindings: undefined,
    keybindingConfig: undefined,
    workflowConfig: undefined,
    gitStatus: null,
  } as any as AppContext;

  return {
    ctx,
    registry,
    deliver: (taskId, message) => deliver(taskId, message),
    get progressSink() { return progressSink; },
    runAgentTurnCore,
    set script(fn: (input: string, cb: any) => Promise<any>) { script = fn; },
  } as TasksHarness;
}

/** A sub-run that never settles — the task stays "running" until stopped. */
const pendingRun = () => new Promise<TaskOutcome>(() => {});

const flush = () => new Promise((r) => setTimeout(r, 60));

/** The live row polls once a second, so wait for the frame instead of a fixed flush. */
async function waitForFrame(inst: { lastFrame: () => string | undefined }, check: (frame: string) => boolean): Promise<string> {
  const deadline = Date.now() + 3000;
  let frame = stripAnsi(inst.lastFrame() ?? "");
  while (!check(frame) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
    frame = stripAnsi(inst.lastFrame() ?? "");
  }
  return frame;
}

const mounted: Array<{ unmount: () => void }> = [];
afterEach(() => {
  while (mounted.length) mounted.pop()!.unmount();
  __resetInputWireForTests();
  todoStore.reset();
  vi.restoreAllMocks();
});

describe("async sub-run live row (async-subagents.md §4)", () => {
  it("shows the running agent under the status bar and clears once its result arrives", async () => {
    const h = makeHarness();
    let release!: (v: TaskOutcome) => void;
    let turns = 0;
    h.script = async (_input: string, cb: any) => {
      turns++;
      if (turns === 1) {
        // Turn 1: the model spawns a detached sub-run, then ends its turn.
        const spawned = h.registry.spawn({
          description: "long task",
          depth: 0,
          run: () => new Promise<TaskOutcome>((r) => { release = r; }),
          deliver: (taskId, message) => h.deliver(taskId, message),
        });
        expect("taskId" in spawned).toBe(true);
        cb.onToolStart("new_task", { description: "long task" });
        cb.onToolResult("new_task", { content: "task task-1 spawned — result will follow" });
      }
      return { stopReason: "done", messages: [], newMessages: [] };
    };
    const inst = render(<App ctx={h.ctx} />);
    mounted.push(inst);
    await flush();

    inst.stdin.write("delegate it");
    await flush();
    inst.stdin.write("\r");
    await flush();
    await flush();

    // The spawning turn ended; the sub-run still works — the live row reports it.
    let frame = await waitForFrame(inst, (f) => f.includes("⏵ 1 agent"));
    expect(frame).toContain("⏵ 1 agent · sub: long task");
    expect(frame).toContain("↓ to view");

    // The run completes; its result wakes a turn and the segment clears.
    release({ status: "done", summary: "finished" });
    await flush();
    await flush();
    await flush();
    frame = await waitForFrame(inst, (f) => !f.includes("⏵ 1 agent"));
    expect(frame).toContain("Sub-agent result (task task-1)");
    expect(frame).not.toContain("⏵ 1 agent");
  });
});

describe("/tasks view (async-subagents.md §4, Q4)", () => {
  it("lists tasks, x stops the selected running one (siblings survive), Esc closes", async () => {
    const h = makeHarness();
    // Two sub-runs held open so the stop action is observable mid-flight.
    const a = h.registry.spawn({ description: "task A", depth: 0, run: pendingRun, deliver: () => {} });
    const b = h.registry.spawn({ description: "task B", depth: 0, run: pendingRun, deliver: () => {} });
    expect("taskId" in a).toBe(true);
    expect("taskId" in b).toBe(true);

    const inst = render(<App ctx={h.ctx} />);
    mounted.push(inst);
    await flush();

    inst.stdin.write("/tasks");
    await flush();
    inst.stdin.write("\r");
    await flush();
    await flush();

    let frame = stripAnsi(inst.lastFrame() ?? "");
    expect(frame).toContain("Background");
    expect(frame).toContain("sub: task A");
    expect(frame).toContain("sub: task B");
    expect(frame).toContain("running");

    // Enter no longer stops anything — stopping is x.
    inst.stdin.write("\r");
    await flush();
    expect(h.ctx.abortTask).not.toHaveBeenCalled();

    // x stops the selected (first) running task — that sub-run aborts, the
    // sibling keeps running. Both spawned in the same tick, so either can sort
    // first; the assertion follows whichever was selected.
    inst.stdin.write("x");
    await flush();
    await flush();

    expect(h.ctx.abortTask).toHaveBeenCalledTimes(1);
    const stopped = (h.ctx.abortTask as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    const sibling = stopped === "task-1" ? "task-2" : "task-1";
    expect(h.registry.get(stopped)?.status).toBe("aborted");
    expect(h.registry.get(sibling)?.status).toBe("running");
    frame = stripAnsi(inst.lastFrame() ?? "");
    expect(frame).toContain("aborted");

    // Esc closes the view; the transcript echo stays, the modal goes away.
    inst.stdin.write("\x1b");
    await flush();
    await flush();
    frame = stripAnsi(inst.lastFrame() ?? "");
    expect(frame).not.toContain("Background —");
  });
});

describe("live sub-run text streaming (async-subagents.md §4)", () => {
  it("coalesces streamed text deltas into [agent <name>] rows at ~200ms while idle", async () => {
    const h = makeHarness();
    const inst = render(<App ctx={h.ctx} />);
    mounted.push(inst);
    await flush();

    // The App registered its mount-time sink.
    expect(h.progressSink).toBeDefined();

    // A chatty sub-run streams deltas — split across events, so the coalescer
    // must join them into one row.
    h.progressSink!({ kind: "text", text: "investigating ", depth: 0, agent: "researcher" });
    h.progressSink!({ kind: "text", text: "seatbelt.ts\n", depth: 0, agent: "researcher" });
    await flush();

    // Before the ~200ms cadence: nothing committed yet.
    let frame = stripAnsi(inst.lastFrame() ?? "");
    expect(frame).not.toContain("investigating");

    // After the cadence: one coalesced dim row, labeled with the agent.
    const deadline = Date.now() + 5000;
    frame = stripAnsi(inst.lastFrame() ?? "");
    while (!frame.includes("[agent researcher] investigating") && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
      frame = stripAnsi(inst.lastFrame() ?? "");
    }
    expect(frame).toContain("[agent researcher] investigating seatbelt.ts");
  });

  it("flushes the buffered tail immediately when the run finishes, unnamed agents render as [agent sub]", async () => {
    const h = makeHarness();
    const inst = render(<App ctx={h.ctx} />);
    mounted.push(inst);
    await flush();

    h.progressSink!({ kind: "text", text: "tail line\n", depth: 1 });
    // The run finishes before the cadence: the "end" event flushes the tail.
    h.progressSink!({ kind: "end", task: "long task", depth: 1 });
    await flush();

    const frame = stripAnsi(inst.lastFrame() ?? "");
    expect(frame).toContain("[agent sub] tail line");
  });

  it("renders streamed text while a turn is active too (the sink is mount-scoped, not turn-scoped)", async () => {
    const h = makeHarness();
    let release!: (v: unknown) => void;
    h.script = () => new Promise((r) => { release = r; });
    const inst = render(<App ctx={h.ctx} />);
    mounted.push(inst);
    await flush();

    inst.stdin.write("first prompt");
    await flush();
    inst.stdin.write("\r");
    await flush();

    // A sub-run spawned by an earlier turn streams while this turn runs.
    h.progressSink!({ kind: "text", text: "mid-turn work\n", depth: 0, agent: "code" });
    h.progressSink!({ kind: "end", task: "t", depth: 0 });
    await flush();

    const frame = stripAnsi(inst.lastFrame() ?? "");
    expect(frame).toContain("[agent code] mid-turn work");

    release({ stopReason: "done", messages: [], newMessages: [] });
    await flush();
    await flush();
  });
});

// jobManager is imported by App at module load; keep the linter satisfied that
// the import is intentional (App subscribes to it — the tests here never emit
// job events).
void jobManager;
void writes;
void stream;
