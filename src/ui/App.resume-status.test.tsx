import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render } from "ink-testing-library";
import App from "./App.js";
import type { AppContext, StatusSegment } from "./types.js";
import { __resetInputWireForTests } from "./hooks/useTerminalInput.js";
import { stripAnsi } from "./test-helpers.js";
import type { Message } from "../types.js";

// Same doubles as App.streaming.test.tsx: history-store reads ~/.nib at mount,
// so point it at a throwaway, and stub stdout for stray /raw writes.
vi.mock("./core/history-store.js", () => ({
  loadPromptHistory: () => [],
  appendPromptHistory: () => Promise.resolve(),
  HISTORY_CAP: 1000,
}));

const { fakeStdout } = await import("./test-helpers.js");
fakeStdout();

const flush = () => new Promise((r) => setTimeout(r, 60));

const mounted: Array<{ unmount: () => void }> = [];
afterEach(() => {
  while (mounted.length) mounted.pop()!.unmount();
  __resetInputWireForTests();
});

/**
 * A context whose status bar reports the live history size — the same shape
 * cli.tsx's buildStatusBar has for the ctx meter, which is derived from
 * `conversationHistory` (getContextPercent). Every call is recorded with the
 * size it saw, so a test can tell a repaint after the resume from the stale
 * value the bar was initialized with.
 */
function makeCtx(): { ctx: AppContext; barSaw: number[] } {
  const barSaw: number[] = [];
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
    buildStatusBar: (): StatusSegment[] => {
      const size = ctx.mutable.conversationHistory.length;
      barSaw.push(size);
      return [{ id: "ctx", text: `ctx:${size}` }];
    },
    getPromptStr: () => "❯",
    getColorEnabled: () => false,
    logSessionEnd: async () => null,
    onExit: () => {},
    handleSlash: async () => [],
    getModelEntries: () => [],
    runAgentTurnCore: async () => ({ stopReason: "done", messages: [], newMessages: [] }),
    theme: undefined,
    keybindings: undefined,
    keybindingConfig: undefined,
    workflowConfig: undefined,
    gitStatus: null,
  } as any as AppContext;
  return { ctx, barSaw };
}

describe("resume replay refreshes the status bar", () => {
  it("rebuilds the ctx meter once the resumed transcript is replayed", async () => {
    const resumed: Message[] = [
      { role: "user", content: "first question" },
      { role: "assistant", content: "first answer" },
    ];
    const { ctx, barSaw } = makeCtx();
    // The startup resume path (cli.tsx --resume/--continue): the store's
    // transcript drives the load/compact chooser.
    ctx.initialMessages = resumed;
    // The bar is initialized at mount, before the load — the stale ~0% the
    // meter used to keep forever.
    expect(barSaw).toEqual([]);

    const inst = render(<App ctx={ctx} />);
    mounted.push(inst);
    await flush();
    expect(barSaw).toEqual([0]);
    expect(stripAnsi(inst.lastFrame() ?? "")).toContain("Resume session");

    // The host seeds the live history when the session is resumed, then the
    // user picks "Load entirely" (the first option, so Enter).
    ctx.mutable.conversationHistory = resumed;
    inst.stdin.write("\r");
    await flush();
    await flush();

    // The replay rebuilt the bar from the resumed history — without it the
    // remounted input kept rendering the mount-time "ctx:0".
    expect(barSaw[barSaw.length - 1]).toBe(resumed.length);
    const frame = stripAnsi(inst.lastFrame() ?? "");
    expect(frame).toContain("first answer");
    expect(frame).toContain(`ctx:${resumed.length}`);
    expect(frame).not.toContain("ctx:0");
  });
});
