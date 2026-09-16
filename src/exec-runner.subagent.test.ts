import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { projectDirPath, projectSettingsPath } from "./config/paths.js";
import { tmpdir } from "node:os";
import type { StreamEvent } from "./providers/types.js";
import type { Message, ToolCall } from "./types.js";
import type { ExecInputStream } from "./exec-input.js";
import { trustSettings } from "./config/settings-trust.js";

// Headless async sub-agent continuation (async-subagents.md §2): a `-p` run
// whose parent spawns sub-agents and ends its turn must keep going until every
// sub-run has completed and every delivered result has been processed.
//
// Unlike exec-runner.test.ts (which stubs the registry to keep the permission
// tests free of tool plumbing), this file mocks ./tools/index.js with a REAL
// ToolRegistry whose executeTool dispatches through the orchestrator — that is
// the only way the parent's new_task call reaches the async spawn.

const TEST_DIR = join(tmpdir(), `nib-exec-subagent-${process.pid}`);
const HOME_DIR = join(TEST_DIR, "home");
const PROJECT_DIR = join(TEST_DIR, "project");

// ── Content-keyed scripted provider ──
//
// The parent run and each detached sub-run share ONE provider object
// (exec-runner's orchestrator factory returns the run's provider when no model
// override), and sub-run calls interleave with the parent's follow-up turns in
// no guaranteed order. So the script for each streamChat call is chosen by
// WHAT the request contains, not by call index:
//   - the first call is always the parent's spawn turn;
//   - sub-runs have exactly one user message (their description) and no
//     history — keyed by the description text;
//   - parent calls are keyed by the delivered-result message and by the spawn
//     confirmation tool results already in the request.
// Callers then resolve to their own script no matter when they run.

type TurnScript = () => StreamEvent[];

const textTurn = (text: string): TurnScript => () => [
  { type: "text_delta", content: text },
  { type: "done", finishReason: "stop" },
];

const toolCallTurn = (id: string, name: string, args: string): TurnScript => () => [
  { type: "tool_call_start", id, name },
  { type: "tool_call_delta", id, arguments: args },
  { type: "done", finishReason: "tool_calls" },
];

interface ContentKeyedOptions {
  /** The parent's first turn (always the initial spawn). */
  first: TurnScript;
  /** Keyed on the full request text, checked in order. */
  parentTurns: Array<[string, TurnScript]>;
  /** Keyed on the request text for sub-runs (exactly one user message). */
  subRuns: Array<[string, TurnScript]>;
  /** Any call matching nothing else (e.g. the parent's plain follow-up). */
  fallback: TurnScript;
}

function contentKeyedProvider(opts: ContentKeyedOptions) {
  let first = true;
  const lastUserInputs: string[] = [];
  return {
    name: "fake",
    lastUserInputs,
    async *streamChat(messages: Message[]): AsyncGenerator<StreamEvent> {
      const text = JSON.stringify(messages);
      const lastUser = [...messages].reverse().find((m) => m.role === "user");
      lastUserInputs.push(typeof lastUser?.content === "string" ? lastUser.content : "");
      const userCount = messages.filter((m) => m.role === "user").length;
      let script: TurnScript;
      if (first) {
        first = false;
        script = opts.first;
      } else if (userCount === 1) {
        script = opts.subRuns.find(([key]) => text.includes(key))?.[1] ?? opts.fallback;
      } else {
        script = opts.parentTurns.find(([key]) => text.includes(key))?.[1] ?? opts.fallback;
      }
      for (const e of script()) yield e;
    },
  };
}

let providerFactory: (name: string, options?: unknown) => unknown = () => ({ name: "fake", async *streamChat() {} });
const createProviderSpy = vi.fn();
vi.mock("./providers/presets.js", () => ({
  initPresets: () => {},
  getPreset: () => undefined,
  createProvider: (name: string, options?: unknown) => {
    createProviderSpy(name, options);
    return providerFactory(name, options);
  },
}));

// Real registry: orchestrator.register() lands new_task on it, getAllDefs()
// feeds the parent's tool set, and executeTool dispatches the parent's
// new_task call into the orchestrator handler.
vi.mock("./tools/index.js", async () => {
  const { ToolRegistry } = await import("./tools/registry.js");
  const registry = new ToolRegistry();
  return {
    registry,
    executeTool: (call: ToolCall) =>
      registry.execute(call, {
        workingDir: process.cwd(),
        sessionId: "headless-test",
        signal: new AbortController().signal,
        fileMtimes: new Map(),
      }),
    setSessionId: () => {},
    setSignal: () => {},
    setTimeoutToBackground: () => {},
    setSandboxLevel: () => {},
    setSessionTempDir: () => {},
    setWritePolicyLevel: () => {},
    setWriteRoots: () => {},
    setWebSearchConfig: () => {},
  };
});

const fireNotifySpy = vi.fn();
vi.mock("./notify.js", () => ({
  fireNotify: (...args: unknown[]) => fireNotifySpy(...args),
}));

function nonTtyInput(): ExecInputStream {
  return {
    isTTY: false,
    async *[Symbol.asyncIterator]() {
      /* empty stdin */
    },
  };
}

function writeSettings(settings: Record<string, unknown>): void {
  mkdirSync(projectDirPath(PROJECT_DIR), { recursive: true });
  writeFileSync(projectSettingsPath(PROJECT_DIR), JSON.stringify(settings), "utf-8");
}

async function run(): Promise<{ code: number; output: string }> {
  const { runExecMode } = await import("./exec-runner.js");
  const chunks: string[] = [];
  const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: any) => {
    chunks.push(String(chunk));
    return true;
  });
  const outSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: any) => {
    chunks.push(String(chunk));
    return true;
  });
  try {
    const code = await runExecMode({
      prompt: "orchestrate the work",
      projectRoot: PROJECT_DIR,
      input: nonTtyInput(),
    });
    return { code, output: chunks.join("") };
  } finally {
    writeSpy.mockRestore();
    outSpy.mockRestore();
  }
}

describe("runExecMode async sub-agent continuation (async-subagents.md §2)", () => {
  beforeEach(() => {
    mkdirSync(PROJECT_DIR, { recursive: true });
    mkdirSync(HOME_DIR, { recursive: true });
    process.env.NIB_HOME = HOME_DIR;
    createProviderSpy.mockClear();
    fireNotifySpy.mockClear();
    // new_task must be allowed (default askAll would resolve it to an ask,
    // and headless denies asks).
    writeSettings({
      permissions: {
        defaultMode: "allowAll",
        rules: [{ tool: "new_task", pattern: "any", action: "allow" }],
      },
    });
    // permissions is an execution-capable key (settings-trust.ts) — trust the
    // project settings file so the configured allow rule actually reaches the
    // PermissionEngine instead of being stripped to the ask-all default.
    trustSettings(projectSettingsPath(PROJECT_DIR));
  });

  afterEach(() => {
    delete process.env.NIB_HOME;
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("continues the loop after the parent ends its turn: sub-run result wakes a new turn, then the run settles", async () => {
    const provider = contentKeyedProvider({
      // Turn 1: the parent spawns a sub-agent and (per the async contract)
      // ends its turn after the spawn.
      first: toolCallTurn("call-1", "new_task", JSON.stringify({ description: "sub work", mode: "code" })),
      // Turn 2: the parent's reply after seeing the spawn confirmation.
      parentTurns: [
        // The wake turn: the parent processes the delivered result.
        ["Sub-agent result (task task-1)", textTurn("final synthesis")],
      ],
      // The detached sub-run's own turn.
      subRuns: [["sub work", textTurn("sub answer")]],
      fallback: textTurn("spawned — awaiting the result"),
    });
    providerFactory = () => provider;

    const { code, output } = await run();

    expect(code).toBe(0);
    // The run's stdout is the final reply, unchanged by the wake loop.
    expect(output).toContain("final synthesis");

    // The wake turn's input was the delivered result message.
    const wakeInput = provider.lastUserInputs.find((t) => t.includes("Sub-agent result (task task-1)"));
    expect(wakeInput).toBeDefined();
    expect(wakeInput).toContain("**Task**: sub work");
    expect(wakeInput).toContain("**Result**: sub answer");
  });

  it("a wake turn can spawn again, and the loop drains every pending result before exiting", async () => {
    const provider = contentKeyedProvider({
      // Parent turn 1: spawn A.
      first: toolCallTurn("call-1", "new_task", JSON.stringify({ description: "first sub", mode: "code" })),
      parentTurns: [
        // Wake turn 2 (B's result delivered): the parent synthesizes.
        ["Sub-agent result (task task-2)", textTurn("everything is done")],
        // Parent follow-up after spawning B: ends its turn, awaiting B.
        ["task task-2 spawned", textTurn("spawned B — awaiting the result")],
        // Wake turn 1 (A's result delivered): the parent spawns B.
        ["Sub-agent result (task task-1)", toolCallTurn("call-2", "new_task", JSON.stringify({ description: "second sub", mode: "code" }))],
      ],
      subRuns: [
        ["first sub", textTurn("first result")],
        ["second sub", textTurn("second result")],
      ],
      fallback: textTurn("spawned first"),
    });
    providerFactory = () => provider;

    const { code, output } = await run();

    expect(code).toBe(0);
    expect(output).toContain("everything is done");

    // Both delivered results reached the parent as wake turns.
    const wake1 = provider.lastUserInputs.find((t) => t.includes("Sub-agent result (task task-1)"));
    const wake2 = provider.lastUserInputs.find((t) => t.includes("Sub-agent result (task task-2)"));
    expect(wake1).toContain("**Result**: first result");
    expect(wake2).toContain("**Result**: second result");
  });
});
