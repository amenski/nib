import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render } from "ink-testing-library";
import App from "./App.js";
import type { AppContext } from "./types.js";
import { __resetInputWireForTests } from "./hooks/useTerminalInput.js";
import { stripAnsi } from "./test-helpers.js";
import { todoStore } from "../tools/todo.js";
import { buildSkillLoadMessage, skillLoadMarker } from "./core/skill-load.js";

// App's promptHistory initializer reads ~/.nib at mount; point it at a
// throwaway implementation so these tests never touch real history.
vi.mock("./core/history-store.js", () => ({
  loadPromptHistory: () => [],
  appendPromptHistory: () => Promise.resolve(),
  HISTORY_CAP: 1000,
}));

const { fakeStdout } = await import("./test-helpers.js");
fakeStdout();

interface Harness {
  ctx: AppContext;
  runAgentTurnCore: ReturnType<typeof vi.fn>;
  /** The lines ctx.handleSlash returns; recorded so tests can assert the call. */
  slashCalls: string[];
  /** conversationHistory as the turn saw it — the input the model would receive. */
  historyAtTurn: () => any[];
}

/**
 * A harness whose handleSlash mirrors cli.tsx's `/skill` case: it appends the
 * load message to conversationHistory (so `shared.conversationHistory` really
 * holds the skill, as in production) and returns the confirmation line.
 */
function makeHarness(
  skillNames: string[],
  runner?: (input: string, cb: any) => Promise<any>,
): Harness {
  const slashCalls: string[] = [];
  let historyAtTurnSnapshot: any[] = [];
  const runAgentTurnCore = vi.fn(runner ?? (async () => {
    historyAtTurnSnapshot = [...ctx.mutable.conversationHistory];
    return { stopReason: "done", messages: [], newMessages: [] };
  }));

  const ctx = {
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
    skills: skillNames.map((name) => ({ name, description: `${name} desc`, content: `${name} BODY` })),
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
    handleSlash: async (input: string) => {
      slashCalls.push(input);
      const name = input.replace(/^\/skill\s+/, "").trim();
      const skill = skillNames.includes(name);
      if (!skill) return [`Unknown skill: ${name}`];
      ctx.mutable.conversationHistory.push(buildSkillLoadMessage(name, `${name} BODY`));
      return [];
    },
    getModelEntries: () => [],
    runAgentTurnCore,
    theme: undefined,
    keybindings: undefined,
    keybindingConfig: undefined,
    workflowConfig: undefined,
    gitStatus: null,
  } as any as AppContext;

  return { ctx, runAgentTurnCore, slashCalls, historyAtTurn: () => historyAtTurnSnapshot };
}

const flush = () => new Promise((r) => setTimeout(r, 60));

const mounted: Array<{ unmount: () => void }> = [];
afterEach(() => {
  while (mounted.length) mounted.pop()!.unmount();
  __resetInputWireForTests();
  todoStore.reset();
});

async function typeCommand(inst: ReturnType<typeof render>, text: string): Promise<void> {
  inst.stdin.write(text);
  await flush();
  inst.stdin.write("\r");
  // The load is async (handleSlash promise), then the turn starts — give both
  // beats to settle through React.
  await flush();
  await flush();
  await flush();
}

describe("/skill loads, and runs only with the user's words", () => {
  it("does not start a turn for a bare /skill <name>", async () => {
    const h = makeHarness(["update-docs"]);
    const inst = render(<App ctx={h.ctx} />);
    mounted.push(inst);

    await typeCommand(inst, "/skill update-docs");

    expect(h.slashCalls).toEqual(["/skill update-docs"]);
    // The whole point: loading is not an instruction. It used to start a turn
    // with a synthetic "apply the skill you just loaded" prompt, which began
    // work the user had not asked for.
    expect(h.runAgentTurnCore).not.toHaveBeenCalled();
    // The skill IS loaded — in the history, ready for the next message.
    expect(h.ctx.mutable.conversationHistory[0].content).toContain("update-docs BODY");
    expect(stripAnsi(inst.lastFrame() ?? "")).toContain(
      "Skill update-docs loaded — your next message will use it.",
    );
  });

  it("runs the trailing instruction as the turn prompt", async () => {
    const h = makeHarness(["task-loop"]);
    const inst = render(<App ctx={h.ctx} />);
    mounted.push(inst);

    await typeCommand(inst, "/skill task-loop implement phase 1");

    // The command is passed to the CLI with the canonical (name-only) form...
    expect(h.slashCalls).toEqual(["/skill task-loop"]);
    // ...and the user's words are the turn, exactly as typed.
    expect(h.runAgentTurnCore).toHaveBeenCalledTimes(1);
    expect(h.runAgentTurnCore.mock.calls[0][0]).toBe("implement phase 1");
    expect(h.historyAtTurn()[0].content).toContain("task-loop BODY");
    // Echoed, so the transcript records what was asked.
    expect(stripAnsi(inst.lastFrame() ?? "")).toContain("implement phase 1");
  });

  it("does not start a turn for an unknown skill", async () => {
    const h = makeHarness(["update-docs"]);
    const inst = render(<App ctx={h.ctx} />);
    mounted.push(inst);

    await typeCommand(inst, "/skill does-not-exist");

    expect(h.runAgentTurnCore).not.toHaveBeenCalled();
    expect(stripAnsi(inst.lastFrame() ?? "")).toContain("Unknown skill");
  });

  it("does not mistake the /skills list command for a load", async () => {
    const h = makeHarness(["update-docs"]);
    const inst = render(<App ctx={h.ctx} />);
    mounted.push(inst);

    await typeCommand(inst, "/skills");

    expect(h.runAgentTurnCore).not.toHaveBeenCalled();
  });

  it("picking a skill from /skills fills the input and waits for Enter", async () => {
    const h = makeHarness(["update-docs"]);
    const inst = render(<App ctx={h.ctx} />);
    mounted.push(inst);

    // Open the picker, then Enter on the highlighted skill.
    inst.stdin.write("/skills");
    await flush();
    inst.stdin.write("\r");
    await flush();
    inst.stdin.write("\r"); // select "update-docs"
    await flush();
    await flush();

    // Nothing has loaded yet: no slash call, no turn, no history entry.
    expect(h.slashCalls).toEqual([]);
    expect(h.runAgentTurnCore).not.toHaveBeenCalled();
    expect(h.ctx.mutable.conversationHistory).toHaveLength(0);

    // The input now holds the pending command, waiting for the user's task.
    const frame = stripAnsi(inst.lastFrame() ?? "");
    expect(frame).toContain("/skill update-docs");
    expect(frame).not.toContain("Skill update-docs loaded");

    // Enter runs the unchanged typed path: bare name loads, no turn starts.
    inst.stdin.write("\r");
    await flush();
    await flush();
    await flush();

    expect(h.slashCalls).toEqual(["/skill update-docs"]);
    expect(h.runAgentTurnCore).not.toHaveBeenCalled();
    expect(h.ctx.mutable.conversationHistory[0].content).toContain("update-docs BODY");
  });

});

/**
 * A runner that polls the steering mailbox exactly like the agent loop does
 * (once per decision point), waiting on the observable mailbox state rather
 * than a fixed sleep, and returns the messages a real turn would have built —
 * the injected user message included. Records every poll for assertions.
 */
function midTurnRunner(polled: (string | null)[]): (input: string, cb: any) => Promise<any> {
  return async (_input: string, cb: any) => {
    const deadline = Date.now() + 5000;
    let payload: string | null = null;
    while (payload === null && Date.now() < deadline) {
      payload = cb.pollSteeringMessage();
      if (payload === null) await new Promise((r) => setTimeout(r, 50));
    }
    polled.push(payload);
    return {
      stopReason: "done",
      messages: payload ? [{ role: "user", content: payload }] : [],
      newMessages: [],
    };
  };
}

describe("mid-turn /skill", () => {
  it("injects the skill into the running turn instead of queueing it", async () => {
    // The fake runner polls the steering mailbox exactly like the agent loop
    // does (once per decision point), waiting on the observable mailbox state
    // rather than a fixed sleep, then returns the messages a real turn would
    // have built — the injected user message included.
    const polled: (string | null)[] = [];
    const h = makeHarness(["update-docs"], midTurnRunner(polled));
    const inst = render(<App ctx={h.ctx} />);
    mounted.push(inst);

    inst.stdin.write("first");
    await flush();
    inst.stdin.write("\r");
    await flush();
    // Typed while the turn is in flight.
    inst.stdin.write("/skill update-docs go");
    await flush();
    inst.stdin.write("\r");
    // Wait on the observable outcome — the runner having polled and returned —
    // rather than a fixed number of flushes, so machine load can only delay
    // this, never let the assertions run first.
    const deadline = Date.now() + 5000;
    while (polled.length === 0 && Date.now() < deadline) await flush();

    // The mailbox handed the agent the skill body plus the instruction — not
    // the command line, which is what the queue and the echo show.
    expect(polled[0]).toContain(skillLoadMarker("update-docs"));
    expect(polled[0]).toContain("update-docs BODY");
    expect(polled[0]?.trimEnd().endsWith("go")).toBe(true);

    const frame = stripAnsi(inst.lastFrame() ?? "");
    // The queue/echo line is the command the user typed...
    expect(frame).toContain("/skill update-docs go");
    // ...and the skill body is not echoed into the transcript.
    expect(frame).not.toContain("update-docs BODY");

    // The turn's own messages are the single source of history: the App did not
    // also push the skill into conversationHistory, so nothing was lost to the
    // turn-end overwrite that ate the old `/skills` picker path.
    const history = h.ctx.mutable.conversationHistory as any[];
    expect(history).toHaveLength(1);
    expect(history[0].content).toContain(skillLoadMarker("update-docs"));
    expect(h.slashCalls).toEqual([]);
  });

  it("the /skills picker takes the same path as a typed /skill", async () => {
    // Picking fills the input with `/skill <name> `; Enter then submits it
    // through the same gate a typed `/skill` gets. Mid-turn that gate injects
    // the skill into the running turn instead of queueing it (the old direct
    // handleSlashCommand call pushed into conversationHistory while the turn
    // ran, and the turn's completion overwrote it — the skill was lost).
    const polled: (string | null)[] = [];
    const h = makeHarness(["update-docs"], midTurnRunner(polled));
    const inst = render(<App ctx={h.ctx} />);
    mounted.push(inst);

    inst.stdin.write("first");
    await flush();
    inst.stdin.write("\r");
    await flush();
    // /skills is a modal command, so it opens mid-turn rather than queueing.
    inst.stdin.write("/skills");
    await flush();
    inst.stdin.write("\r");
    await flush();
    inst.stdin.write("\r"); // Enter on the highlighted skill -> fills the input
    await flush();
    inst.stdin.write("\r"); // Enter on the input -> submits the filled command
    const deadline = Date.now() + 5000;
    while (polled.length === 0 && Date.now() < deadline) await flush();

    expect(polled[0]).toContain(skillLoadMarker("update-docs"));
    expect(polled[0]).toContain("update-docs BODY");
    // Loaded once, through the turn that saved it — nothing pushed into the
    // parent array behind the turn's back.
    expect(h.slashCalls).toEqual([]);
    const history = h.ctx.mutable.conversationHistory as any[];
    expect(history).toHaveLength(1);
    expect(history[0].content).toContain("update-docs BODY");
  });
});
