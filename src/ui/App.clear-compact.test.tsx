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

function makeCtx(handleSlash: (input: string) => Promise<string[]>): AppContext {
  return {
    mutable: {
      conversationHistory: [{ role: "user", content: "old question" }],
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
    buildStatusBar: () => [],
    getPromptStr: () => "❯",
    getColorEnabled: () => false,
    logSessionEnd: async () => null,
    onExit: () => {},
    handleSlash,
    getModelEntries: () => [],
    runAgentTurnCore: vi.fn(async () => ({ stopReason: "done", messages: [], newMessages: [] })),
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

const mounted: Array<{ unmount: () => void }> = [];
afterEach(() => {
  while (mounted.length) mounted.pop()!.unmount();
  __resetInputWireForTests();
  todoStore.reset();
});

describe("/clear and /compact (2026-10-12)", () => {
  it("/clear wipes the transcript from the screen, not just the history", async () => {
    const ctx = makeCtx(async () => ["handled by cli"]);
    const inst = render(<App ctx={ctx} />);
    mounted.push(inst);

    inst.stdin.write("/not-a-command");
    await flush();
    inst.stdin.write("\r");
    await until(() => stripAnsi(inst.lastFrame() ?? "").includes("handled by cli"));

    inst.stdin.write("/clear");
    await flush();
    inst.stdin.write("\r");
    await until(() => stripAnsi(inst.lastFrame() ?? "").includes("[cleared]"));

    const frame = stripAnsi(inst.lastFrame() ?? "");
    expect(frame).toContain("[cleared]");
    expect(frame).not.toContain("handled by cli");
    expect(frame).not.toContain("/not-a-command");
    expect(ctx.mutable.conversationHistory).toEqual([]);
  });

  it("/compact shows a working indicator until the summary returns", async () => {
    let finish: (lines: string[]) => void = () => {};
    const ctx = makeCtx((input) =>
      input === "/compact" ? new Promise((r) => { finish = r; }) : Promise.resolve([]),
    );
    const inst = render(<App ctx={ctx} />);
    mounted.push(inst);

    inst.stdin.write("/compact");
    await flush();
    inst.stdin.write("\r");
    await until(() => stripAnsi(inst.lastFrame() ?? "").includes("compacting…"));
    expect(stripAnsi(inst.lastFrame() ?? "")).toContain("compacting…");

    finish(["[compacted 4 turns · kept 2 recent]"]);
    await until(() => !stripAnsi(inst.lastFrame() ?? "").includes("compacting…"));

    const frame = stripAnsi(inst.lastFrame() ?? "");
    expect(frame).not.toContain("compacting…");
    expect(frame).toContain("[compacted 4 turns · kept 2 recent]");
  });
});

describe("todo panel spacing (2026-10-12)", () => {
  it("leaves one blank row between the transcript and the checklist", async () => {
    const ctx = makeCtx(async () => ["… +102 lines"]);
    const inst = render(<App ctx={ctx} />);
    mounted.push(inst);

    inst.stdin.write("/not-a-command");
    await flush();
    inst.stdin.write("\r");
    await until(() => stripAnsi(inst.lastFrame() ?? "").includes("+102 lines"));
    todoStore.setTodos([{ content: "Recon constraints", status: "completed" } as any]);
    await until(() => stripAnsi(inst.lastFrame() ?? "").includes("Recon constraints"));

    const rows = stripAnsi(inst.lastFrame() ?? "").split("\n");
    const todoRow = rows.findIndex((r) => r.includes("Recon constraints"));
    expect(rows[todoRow - 1].trim()).toBe("");
    expect(rows[todoRow - 2]).toContain("+102 lines");
  });
});
