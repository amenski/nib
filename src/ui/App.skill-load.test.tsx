import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render } from "ink-testing-library";
import App from "./App.js";
import type { AppContext } from "./types.js";
import { __resetInputWireForTests } from "./hooks/useTerminalInput.js";
import { stripAnsi } from "./test-helpers.js";
import { todoStore } from "../tools/todo.js";
import { buildSkillLoadMessage, SKILL_APPLY_PROMPT } from "./core/skill-load.js";

// App's promptHistory initializer reads ~/.heirloom at mount; point it at a
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
function makeHarness(skillNames: string[]): Harness {
  const slashCalls: string[] = [];
  let historyAtTurnSnapshot: any[] = [];
  const runAgentTurnCore = vi.fn(async () => {
    historyAtTurnSnapshot = [...ctx.mutable.conversationHistory];
    return { stopReason: "done", messages: [], newMessages: [] };
  });

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
      return [`Skill "${name}" loaded into conversation (1.0 KB).`];
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

describe("/skill force-load starts a turn", () => {
  it("starts a turn with the apply prompt after loading a known skill", async () => {
    const h = makeHarness(["update-docs"]);
    const inst = render(<App ctx={h.ctx} />);
    mounted.push(inst);

    await typeCommand(inst, "/skill update-docs");

    expect(h.slashCalls).toEqual(["/skill update-docs"]);
    // The whole point of the fix: loading alone left the skill inert.
    expect(h.runAgentTurnCore).toHaveBeenCalledTimes(1);
    expect(h.runAgentTurnCore.mock.calls[0][0]).toBe(SKILL_APPLY_PROMPT);
    // The skill really is in the history the turn reads.
    expect(h.historyAtTurn()[0].content).toContain("update-docs BODY");
  });

  it("does not echo the synthetic prompt as a user message in the transcript", async () => {
    const h = makeHarness(["update-docs"]);
    const inst = render(<App ctx={h.ctx} />);
    mounted.push(inst);

    await typeCommand(inst, "/skill update-docs");

    const frame = stripAnsi(inst.lastFrame() ?? "");
    expect(frame).toContain('Skill "update-docs" loaded into conversation');
    // Suppressed: the user never typed the apply prompt.
    expect(frame).not.toContain(SKILL_APPLY_PROMPT);
  });

  it("does not start a turn for an unknown skill", async () => {
    const h = makeHarness(["update-docs"]);
    const inst = render(<App ctx={h.ctx} />);
    mounted.push(inst);

    await typeCommand(inst, "/skill does-not-exist");

    expect(h.runAgentTurnCore).not.toHaveBeenCalled();
    expect(stripAnsi(inst.lastFrame() ?? "")).toContain("Unknown skill");
  });

  it("does not mistake the /skills list command for a force-load", async () => {
    const h = makeHarness(["update-docs"]);
    const inst = render(<App ctx={h.ctx} />);
    mounted.push(inst);

    await typeCommand(inst, "/skills");

    expect(h.runAgentTurnCore).not.toHaveBeenCalled();
  });
});
