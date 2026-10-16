import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render } from "ink-testing-library";
import App, { PERMISSION_TYPING_GUARD_MS } from "./App.js";
import type { AppContext } from "./types.js";
import { __resetInputWireForTests } from "./hooks/useTerminalInput.js";
import { stripAnsi } from "./test-helpers.js";
import { ANSWER_BULLET } from "./constants.js";
import { todoStore } from "../tools/todo.js";
import { jobManager } from "../tools/jobs.js";
import { ModeLoader } from "../modes/loader.js";
import { ProfileEvaluator } from "../permissions/index.js";

// ── Test doubles ──
//
// history-store writes to ~/.nib; App's promptHistory initializer calls it
// at mount. Point it at a throwaway temp dir so App-level tests never touch the
// developer's real prompt history. Accessibility announcements early-return
// without a TTY, so they are safe to leave live.
vi.mock("./core/history-store.js", () => ({
  loadPromptHistory: () => [],
  appendPromptHistory: () => Promise.resolve(),
  HISTORY_CAP: 1000,
}));

// A /raw toggle writes to process.stdout when raw mode is on — App defaults to
// normal mode and these tests never switch it, but stub stdout to keep any
// stray write out of the test runner's output.
const { fakeStdout } = await import("./test-helpers.js");
// A /raw toggle writes to process.stdout when raw mode is on — App defaults to
// normal mode and these tests never switch it, but keep a fake TTY stream
// around (the same helper incremental-render.test.tsx uses) so any stray write
// has a sink instead of reaching the test runner's output.
const { writes, stream } = fakeStdout();

// ── Fake AppContext ──

function makeCtx(
  runAgentTurnCore: AppContext["runAgentTurnCore"],
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
    sessionStore: {
      appendMessage: () => Promise.resolve(),
      appendPermission: () => Promise.resolve(),
    },
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

// useTerminalInput keeps ONE module-level stdin listener for the process, so a
// component left mounted from a previous test keeps ownership of the wire and
// the next render's keys go nowhere. Unmount and reset between tests.
const mounted: Array<{ unmount: () => void }> = [];

afterEach(() => {
  while (mounted.length) mounted.pop()!.unmount();
  __resetInputWireForTests();
});

/**
 * Drive a full agent turn through App: render it, type a prompt, press Enter,
 * and let the fake provider stream its response through the same onText/
 * onToolStart/onToolResult callbacks the real bridge uses.
 */
async function runTurn(
  prompt: string,
  chunks: string[],
): Promise<{ lastFrame: () => string | undefined; inst: ReturnType<typeof render> }> {
  let callbacks: any = null;
  const ctx = makeCtx(async (_input: string, cb: any) => {
    callbacks = cb;
    for (const c of chunks) cb.onText(c);
    cb.onToolStart("run_bash", { command: "echo hi" });
    cb.onToolResult("run_bash", { content: "hi" });
    cb.onToolStart("run_bash", { command: "echo bye" });
    cb.onToolResult("run_bash", { content: "bye" });
    return {
      stopReason: "done",
      messages: [],
      newMessages: [],
    };
  });

  const inst = render(<App ctx={ctx} />);
  mounted.push(inst);
  inst.stdin.write(prompt);
  await flush();
  inst.stdin.write("\r");
  await flush();
  // Give the streamed state a beat to flush through React.
  await flush();
  await flush();
  return { lastFrame: () => inst.lastFrame(), inst };
}

describe("mode picker shortcut (ctrl+o)", () => {
  afterEach(() => todoStore.reset());

  it("opens the picker, Enter routes /mode, and the status bar reflects the switch", async () => {
    todoStore.reset();
    let currentMode = "Code";
    const captured: string[] = [];
    const ctx = makeCtx(async (_input: string, cb: any) => {
      cb.onText("idle");
      return { stopReason: "done", messages: [], newMessages: [] };
    });
    ctx.modeLoader = new ModeLoader();
    ctx.activeMode = { slug: "code", name: "Code" } as any;
    ctx.handleSlash = async (cmd: string) => {
      const m = cmd.match(/^\/mode (\w+)$/);
      if (m) currentMode = m[1];
      captured.push(cmd);
      return [];
    };
    // A live status bar: the segment text derives from the current mode, so
    // the frame shows the switch the same way cli.tsx's buildStatusBar does.
    ctx.buildStatusBar = () => [{ text: `mode:${currentMode}` } as any];

    const inst = render(<App ctx={ctx} />);
    mounted.push(inst);
    await flush();
    await flush();

    // ctrl+o (byte 0x0f) opens the picker.
    inst.stdin.write("\x0f");
    await flush();

    // Wait for the picker AND its item list, which are two separate async steps:
    // opening is a state update, but the items come from `modeLoader.listAll()`
    // in ModeList's mount effect (a readdir plus a load per slug). A fixed sleep
    // therefore races the load, and on a loaded machine it fails as
    // `toContain("code")` with the title already reading "Modes" and the empty
    // state still on screen — measured, 3 of 6 concurrent runs.
    //
    // Poll the rendered frame so a slow loader can only delay the assertions,
    // never let them run before the list exists. The readiness signal is
    // "Modes" plus one expected item rather than the component's
    // "No modes available." placeholder: keying off that copy would make the
    // guard silently stop guarding the day the copy changes. While the picker
    // is open the status bar (which already reads "mode:code" at this point) is
    // not rendered, so "code" can only have come from the loaded list. The
    // deadline turns a genuinely broken loader into a loud failure, not a hang.
    const deadline = Date.now() + 5000;
    let frame = stripAnsi(inst.lastFrame() ?? "");
    const loaded = (f: string) => f.includes("Modes") && f.includes("code");
    while (!loaded(frame) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
      frame = stripAnsi(inst.lastFrame() ?? "");
    }
    expect(frame).toContain("Modes");
    expect(frame).toContain("general");
    expect(frame).not.toContain("architect");

    // Enter selects the first listed mode (listAll is alphabetical → code),
    // which routes through /mode <slug>. The wait above is what makes this
    // deterministic: Enter is a no-op when `modes[safeIndex]` is undefined, so
    // arriving before the list loads would leave `captured` empty.
    inst.stdin.write("\r");
    await flush();
    await flush();
    await flush();
    frame = stripAnsi(inst.lastFrame() ?? "");
    expect(captured).toEqual(["/mode code"]);
    expect(frame).toContain("mode:code");
  });
});

describe("todo panel", () => {
  afterEach(() => todoStore.reset());

  it("renders the agent's live checklist, suppresses the redundant result echo, and clears at the next turn", async () => {
    todoStore.reset();
    const ctx = makeCtx(async (_input: string, cb: any) => {
      // The model's first update_todo_list call: the ⏺ header fires, then the
      // real handler writes the store (simulated here), then the tool result
      // returns the full list.
      cb.onToolStart("update_todo_list", { todos: [] });
      todoStore.setTodos([
        { content: "Add F feedrate capture", status: "pending" },
        { content: "Per-segment time math", status: "in_progress" },
        { content: "UI row in the pro gate", status: "completed" },
      ]);
      cb.onToolResult("update_todo_list", {
        content: "Todo list updated (3 items):\n# Current todo list\n- [pending] Add F feedrate capture",
      });
      return { stopReason: "done", messages: [], newMessages: [] };
    });
    const inst = render(<App ctx={ctx} />);
    mounted.push(inst);
    inst.stdin.write("build it");
    await flush();
    inst.stdin.write("\r");
    await flush();
    await flush();
    await flush();

    // The turn is over by now; the panel persists (dimmed) with all three
    // statuses rendered as the checklist glyphs.
    const frame = stripAnsi(inst.lastFrame() ?? "");
    expect(frame).toContain("◻ Add F feedrate capture");
    expect(frame).toContain("▸ Per-segment time math");
    expect(frame).toContain("☑ UI row in the pro gate");
    // The call header stays (visible marker), but the redundant result echo —
    // which would print the whole list dimmed — is suppressed.
    expect(frame).toContain("⏺ Update Todos");
    expect(frame).not.toContain("Todo list updated");

    // A check-off mid-turn re-renders the panel live.
    todoStore.setTodos([
      { content: "Add F feedrate capture", status: "completed" },
      { content: "Per-segment time math", status: "in_progress" },
    ]);
    await flush();
    await flush();
    const frame2 = stripAnsi(inst.lastFrame() ?? "");
    expect(frame2).toContain("☑ Add F feedrate capture");
    expect(frame2).not.toContain("◻ Add F feedrate capture");
  });
});

describe("todo resume restore", () => {
  afterEach(() => todoStore.reset());

  it("restores the last persisted plan on a resumed session's first turn", async () => {
    todoStore.reset();
    const ctx = makeCtx(async (_input: string, cb: any) => {
      cb.onToolStart("update_todo_list", { todos: [] });
      cb.onToolResult("update_todo_list", { content: "Todo list updated" });
      return { stopReason: "done", messages: [], newMessages: [] };
    });
    // A resumed session's store holds the previous run's persisted snapshots.
    (ctx.sessionStore as any).queryTodos = async () => [
      { at: "2026-08-13T00:00:00Z", todos: [
        { content: "Restored step A", status: "pending" },
        { content: "Restored step B", status: "completed" },
      ] },
    ];
    const inst = render(<App ctx={ctx} />);
    mounted.push(inst);
    // Let the mount effect's queryTodos resolve before the first turn.
    await flush();
    await flush();
    inst.stdin.write("continue the work");
    await flush();
    inst.stdin.write("\r");
    await flush();
    await flush();
    await flush();

    const frame = stripAnsi(inst.lastFrame() ?? "");
    expect(frame).toContain("◻ Restored step A");
    expect(frame).toContain("☑ Restored step B");
  });

  it("starts with an empty panel on a fresh (non-resume) session", async () => {
    todoStore.reset();
    const ctx = makeCtx(async (_input: string, cb: any) => {
      cb.onToolStart("update_todo_list", { todos: [] });
      cb.onToolResult("update_todo_list", { content: "Todo list updated" });
      return { stopReason: "done", messages: [], newMessages: [] };
    });
    // No queryTodos: the guard no-ops, and the panel stays empty.
    const inst = render(<App ctx={ctx} />);
    mounted.push(inst);
    await flush();
    inst.stdin.write("hi");
    await flush();
    inst.stdin.write("\r");
    await flush();
    await flush();
    await flush();

    const frame = stripAnsi(inst.lastFrame() ?? "");
    expect(frame).not.toContain("◻");
  });
});

describe("App streaming markdown", () => {
  it("merges a span split across streamed lines into bold", async () => {
    const { lastFrame } = await runTurn("hi", ["**bold\n", "continues**"]);
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("bold");
    expect(frame).toContain("continues");
    expect(frame).not.toContain("**");
    // The held paragraph commits exactly ONCE at the tool-start flush — the
    // stale active-line preview must not be scheduled a second time. (This
    // regressed during the stream-blocks refactor: the preview used to hold
    // only the partial tail, but now includes the held paragraph, which
    // flushStream already committed.)
    expect(frame.match(/bold/g) ?? []).toHaveLength(1);
    expect(frame.match(/continues/g) ?? []).toHaveLength(1);
  });

  it("keeps a wrapped list item under one marker", async () => {
    const { lastFrame } = await runTurn("hi", ["- item one\n", "  wrapped\n", "plain\n"]);
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("item one");
    expect(frame).toContain("wrapped");
    expect(frame).toContain("plain");
    // One "- " marker: the wrapped continuation shares it. (Rows also carry
    // the answer block's two-column gutter, so match within the row.)
    const rows = frame.split("\n").filter((r) => r.trim() !== "");
    expect(rows.filter((r) => r.includes("- "))).toHaveLength(1);
    expect(rows.find((r) => r.includes("item one"))).toContain("- item one");
    expect(rows.find((r) => r.includes("wrapped"))).not.toContain("- ");
  });

  it("keeps a multi-line blockquote as one block", async () => {
    const { lastFrame } = await runTurn("hi", ["> line one\n", "> line two\n", "plain\n"]);
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("line one");
    expect(frame).toContain("line two");
    expect(frame).toContain("plain");
    // Both quote lines carry the ▎ marker and the raw ">" never leaks; the
    // following "plain" line is a separate paragraph, not a lazy continuation.
    expect(frame.split("\n").filter((l) => l.includes("▎")).length).toBe(2);
    expect(frame).not.toContain("> line");
  });

  it("does not bullet the blank line that ends a paragraph", async () => {
    // One chunk commits both the paragraph and the blank line after it. Only
    // the paragraph may carry the answer bullet — a bulleted "" renders as a
    // bare answer-glyph row above the next tool call.
    const { lastFrame } = await runTurn("hi", ["all done.\n\n"]);
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("all done.");
    expect(frame.split("\n").filter((l) => l.trim() === ANSWER_BULLET)).toHaveLength(0);
  });

  it("bullets the first real line when the block opens with a blank", async () => {
    const { lastFrame } = await runTurn("hi", ["\nall done.\n"]);
    const frame = stripAnsi(lastFrame() ?? "");
    const answer = frame.split("\n").find((l) => l.includes("all done."));
    expect(answer).toContain(ANSWER_BULLET);
    expect(frame.split("\n").filter((l) => l.trim() === ANSWER_BULLET)).toHaveLength(0);
  });

  it("commits an unclosed fence as a code block at turn end", async () => {
    const { lastFrame } = await runTurn("hi", ["```ts\n", "const x = 1;\n", "```\n"]);
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("const x = 1;");
    expect(frame).not.toContain("```");
  });

  it("does not duplicate a partial tail committed at turn end", async () => {
    // No trailing newline and no tool call: the partial line is committed by
    // the turn-end flushStream, and the stale active-line preview must not be
    // pushed a second time by the `if (activeLineRef.current)` fallback.
    let callbacks: any = null;
    const ctx = makeCtx(async (_input: string, cb: any) => {
      callbacks = cb;
      cb.onText("partial tail");
      return { stopReason: "done", messages: [], newMessages: [] };
    });
    const inst = render(<App ctx={ctx} />);
    mounted.push(inst);
    inst.stdin.write("hi");
    await flush();
    inst.stdin.write("\r");
    await flush();
    await flush();
    await flush();
    const frame = stripAnsi(inst.lastFrame() ?? "");
    expect(frame.match(/partial tail/g) ?? []).toHaveLength(1);
    expect(callbacks).not.toBeNull();
  });
});

describe("mid-turn steering (queue mailbox)", () => {
  it("the loop's poll consumes the queue head mid-turn and echoes it", async () => {
    const pollResults: (string | null)[] = [];
    const ctx = makeCtx(async (_input: string, cb: any) => {
      // Keep the turn open until the harness's queued follow-up has actually
      // landed in the mailbox, then poll it exactly like the agent loop does
      // per decision point. Waiting on the observable state — the mailbox
      // itself — instead of a fixed sleep makes this deterministic under
      // machine load: a loaded scheduler can only delay the poll, it can
      // never make it run before the queue is populated. The deadline turns
      // a genuinely broken wire into a loud failure instead of a hang.
      const deadline = Date.now() + 5000;
      let first: string | null = null;
      while (first === null && Date.now() < deadline) {
        first = cb.pollSteeringMessage();
        if (first === null) await new Promise((r) => setTimeout(r, 50));
      }
      pollResults.push(
        first ?? "TIMEOUT: queued steering message never landed in the mailbox",
      );
      pollResults.push(cb.pollSteeringMessage());
      cb.onText("steered reply");
      return { stopReason: "done", messages: [], newMessages: [] };
    });
    const inst = render(<App ctx={ctx} />);
    mounted.push(inst);
    inst.stdin.write("first");
    await flush();
    inst.stdin.write("\r");
    await flush();
    // Typed while the turn is in flight: lands in the queue.
    inst.stdin.write("steer me");
    await flush();
    inst.stdin.write("\r");
    await flush();
    await flush();
    await flush();

    // First poll consumed the head; the second found nothing (consumed, not
    // replayed). The queue is drained empty by the turn-end drain.
    expect(pollResults).toEqual(["steer me", null]);
    // The injected message is echoed into the transcript like a submission.
    const frame = stripAnsi(inst.lastFrame() ?? "");
    expect(frame).toContain("steer me");
  });

  it("runs a read-only /context mid-turn instead of queueing it, while a stateful /compact waits", async () => {
    // /context only reads state (the token breakdown and the compaction
    // trigger), so it is in MODAL_COMMANDS and must bypass the queue — it used
    // to be unreachable while a turn ran, exactly like /doctor was.
    let release!: (v: unknown) => void;
    const slashCalls: string[] = [];
    const ctx = makeCtx(() => new Promise((r) => { release = r; }));
    ctx.handleSlash = async (cmd: string) => {
      slashCalls.push(cmd);
      return [];
    };
    const inst = render(<App ctx={ctx} />);
    mounted.push(inst);
    inst.stdin.write("first");
    await flush();
    inst.stdin.write("\r");
    await flush();

    // A stateful command typed mid-turn: queued, not run.
    inst.stdin.write("/compact");
    await flush();
    inst.stdin.write("\r");
    await flush();
    expect(slashCalls).toEqual([]);

    // A read-only one: runs now, ahead of the queue.
    inst.stdin.write("/context");
    await flush();
    inst.stdin.write("\r");
    await flush();
    await flush();
    expect(slashCalls).toEqual(["/context"]);

    // The queue stack holds /compact only — /context never entered it.
    // The queue stack shows the waiting /compact; /context ran and never
    // entered it. (Both appear once as the transcript's own command echo, so
    // the check targets the stack's "[HH:MM] <command>" shape.)
    const frame = stripAnsi(inst.lastFrame() ?? "");
    expect(frame).toMatch(/^\[\d\d:\d\d\] \/compact$/m);
    expect(frame).not.toMatch(/^\[\d\d:\d\d\] \/context$/m);

    release({ stopReason: "done", messages: [], newMessages: [] });
    await flush();
    await flush();
    expect(slashCalls).toEqual(["/context", "/compact"]);
  });

  it("Esc interrupts the turn and queued input survives into the next turn", async () => {
    const inputs: string[] = [];
    const controller = new AbortController();
    const ctx = makeCtx(async (input: string, cb: any) => {
      inputs.push(input);
      if (inputs.length === 1) {
        // Hold the first turn until Esc aborts it (the bridge's signal), with
        // a timeout as a safety net so a missed keypress fails the test rather
        // than hanging it.
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 500);
          controller.signal.addEventListener("abort", () => {
            clearTimeout(timer);
            resolve();
          }, { once: true });
        });
        return { stopReason: "aborted", messages: [], newMessages: [] };
      }
      cb.onText("second reply");
      return { stopReason: "done", messages: [], newMessages: [] };
    });
    ctx.provideAbortController = () => controller;
    const inst = render(<App ctx={ctx} />);
    mounted.push(inst);
    inst.stdin.write("first");
    await flush();
    inst.stdin.write("\r");
    await flush();
    // Queued while the turn runs.
    inst.stdin.write("kept message");
    await flush();
    inst.stdin.write("\r");
    await flush();
    // Esc → PromptInput onInterrupt → abort → the turn ends as "aborted".
    inst.stdin.write("\x1b");
    await flush();
    await flush();
    await flush();

    // The queue survived the interrupt and drained into a fresh turn.
    expect(inputs).toEqual(["first", "kept message"]);
  });
});

describe("permission profile overlay — consolidation M.1 (§5)", () => {
  // The overlay's edit-in-workspace condition is profile-derived: with a
  // profile configured, an edit inside the effective write-set auto-allows
  // without a prompt; strict-sandbox has no write-set, so the prompt shows.
  function makeAskCtx(
    runAgentTurnCore: AppContext["runAgentTurnCore"],
    level: "workspace-write" | "strict-sandbox",
  ): AppContext {
    const ctx = makeCtx(runAgentTurnCore);
    ctx.permissions = {
      resolve: () => ({ action: "ask", winningRule: null, wasUnresolved: false, isGuarded: false }),
      buildDefaultRule: () => null,
      folderScopeRule: () => null,
      externalTreeRule: () => null,
      approveForSession: () => {},
      approveAlways: () => {},
    } as any;
    ctx.permissionProfile = new ProfileEvaluator({ level }, "/workspace");
    return ctx;
  }

  it("with workspace-write, an edit inside the workspace auto-allows without a prompt", async () => {
    let askResult: unknown = "unresolved";
    const ctx = makeAskCtx(async (_input: string, cb: any) => {
      askResult = await cb.askUser("edit", { path: "/workspace/src/a.ts", oldString: "x", newString: "y" });
      return { stopReason: "done", messages: [], newMessages: [] };
    }, "workspace-write");
    const inst = render(<App ctx={ctx} />);
    mounted.push(inst);
    inst.stdin.write("edit it");
    await flush();
    inst.stdin.write("\r");
    await flush();
    await flush();
    await flush();

    expect(askResult).toBe("posture");
    const frame = stripAnsi(inst.lastFrame() ?? "");
    expect(frame).not.toContain("Permission required");
  });

  it("with strict-sandbox, no edit is overlay-auto-allowed — the prompt still shows", async () => {
    let askPromise: Promise<boolean> | null = null;
    const ctx = makeAskCtx(async (_input: string, cb: any) => {
      askPromise = cb.askUser("edit", { path: "/workspace/src/a.ts", oldString: "x", newString: "y" });
      return { stopReason: "done", messages: [], newMessages: [] };
    }, "strict-sandbox");
    const inst = render(<App ctx={ctx} />);
    mounted.push(inst);
    inst.stdin.write("edit it");
    await flush();
    inst.stdin.write("\r");
    await flush();
    await flush();
    await flush();

    // The overlay is showing the permission prompt, not auto-allowing.
    const frame = stripAnsi(inst.lastFrame() ?? "");
    expect(frame).toContain("Permission required");
    expect(askPromise).toBeInstanceOf(Promise);
    // Resolve it ("1" = yes, just once) so nothing dangles.
    inst.stdin.write("1");
    await flush();
    await flush();
    expect(await askPromise).toBe(true);
  });

  it("an edit outside the write-set is never overlay-auto-allowed even at workspace-write (layer 1 already denied it)", async () => {
    let askResult: unknown = "unresolved";
    const ctx = makeAskCtx(async (_input: string, cb: any) => {
      // The engine result here simulates the layer-1 deny that a real run
      // would have produced for an out-of-write-set edit — the overlay must
      // fail closed on it (deny), never auto-allow.
      askResult = await cb.askUser("edit", { path: "/etc/hosts", oldString: "x", newString: "y" });
      return { stopReason: "done", messages: [], newMessages: [] };
    }, "workspace-write");
    ctx.permissions = {
      resolve: () => ({ action: "deny", winningRule: null, wasUnresolved: false, isGuarded: false }),
      buildDefaultRule: () => null,
      folderScopeRule: () => null,
      externalTreeRule: () => null,
    } as any;
    const inst = render(<App ctx={ctx} />);
    mounted.push(inst);
    inst.stdin.write("edit it");
    await flush();
    inst.stdin.write("\r");
    await flush();
    await flush();
    await flush();

    expect(askResult).toBe(false);
  });

  it("auto-approve cannot bypass a background command without a safe persistent scope", async () => {
    let askPromise: Promise<boolean> | null = null;
    const ctx = makeAskCtx(async (_input: string, cb: any) => {
      askPromise = cb.askUser("run_bash_background", { command: "echo hi" });
      return { stopReason: "done", messages: [], newMessages: [] };
    }, "strict-sandbox");
    ctx.mutable.posture = "autoApprove";
    const inst = render(<App ctx={ctx} />);
    mounted.push(inst);
    inst.stdin.write("run it");
    await flush();
    inst.stdin.write("\r");
    await flush();
    await flush();

    expect(stripAnsi(inst.lastFrame() ?? "")).toContain("Permission required");
    // And the session grant is not on offer for a background job — it is a
    // foreground-Bash consent only.
    expect(stripAnsi(inst.lastFrame() ?? "")).not.toContain("sandboxed Bash");
    expect(askPromise).toBeInstanceOf(Promise);
    inst.stdin.write("1");
    await flush();
    expect(await askPromise).toBe(true);
  });

  it("auto-approve still prompts when OS containment is unavailable", async () => {
    let askPromise: Promise<boolean> | null = null;
    const ctx = makeAskCtx(async (_input: string, cb: any) => {
      askPromise = cb.askUser("run_bash", { command: "echo hi" });
      return { stopReason: "done", messages: [], newMessages: [] };
    }, "workspace-write");
    ctx.mutable.posture = "autoApprove";
    ctx.autoApproveAllowed = false;
    const inst = render(<App ctx={ctx} />);
    mounted.push(inst);
    inst.stdin.write("run it");
    await flush();
    inst.stdin.write("\r");
    await flush();
    await flush();

    expect(stripAnsi(inst.lastFrame() ?? "")).toContain("Permission required");
    // No containment, so no envelope was handed over and no grant is offered.
    expect(stripAnsi(inst.lastFrame() ?? "")).not.toContain("sandboxed Bash");
    expect(askPromise).toBeInstanceOf(Promise);
    inst.stdin.write("1");
    await flush();
    expect(await askPromise).toBe(true);
  });

  // A prompt arriving mid-typing (2026-10-12): the composer used to unmount
  // under it, so the half-typed follow-up was gone when the prompt closed.
  function makeGatedAsk(): { ctx: AppContext; open: () => void; asked: () => Promise<boolean> | null } {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    let askPromise: Promise<boolean> | null = null;
    const ctx = makeAskCtx(async (_input: string, cb: any) => {
      await gate;
      askPromise = cb.askUser("run_bash_background", { command: "echo hi" });
      await askPromise;
      return { stopReason: "done", messages: [], newMessages: [] };
    }, "strict-sandbox");
    return { ctx, open: release, asked: () => askPromise };
  }

  it("keeps a half-typed draft through a permission prompt", async () => {
    const h = makeGatedAsk();
    const inst = render(<App ctx={h.ctx} />);
    mounted.push(inst);
    inst.stdin.write("run it");
    await flush();
    inst.stdin.write("\r");
    await flush();
    inst.stdin.write("hello wor");
    await flush();
    h.open();
    await flush();
    await flush();
    expect(stripAnsi(inst.lastFrame() ?? "")).toContain("Permission required");

    inst.stdin.write("\x1b"); // Esc denies
    await flush();
    await flush();
    expect(await h.asked()).toBe(false);
    inst.stdin.write("ld");
    await flush();
    expect(stripAnsi(inst.lastFrame() ?? "")).toContain("hello world");
  });

  it("ignores option keys briefly when the prompt opens over a draft", async () => {
    const h = makeGatedAsk();
    const inst = render(<App ctx={h.ctx} />);
    mounted.push(inst);
    inst.stdin.write("run it");
    await flush();
    inst.stdin.write("\r");
    await flush();
    inst.stdin.write("fix step ");
    await flush();
    // Frozen clock: under full-suite load real time can pass the guard before
    // the next key lands, which made this test flaky.
    const t0 = Date.now();
    let now = t0;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      h.open();
      await flush();
      await flush();

      // The user's next key, meant for the composer, lands on the prompt.
      let settled = false;
      void h.asked()!.then(() => { settled = true; });
      inst.stdin.write("2");
      await flush();
      expect(settled).toBe(false);
      expect(stripAnsi(inst.lastFrame() ?? "")).toContain("Permission required");

      now = t0 + PERMISSION_TYPING_GUARD_MS + 1;
      inst.stdin.write("1");
      await flush();
      expect(await h.asked()).toBe(true);
    } finally {
      clock.mockRestore();
    }
  });

  // The consolidation (docs/permission-ux-redesign.md): with a real containment
  // consent available for Bash, auto-approve no longer covers a Bash ask
  // silently — the prompt is where the session grant comes from, and answering
  // it is the only way this command stops asking.
  it("auto-approve no longer bypasses a Bash ask", async () => {
    let askResult: unknown = "unresolved";
    const ctx = makeAskCtx(async (_input: string, cb: any) => {
      askResult = await cb.askUser("run_bash", { command: "echo hi" });
      return { stopReason: "done", messages: [], newMessages: [] };
    }, "workspace-write");
    ctx.mutable.posture = "autoApprove";
    ctx.autoApproveAllowed = true;
    const inst = render(<App ctx={ctx} />);
    mounted.push(inst);
    inst.stdin.write("run it");
    await flush();
    inst.stdin.write("\r");
    await flush();
    await flush();

    expect(stripAnsi(inst.lastFrame() ?? "")).toContain("Permission required");
    inst.stdin.write("1");
    await flush();
    expect(askResult).toBe(true);
  });

  // The consent path end to end through the UI: the gate hands over an
  // envelope, the prompt offers exactly three options with the consent text,
  // and the grant option resolves as "envelope-grant" — the value agent.ts
  // stores the grant on. macOS-only, since the envelope is only ever built when
  // Seatbelt containment exists.
  it.skipIf(process.platform !== "darwin")("offers the session grant on an eligible Bash ask and resolves the choice", async () => {
    let askResult: unknown = "unresolved";
    const ctx = makeAskCtx(async (_input: string, cb: any) => {
      askResult = await cb.askUser("run_bash", { command: "echo hi" }, {
        profileHash: "0".repeat(64),
        level: "workspace-write",
        trustedRoot: "/workspace",
        writeRoots: ["/workspace", "/tmp/nib-scratch"],
        sessionTempDir: "/tmp/nib-scratch",
      });
      return { stopReason: "done", messages: [], newMessages: [] };
    }, "workspace-write");
    const inst = render(<App ctx={ctx} />);
    mounted.push(inst);
    inst.stdin.write("run it");
    await flush();
    inst.stdin.write("\r");
    await flush();
    await flush();

    const frame = stripAnsi(inst.lastFrame() ?? "");
    // Three options, the grant among them, and the limits stated beside it.
    expect(frame).toContain("1. Yes, just once");
    expect(frame).toContain("2. Yes, sandboxed Bash in this workspace for this session");
    expect(frame).toContain("3. No");
    expect(frame).not.toContain("Yes, always allow");
    expect(frame).toContain("Writable: /workspace, /tmp/nib-scratch");
    expect(frame).toContain("Revoke this in /permissions");

    inst.stdin.write("2");
    await flush();
    expect(askResult).toBe("envelope-grant");
  });

  // The positive control for the rule above: posture still bypasses an ordinary
  // ask on every other tool, so the Bash exclusion did not disable the posture.
  it("auto-approve still bypasses an ordinary non-Bash ask with OS containment", async () => {
    let askResult: unknown = "unresolved";
    const ctx = makeAskCtx(async (_input: string, cb: any) => {
      askResult = await cb.askUser("read_file", { path: "/workspace/src/a.ts" });
      return { stopReason: "done", messages: [], newMessages: [] };
    }, "workspace-write");
    ctx.mutable.posture = "autoApprove";
    ctx.autoApproveAllowed = true;
    const inst = render(<App ctx={ctx} />);
    mounted.push(inst);
    inst.stdin.write("read it");
    await flush();
    inst.stdin.write("\r");
    await flush();
    await flush();

    expect(askResult).toBe("posture");
    expect(stripAnsi(inst.lastFrame() ?? "")).not.toContain("Permission required");
  });
});

describe("background jobs (plan §3)", () => {
  afterEach(() => {
    jobManager.killAll();
  });

  /** Background state is polled once a second, so wait for the frame. */
  async function waitForFrame(inst: { lastFrame: () => string | undefined }, check: (frame: string) => boolean): Promise<string> {
    const deadline = Date.now() + 8000;
    let frame = stripAnsi(inst.lastFrame() ?? "");
    while (!check(frame) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
      frame = stripAnsi(inst.lastFrame() ?? "");
    }
    return frame;
  }

  it("keeps job output out of the transcript and leaves one completion row", async () => {
    const ctx = makeCtx(async () => ({ stopReason: "done", messages: [], newMessages: [] }));
    const inst = render(<App ctx={ctx} />);
    mounted.push(inst);
    await flush();

    const result = jobManager.start("printf 'out-%s\\n' marker", process.cwd(), 5000, { stream: true });
    expect(result.ok).toBe(true);

    const frame = await waitForFrame(inst, (f) => f.includes("· exited 0 ·"));
    expect(frame).toContain("● printf 'out-%s\\n' marker · exited 0 ·");
    expect(frame).not.toContain("out-marker");
    expect(frame).not.toContain("[job ");
    // The finished job also shows on the live row until it ages out.
    expect(frame).toContain("● 1 shell finished · ↓ to view");
  });

  it("opens the background panel with ↓ on an empty prompt, shows the job's output, and x stops it", async () => {
    const ctx = makeCtx(async () => ({ stopReason: "done", messages: [], newMessages: [] }));
    const inst = render(<App ctx={ctx} />);
    mounted.push(inst);
    await flush();

    const result = jobManager.start("printf 'panel-line\\n'; sleep 30", process.cwd(), 60_000, { stream: true });
    expect(result.ok).toBe(true);

    let frame = await waitForFrame(inst, (f) => f.includes("⏵ 1 shell"));
    expect(frame).toContain("⏵ 1 shell · printf 'panel-line\\n'; sleep 30");
    expect(frame).not.toContain("panel-line\n");

    inst.stdin.write("\u001B[B");
    frame = await waitForFrame(inst, (f) => f.includes("Background —") && f.includes("panel-line"));
    // Earlier tests' finished jobs stay listed (the manager is a singleton),
    // so only the running count is exact.
    expect(frame).toMatch(/Background — \d+ total, 1 running/);
    // The output tail row, not the command label that also contains the text.
    expect(frame).toMatch(/^[│\s]*panel-line[│\s]*$/m);

    // The panel can paint before its key handler attaches (useEffect runs
    // after paint); under full-suite load a key sent in that gap is lost.
    await new Promise((r) => setTimeout(r, 300));
    inst.stdin.write("x");
    frame = await waitForFrame(inst, (f) => f.includes("· killed ·"));
    expect(frame).toContain("· killed ·");

    inst.stdin.write("\u001B");
    frame = await waitForFrame(inst, (f) => !f.includes("Background —"));
    expect(frame).not.toContain("Background —");
  }, 20_000);
});

// A turn that produces no answer must never be silent. Reported symptom: the
// echoed prompt, then nothing but the "✳ Worked for Ns" footer. Two paths led
// there — see the turn-start renewAbortController() and the onDiagnostic
// handler in App.tsx.
describe("turns that end without an answer", () => {
  it("runs a turn submitted after an idle interrupt (fresh signal per turn)", async () => {
    // Mirrors cli.tsx: one shared controller, swapped by renewAbortController.
    let controller = new AbortController();
    const abortedAtTurnStart: boolean[] = [];
    const ctx = makeCtx(async (_input: string, cb: any) => {
      // What the real bridge reads when it builds the run's options.
      abortedAtTurnStart.push(controller.signal.aborted);
      cb.onText("reply");
      return { stopReason: "done", messages: [], newMessages: [] };
    });
    ctx.provideAbortController = () => controller;
    ctx.renewAbortController = () => {
      controller = new AbortController();
    };

    const inst = render(<App ctx={ctx} />);
    mounted.push(inst);
    await flush();

    // Esc with no turn in flight: PromptInput forwards it to onInterrupt
    // regardless of `busy`, so it aborts the controller the next turn would
    // otherwise have inherited.
    inst.stdin.write("\x1b");
    await flush();
    expect(controller.signal.aborted).toBe(true);

    inst.stdin.write("hello");
    await flush();
    inst.stdin.write("\r");
    await flush();
    await flush();

    expect(abortedAtTurnStart).toEqual([false]);
    expect(stripAnsi(inst.lastFrame() ?? "")).toContain("reply");
  });

  it("prints the reason on the transcript instead of ending silently", async () => {
    const ctx = makeCtx(async (_input: string, cb: any) => {
      cb.onText("partial reply\n");
      cb.onDiagnostic("connection lost: socket hang up");
      return { stopReason: "aborted", messages: [], newMessages: [] };
    });

    const inst = render(<App ctx={ctx} />);
    mounted.push(inst);
    inst.stdin.write("hello");
    await flush();
    inst.stdin.write("\r");
    await flush();
    await flush();

    const frame = stripAnsi(inst.lastFrame() ?? "");
    expect(frame).toContain("connection lost: socket hang up");
    // ...below the text that streamed before it, not above it.
    expect(frame.indexOf("partial reply")).toBeLessThan(
      frame.indexOf("connection lost"),
    );
  });
});

describe("tool result preview colour", () => {
  it("draws the ⎿ preview in the theme's toolOutput grey, not terminal dim", async () => {
    // Terminal dim (SGR 2) renders as a faint grey that is hard to read, and the
    // theme's textDim (246) was still too faint for output people read; the
    // preview uses the toolOutput slot (244, readable on light terminals too).
    const { DARK_THEME, ansiFg } = await import("./theme.js");
    const ctx = makeCtx(async (_input: string, cb: any) => {
      cb.onToolStart("run_bash", { command: "echo hi" });
      cb.onToolResult("run_bash", { content: "preview-line" });
      return { stopReason: "done", messages: [], newMessages: [] };
    });
    ctx.getColorEnabled = () => true;
    const inst = render(<App ctx={ctx} />);
    mounted.push(inst);
    inst.stdin.write("go");
    await flush();
    inst.stdin.write("\r");
    await flush();
    await flush();
    const frame = inst.lastFrame() ?? "";
    const line = frame.split("\n").find((l) => l.includes("preview-line")) ?? "";
    expect(line).toContain(ansiFg(DARK_THEME.toolOutput));
    expect(line).not.toContain(ansiFg(DARK_THEME.textDim));
    expect(line).not.toContain("\x1b[2m");
  });
});

describe("failed tool preview (2026-10-10)", () => {
  it("shows the failing command's own output under the error line", async () => {
    // What the model receives, shown to the user too: the preview used to stop
    // at `Error: Exit code: 1`, so a refused read looked like a plain failure
    // with no stderr and no nib note under it.
    const { wrapUntrusted } = await import("../tools/untrusted-content.js");
    const ctx = makeCtx(async (_input: string, cb: any) => {
      cb.onToolStart("run_bash", { command: 'cat "/Users/x/notes.txt"' });
      cb.onToolResult("run_bash", {
        content:
          `${wrapUntrusted("Exit code: 1\ncat: /Users/x/notes.txt: Operation not permitted")}\n` +
          "[nib] The OS sandbox blocked that path. Files in your home directory outside the workspace can be read with read_file, list_files or glob — a shell command cannot reach them.",
        error: "Exit code: 1",
      });
      return { stopReason: "done", messages: [], newMessages: [] };
    });
    const inst = render(<App ctx={ctx} />);
    mounted.push(inst);
    inst.stdin.write("go");
    await flush();
    inst.stdin.write("\r");
    await flush();
    await flush();
    const frame = stripAnsi(inst.lastFrame() ?? "");
    expect(frame).toContain("Error: Exit code: 1");
    expect(frame).toContain("Operation not permitted");
  });
});

describe("a failed turn is still saved", () => {
  it("persists the messages the agent attached to a provider error", async () => {
    // The provider dies mid-turn: the agent rethrows inside its loop, but the
    // tool results and partial text it already produced are attached to the
    // error. Without saving them the next message starts from a history that
    // never saw this turn's work.
    todoStore.reset();
    const assistant: any = { role: "assistant", content: "running a command" };
    const toolResult: any = { role: "tool", toolCallId: "call_1", toolName: "run_bash", content: "hi" };
    const fullHistory = [{ role: "user", content: "go" }, assistant, toolResult];

    const appended: any[] = [];
    const ctx = makeCtx(async (_input: string, cb: any) => {
      cb.onText("running");
      const err = new Error("Connection error.") as Error & { newMessages?: any[]; messages?: any[] };
      err.newMessages = [assistant, toolResult];
      err.messages = fullHistory;
      throw err;
    });
    (ctx.sessionStore as any).appendMessage = async (_id: string, msg: any) => {
      appended.push(msg);
    };

    const inst = render(<App ctx={ctx} />);
    mounted.push(inst);
    inst.stdin.write("go");
    await flush();
    inst.stdin.write("\r");
    await flush();
    await flush();
    await flush();

    // The error still reaches the screen...
    expect(stripAnsi(inst.lastFrame() ?? "")).toContain("Error: Connection error.");
    // ...and the turn it killed is in the session record and in history.
    expect(appended.some((m) => m.content === "running a command")).toBe(true);
    expect(appended.some((m) => m.content === "hi")).toBe(true);
    expect(ctx.mutable.conversationHistory).toEqual(fullHistory);
  });

  it("saves nothing extra when the error carries no messages", async () => {
    todoStore.reset();
    const appended: any[] = [];
    const ctx = makeCtx(async () => {
      throw new Error("Connection error.");
    });
    (ctx.sessionStore as any).appendMessage = async (_id: string, msg: any) => {
      appended.push(msg);
    };

    const inst = render(<App ctx={ctx} />);
    mounted.push(inst);
    inst.stdin.write("go");
    await flush();
    inst.stdin.write("\r");
    await flush();
    await flush();
    await flush();

    expect(stripAnsi(inst.lastFrame() ?? "")).toContain("Error: Connection error.");
    expect(appended).toEqual([]);
    expect(ctx.mutable.conversationHistory).toEqual([]);
  });
});

describe("a max_turns stop", () => {
  it("is saved like any other turn and reports the request count", async () => {
    // The old notice claimed "Session saved." while only done/aborted turns
    // were written, so the next message started without the work.
    todoStore.reset();
    const appended: any[] = [];
    const history = [
      { role: "user", content: "go" },
      { role: "assistant", content: "partial work" },
    ];
    const ctx = makeCtx(async (_input: string, cb: any) => {
      cb.onMaxTurns(history, 3);
      return { stopReason: "max_turns", messages: history, newMessages: [history[1]] };
    });
    (ctx.sessionStore as any).appendMessage = async (_id: string, msg: any) => {
      appended.push(msg);
    };

    const inst = render(<App ctx={ctx} />);
    mounted.push(inst);
    inst.stdin.write("go");
    await flush();
    inst.stdin.write("\r");
    await flush();
    await flush();
    await flush();

    expect(stripAnsi(inst.lastFrame() ?? "")).toContain("⚠ stopped after 3 model requests (--max-turns)");
    expect(appended.some((m) => m.content === "partial work")).toBe(true);
    expect(ctx.mutable.conversationHistory).toEqual(history);
  });
});

describe("a streamed sentence stays one line", () => {
  // Raw model text with no newline must never be committed in two pieces —
  // the user saw "…It froze" / " before my rm." split onto separate rows.
  async function streamWith(between?: (cb: any) => void): Promise<string> {
    const ctx = makeCtx(async (_input: string, cb: any) => {
      cb.onText("The block froze early. It froze");
      between?.(cb);
      cb.onText(" before my rm. Definitive check:");
      cb.onToolStart("run_bash", { command: "ls" });
      cb.onToolResult("run_bash", { content: "ok" });
      return { stopReason: "done", messages: [], newMessages: [] };
    });
    const inst = render(<App ctx={ctx} />);
    mounted.push(inst);
    inst.stdin.write("go");
    await flush();
    inst.stdin.write("\r");
    await flush();
    await flush();
    return stripAnsi(inst.lastFrame() ?? "");
  }

  it("commits a chunk boundary inside a sentence as one line", async () => {
    expect(await streamWith()).toContain("It froze before my rm.");
  });

  it("is not split by a background sub-agent's progress mid-sentence", async () => {
    const frame = await streamWith((cb) =>
      cb.onSubagentProgress?.({ kind: "tool", name: "run_bash", args: { command: "pwd" }, depth: 1 }),
    );
    expect(frame).toContain("It froze before my rm.");
  });
});

describe("block spacing around tool calls (2026-10-12)", () => {
  /** Rows strictly between the first row containing `a` and the next containing `b`. */
  function between(frame: string, a: string, b: string): string[] {
    const rows = frame.split("\n");
    const i = rows.findIndex((r) => r.includes(a));
    const j = rows.findIndex((r, k) => k > i && r.includes(b));
    return rows.slice(i + 1, j);
  }

  async function run(script: (cb: any) => void): Promise<string> {
    const ctx = makeCtx(async (_input: string, cb: any) => {
      script(cb);
      return { stopReason: "done", messages: [], newMessages: [] };
    });
    const inst = render(<App ctx={ctx} />);
    mounted.push(inst);
    inst.stdin.write("go");
    await flush();
    inst.stdin.write("\r");
    await flush();
    await flush();
    return stripAnsi(inst.lastFrame() ?? "");
  }

  it("leaves exactly one blank row between an answer and the next tool call", async () => {
    // The answer usually ends with its own blank line; onToolStart added a
    // second one on top, so tool calls sat two rows below the text.
    const frame = await run((cb) => {
      cb.onText("Removing it, then verifying.\n\n");
      cb.onToolStart("run_bash", { command: "echo hi" });
      cb.onToolResult("run_bash", { content: "hi" });
    });
    expect(between(frame, "Removing it", "Bash(")).toEqual([""]);
  });

  it("leaves exactly one blank row between a tool's output and the answer after it", async () => {
    // A one-line answer is held until the turn ends, and that flush path
    // skipped the separator: the answer sat flush against the preview.
    const frame = await run((cb) => {
      cb.onToolStart("run_bash", { command: "echo hi" });
      cb.onToolResult("run_bash", { content: "tool-out" });
      cb.onText("Design is built.");
    });
    expect(between(frame, "tool-out", "Design is built")).toEqual([""]);
  });

  it("still one blank row when the answer after a tool streams in complete paragraphs", async () => {
    const frame = await run((cb) => {
      cb.onToolStart("run_bash", { command: "echo hi" });
      cb.onToolResult("run_bash", { content: "tool-out" });
      cb.onText("\nFirst paragraph.\n\nSecond.\n");
    });
    expect(between(frame, "tool-out", "First paragraph")).toEqual([""]);
  });
});
