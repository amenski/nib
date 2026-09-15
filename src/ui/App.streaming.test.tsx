import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render } from "ink-testing-library";
import App from "./App.js";
import type { AppContext } from "./types.js";
import { __resetInputWireForTests } from "./hooks/useTerminalInput.js";
import { stripAnsi } from "./test-helpers.js";
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
    await flush();
    let frame = stripAnsi(inst.lastFrame() ?? "");
    expect(frame).toContain("Modes");
    expect(frame).toContain("code");
    expect(frame).toContain("general");
    expect(frame).not.toContain("architect");

    // Enter selects the first listed mode (listAll is alphabetical → code),
    // which routes through /mode <slug>.
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
    expect(frame).toContain("⏺ update_todo_list");
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

  it("keeps a wrapped list item under one bullet", async () => {
    const { lastFrame } = await runTurn("hi", ["- item one\n", "  wrapped\n", "plain\n"]);
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("item one");
    expect(frame).toContain("wrapped");
    expect(frame).toContain("plain");
    const bullets = frame.split("\n").filter((l) => l.includes("•")).length;
    // "item one" and its wrapped continuation share one bullet; "plain" is a
    // plain line.
    expect(bullets).toBe(1);
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
    // bare "●" row above the next tool call.
    const { lastFrame } = await runTurn("hi", ["all done.\n\n"]);
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("all done.");
    expect(frame.split("\n").filter((l) => l.trim() === "●")).toHaveLength(0);
  });

  it("bullets the first real line when the block opens with a blank", async () => {
    const { lastFrame } = await runTurn("hi", ["\nall done.\n"]);
    const frame = stripAnsi(lastFrame() ?? "");
    const answer = frame.split("\n").find((l) => l.includes("all done."));
    expect(answer).toContain("●");
    expect(frame.split("\n").filter((l) => l.trim() === "●")).toHaveLength(0);
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
});

describe("background jobs (plan §3)", () => {
  afterEach(() => {
    jobManager.killAll();
  });

  it("streams a model-started job's output as dim transcript rows and shows a completion segment", async () => {
    const ctx = makeCtx(async () => ({ stopReason: "done", messages: [], newMessages: [] }));
    const inst = render(<App ctx={ctx} />);
    mounted.push(inst);
    await flush();

    const result = jobManager.start("echo job-stream-row", process.cwd(), 5000, { stream: true });
    expect(result.ok).toBe(true);
    const shortId = result.ok ? result.id.slice(0, 4) : "";

    // Wait for the job to finish and the 200ms coalesce flush to land.
    const deadline = Date.now() + 5000;
    let frame = stripAnsi(inst.lastFrame() ?? "");
    while (!frame.includes(`[job ${shortId}] job-stream-row`) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
      frame = stripAnsi(inst.lastFrame() ?? "");
    }
    expect(frame).toContain(`[job ${shortId}] job-stream-row`);
    // Per-job ids stay out of the bar; a single completed job collapses to
    // the aggregate summary segment.
    expect(frame).toContain("● 1 job done · 1 line");
  });

  it("stays silent in the transcript for a non-streamable (timeout-migrated) job", async () => {
    const ctx = makeCtx(async () => ({ stopReason: "done", messages: [], newMessages: [] }));
    const inst = render(<App ctx={ctx} />);
    mounted.push(inst);
    await flush();

    const result = jobManager.start("echo not-streamed-row", process.cwd(), 5000);
    expect(result.ok).toBe(true);
    const deadline = Date.now() + 5000;
    let frame = stripAnsi(inst.lastFrame() ?? "");
    while (!frame.includes("● 1 job done · 1 line") && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
      frame = stripAnsi(inst.lastFrame() ?? "");
    }
    // The completion segment appeared, but no live output rows (decision E).
    expect(frame).toContain("● 1 job done · 1 line");
    expect(frame).not.toContain("[not-streamed-row]");
    expect(frame).not.toContain("not-streamed-row");
  });
});
