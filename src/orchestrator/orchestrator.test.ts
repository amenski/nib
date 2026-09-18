import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync, rmSync } from "node:fs";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectDirPath } from "../config/paths.js";
import { Orchestrator } from "./index.js";
import { ToolRegistry } from "../tools/registry.js";
import { ModeLoader } from "../modes/loader.js";
import { AgentLoader } from "../agents/index.js";
import { PermissionEngine } from "../permissions/index.js";
import { SessionStore, slugify } from "../sessions/store.js";
import { executeTool as realExecuteTool, registry as realRegistry } from "../tools/index.js";
import { todoStore } from "../tools/todo.js";
import type { Provider, StreamEvent } from "../providers/types.js";
import type { Message, ToolDef } from "../types.js";
import type { ToolContext } from "../tools/types.js";

type TurnScript = StreamEvent[];

function makeProvider(turns: TurnScript[]) {
  const received: { messages: Message[]; tools: ToolDef[] }[] = [];
  let call = 0;
  const provider: Provider = {
    name: "fake",
    async *streamChat(messages, tools) {
      received.push({ messages: [...messages], tools: tools ? [...tools] : [] });
      const events = turns[call] ?? [];
      call++;
      for (const event of events) yield event;
    },
  };
  return { provider, received };
}

/** Collects the async result deliveries (async-subagents.md §2) and awaits a
 *  specific count of them — the async replacement for asserting the summary
 *  directly on the tool output. */
function trackDeliveries() {
  const messages: string[] = [];
  const waiters: Array<() => void> = [];
  return {
    messages,
    onResult: (_taskId: string, message: string) => {
      messages.push(message);
      waiters.shift()?.();
    },
    async delivered(count = 1): Promise<string> {
      while (messages.length < count) {
        await new Promise<void>((resolve) => waiters.push(resolve));
      }
      return messages[count - 1];
    },
  };
}

/** A provider whose stream blocks until `release()` — keeps a sub-run
 *  "running" so the concurrency cap / abort tests can observe it mid-flight. */
function deferredProvider(): { provider: Provider; release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const provider: Provider = {
    name: "fake",
    async *streamChat() {
      await gate;
      yield { type: "text_delta", content: "released" };
      yield { type: "done", finishReason: "stop" };
    },
  };
  return { provider, release };
}

const textTurn = (text: string): TurnScript => [
  { type: "text_delta", content: text },
  { type: "done", finishReason: "stop" },
];

const toolCallTurn = (id: string, name: string, args: string): TurnScript => [
  { type: "tool_call_start", id, name },
  { type: "tool_call_delta", id, arguments: args },
  { type: "done", finishReason: "tool_calls" },
];

const ctx: ToolContext = {
  workingDir: "/workspace",
  sessionId: "test-session",
  signal: new AbortController().signal,
  fileMtimes: new Map(),
};

/** Minimal registry with one read-group and one command-group tool. */
function makeRegistry(): { registry: ToolRegistry; runBash: ReturnType<typeof vi.fn> } {
  const registry = new ToolRegistry();
  const runBash = vi.fn(async (args: Record<string, unknown>) => ({ content: `ran ${String(args.command)}` }));
  registry.register({
    def: { name: "read_file", description: "read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
    handler: async (args) => ({ content: `content of ${String(args.path)}` }),
    groups: ["read"],
  });
  registry.register({
    def: { name: "run_bash", description: "run a command", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
    handler: runBash,
    groups: ["command"],
  });
  return { registry, runBash };
}

describe("Orchestrator", () => {
  // Reset the shared singleton so no todo state leaks between tests.
  afterEach(() => {
    todoStore.reset();
  });
  it("registers new_task in the workflow group and spawns a sub-agent in the requested mode with that mode's tools", async () => {
    const { registry } = makeRegistry();
    const { provider, received } = makeProvider([
      toolCallTurn("c1", "read_file", '{"path":"a.txt"}'),
      textTurn("sub-agent done"),
    ]);
    const deliveries = trackDeliveries();
    const orchestrator = new Orchestrator({
      provider: () => provider,
      registry,
      modeLoader: new ModeLoader(),
      onTaskResult: deliveries.onResult,
    });
    orchestrator.register(registry);

    // The workflow group (orchestrator mode) exposes new_task…
    expect(registry.getByMode(["workflow"]).map((d) => d.name)).toEqual(["new_task"]);

    const out = await registry.execute(
      { id: "t1", name: "new_task", arguments: { description: "read the file", mode: "code" } },
      ctx,
    );

    // Async contract (async-subagents.md §1): the tool returns immediately
    // with the spawn confirmation, not the sub-agent's summary.
    expect(out.error).toBeUndefined();
    expect(out.content).toMatch(/^task task-\d+ spawned — result will follow \(depth 0, 1\/3 sub-agents running\)$/);

    // The summary arrives as a delivered follow-up message.
    const delivered = await deliveries.delivered();
    expect(delivered).toMatch(/^Sub-agent result \(task task-\d+\): /);
    expect(delivered).toContain("**Task**: read the file");
    expect(delivered).toContain("**Tools executed**: 1");
    expect(delivered).toContain("**Result**: sub-agent done");

    // The sub-agent ran with code mode's tool groups (read/edit/command) plus
    // new_task for nested delegation, and its system prompt carries the code
    // role definition — mode is threaded through to the sub-run.
    const subTools = received[0].tools.map((t) => t.name);
    expect(subTools).toEqual(expect.arrayContaining(["read_file", "run_bash", "new_task"]));
    expect(String(received[0].messages[0].content)).toContain("senior software engineer");
  });

  /** A turn that narrates *and* calls a tool — the shape that pushes an
   *  assistant message carrying both `content` and `toolCalls`. */
  const narratedToolCallTurn = (text: string, id: string, name: string, args: string): TurnScript => [
    { type: "text_delta", content: text },
    { type: "tool_call_start", id, name },
    { type: "tool_call_delta", id, arguments: args },
    { type: "done", finishReason: "tool_calls" },
  ];

  it("does not pass a tool-calling turn's narration off as the sub-agent's result", async () => {
    // The regression, reproduced: the sub-agent narrates before each tool call
    // and runs out of turns before answering. The newest assistant message is
    // then a toolCalls message whose content is mid-work narration — reported
    // verbatim as "**Result**: narration before last tool" before the fix.
    const { registry } = makeRegistry();
    const { provider } = makeProvider([
      narratedToolCallTurn("let me look", "c1", "read_file", '{"path":"a.txt"}'),
      narratedToolCallTurn("narration before last tool", "c2", "read_file", '{"path":"b.txt"}'),
    ]);
    const deliveries = trackDeliveries();
    const orchestrator = new Orchestrator({
      provider: () => provider,
      registry,
      modeLoader: new ModeLoader(),
      maxSubTurns: 2,
      onTaskResult: deliveries.onResult,
    });
    orchestrator.register(registry);

    const out = await registry.execute(
      { id: "t1", name: "new_task", arguments: { description: "review it", mode: "code" } },
      ctx,
    );
    expect(out.error).toBeUndefined();

    const delivered = await deliveries.delivered();
    expect(delivered).not.toContain("narration before last tool");
    // …and the turn-limit stop is named, so the parent can re-delegate
    // instead of treating silence as a completed review.
    expect(delivered).toContain("hit its turn limit");
  });

  it("returns the real answer when a later turn narrates past it", async () => {
    const { registry } = makeRegistry();
    const { provider } = makeProvider([
      narratedToolCallTurn("let me look", "c1", "read_file", '{"path":"a.txt"}'),
      textTurn("findings: seatbelt.ts looks fine"),
    ]);
    const deliveries = trackDeliveries();
    const orchestrator = new Orchestrator({
      provider: () => provider,
      registry,
      modeLoader: new ModeLoader(),
      maxSubTurns: 3,
      onTaskResult: deliveries.onResult,
    });
    orchestrator.register(registry);

    const out = await registry.execute(
      { id: "t1", name: "new_task", arguments: { description: "review it", mode: "code" } },
      ctx,
    );
    expect(out.error).toBeUndefined();

    const delivered = await deliveries.delivered();
    expect(delivered).toContain("**Result**: findings: seatbelt.ts looks fine");
    expect(delivered).not.toContain("let me look");
  });

  it("emits start/tool/end progress events so the parent can render live activity", async () => {
    const { registry } = makeRegistry();
    const { provider } = makeProvider([
      toolCallTurn("c1", "read_file", '{"path":"a.txt"}'),
      textTurn("done"),
    ]);
    const events: any[] = [];
    const deliveries = trackDeliveries();
    const orchestrator = new Orchestrator({
      provider: () => provider,
      registry,
      modeLoader: new ModeLoader(),
      onSubagentProgress: (e) => events.push(e),
      onTaskResult: deliveries.onResult,
    });
    orchestrator.register(registry);

    await registry.execute(
      { id: "t1", name: "new_task", arguments: { description: "review it", mode: "code" } },
      ctx,
    );

    // "start" fires synchronously at spawn, before the tool returns.
    expect(events[0]).toMatchObject({ kind: "start", task: "review it", depth: 0 });
    // "tool"/"end" fire during the detached run — wait for the delivery, then
    // assert the full sequence.
    await deliveries.delivered();
    expect(events).toContainEqual(
      expect.objectContaining({ kind: "tool", name: "read_file", args: { path: "a.txt" } }),
    );
    expect(events[events.length - 1]).toMatchObject({ kind: "end", depth: 0 });
  });

  it("re-points the askUser bridge via setAskUser (the interactive per-turn re-wire)", async () => {
    const { registry } = makeRegistry();
    const { provider } = makeProvider([
      toolCallTurn("c1", "run_bash", '{"command":"npm test"}'),
      textTurn("approved path done"),
    ]);
    const permissions = new PermissionEngine(undefined, "/workspace");
    const staleAsk = vi.fn(async () => true);
    const currentAsk = vi.fn(async () => true);
    const deliveries = trackDeliveries();

    const orchestrator = new Orchestrator({
      provider: () => provider,
      registry,
      modeLoader: new ModeLoader(),
      permissions,
      askUser: staleAsk,
      onTaskResult: deliveries.onResult,
    });
    // cli.tsx's runAgentTurnCore calls setAskUser with the fresh per-turn bridge.
    orchestrator.setAskUser(currentAsk);
    orchestrator.register(registry);

    const out = await registry.execute(
      { id: "t1", name: "new_task", arguments: { description: "run tests", mode: "code" } },
      ctx,
    );
    expect(out.error).toBeUndefined();

    // The sub-agent's ask-tier run_bash surfaced to the CURRENT bridge, not the
    // stale one captured at registration. The third argument is the sandbox
    // envelope a session grant could cover: `undefined` here is the structural
    // subagent exclusion — an orchestrator sub-run is never handed one, so it
    // can neither reuse nor create a grant (docs/permission-ux-redesign.md).
    await deliveries.delivered();
    expect(currentAsk).toHaveBeenCalledWith("run_bash", { command: "npm test" }, undefined);
    expect(staleAsk).not.toHaveBeenCalled();
  });

  it("auto-denies ask-tier calls headlessly when no askUser is set", async () => {
    const { registry, runBash } = makeRegistry();
    const { provider } = makeProvider([
      toolCallTurn("c1", "run_bash", '{"command":"npm test"}'),
      textTurn("headless done"),
    ]);
    const permissions = new PermissionEngine(undefined, "/workspace");
    const deliveries = trackDeliveries();

    const orchestrator = new Orchestrator({
      provider: () => provider,
      registry,
      modeLoader: new ModeLoader(),
      permissions,
      onTaskResult: deliveries.onResult,
    });
    orchestrator.register(registry);

    const out = await registry.execute(
      { id: "t1", name: "new_task", arguments: { description: "run tests", mode: "code" } },
      ctx,
    );

    expect(out.error).toBeUndefined();
    await deliveries.delivered();
    expect(runBash).not.toHaveBeenCalled();
  });

  it("caps concurrent sub-agents at 3: a fourth spawn returns a queue-full error", async () => {
    const { registry } = makeRegistry();
    const d1 = deferredProvider();
    const d2 = deferredProvider();
    const d3 = deferredProvider();
    const providers = [d1.provider, d2.provider, d3.provider];
    let pi = 0;
    const deliveries = trackDeliveries();
    const orchestrator = new Orchestrator({
      provider: () => providers[pi++],
      registry,
      modeLoader: new ModeLoader(),
      onTaskResult: deliveries.onResult,
    });
    orchestrator.register(registry);
    const spawn = (d: string) =>
      registry.execute(
        { id: `s-${d}`, name: "new_task", arguments: { description: d, mode: "code" } },
        ctx,
      );

    // Three sub-runs hold their providers open, so the cap is observable.
    const o1 = await spawn("a");
    const o2 = await spawn("b");
    const o3 = await spawn("c");
    expect([o1.error, o2.error, o3.error]).toEqual([undefined, undefined, undefined]);

    const o4 = await spawn("d");
    expect(o4.error).toBe("QUEUE_FULL");
    expect(o4.content).toContain("queue full (3 running)");

    d1.release(); d2.release(); d3.release();
    await deliveries.delivered(3);
  });

  it("aborts a running sub-agent when the parent signal fires (Esc/Ctrl+C)", async () => {
    const { registry } = makeRegistry();
    const d = deferredProvider();
    const controller = new AbortController();
    const deliveries = trackDeliveries();
    const orchestrator = new Orchestrator({
      provider: () => d.provider,
      registry,
      modeLoader: new ModeLoader(),
      getSignal: () => controller.signal,
      onTaskResult: deliveries.onResult,
    });
    orchestrator.register(registry);

    const out = await registry.execute(
      { id: "t1", name: "new_task", arguments: { description: "long task", mode: "code" } },
      ctx,
    );
    expect(out.error).toBeUndefined();

    // Abort mid-run; the sub-run's runAgent sees the signal on its next turn
    // boundary and reports "aborted".
    controller.abort();
    d.release();
    const delivered = await deliveries.delivered();
    expect(delivered).toMatch(/^Sub-agent result \(task task-\d+\): /);
    expect(orchestrator.tasks.list()[0]).toMatchObject({ status: "aborted" });
  });

  it("abortTask stops ONE sub-run: signal fires, record flips, no delivery, siblings survive", async () => {
    const { registry } = makeRegistry();
    const d1 = deferredProvider();
    const d2 = deferredProvider();
    const providers = [d1.provider, d2.provider];
    let pi = 0;
    const deliveries = trackDeliveries();
    const orchestrator = new Orchestrator({
      provider: () => providers[pi++],
      registry,
      modeLoader: new ModeLoader(),
      onTaskResult: deliveries.onResult,
    });
    orchestrator.register(registry);
    const spawn = (d: string) =>
      registry.execute(
        { id: `s-${d}`, name: "new_task", arguments: { description: d, mode: "code" } },
        ctx,
      );

    const o1 = await spawn("a");
    const o2 = await spawn("b");
    expect(o1.error).toBeUndefined();
    expect(o2.error).toBeUndefined();
    const id1 = String(o1.content).match(/task (task-\d+) spawned/)![1];
    const id2 = String(o2.content).match(/task (task-\d+) spawned/)![1];

    // /tasks stop on one task: its record flips, the sibling stays running.
    orchestrator.abortTask(id1);
    expect(orchestrator.tasks.get(id1)?.status).toBe("aborted");
    expect(orchestrator.tasks.get(id2)?.status).toBe("running");

    // The stopped run finishes (signal or not — the registry must not deliver
    // a result for a task the user stopped)…
    d1.release();
    await new Promise((r) => setTimeout(r, 0));
    expect(deliveries.messages).toHaveLength(0);

    // …and the sibling completes normally and delivers.
    d2.release();
    const delivered = await deliveries.delivered();
    expect(delivered).toContain(`Sub-agent result (task ${id2}):`);
  });

  it("gives the sub-agent its own todo store: parent checklist untouched, sub context sees its own plan", async () => {
    // Uses the REAL module-level registry/executeTool (what production wires):
    // the orchestrator threads the sub store through the per-call context, so
    // the sub-run's update_todo_list must hit the sub store, not the singleton.
    const { provider: subProvider, received } = makeProvider([
      toolCallTurn("c1", "update_todo_list", JSON.stringify({
        todos: [
          { content: "Sub step A", status: "pending" },
          { content: "Sub step B", status: "in_progress" },
        ],
      })),
      textTurn("sub done"),
    ]);
    const deliveries = trackDeliveries();
    const orchestrator = new Orchestrator({
      provider: () => subProvider,
      registry: realRegistry,
      modeLoader: new ModeLoader(),
      onTaskResult: deliveries.onResult,
    });
    orchestrator.register(realRegistry);

    const out = await realRegistry.execute(
      { id: "t1", name: "new_task", arguments: { description: "sub plan", mode: "code" } },
      { workingDir: "/workspace", sessionId: "test", signal: new AbortController().signal },
    );

    expect(out.error).toBeUndefined();
    const delivered = await deliveries.delivered();
    expect(delivered).toContain("**Result**: sub done");

    // The sub-agent's update_todo_list wrote to ITS store — the singleton the
    // parent panel subscribes to was never touched.
    expect(todoStore.getTodos()).toEqual([]);

    // The sub-agent's own context got its plan injected on the follow-up turn.
    expect(JSON.stringify(received[0].messages)).not.toContain("# Current todo list");
    expect(JSON.stringify(received[1].messages)).toContain("# Current todo list");
    expect(JSON.stringify(received[1].messages)).toContain("- [pending] Sub step A");
    expect(JSON.stringify(received[1].messages)).toContain("- [in_progress] Sub step B");

    // The parent side is unaffected: a parent-side update lands in the
    // singleton as usual.
    await realExecuteTool({
      id: "t2",
      name: "update_todo_list",
      arguments: { todos: [{ content: "parent step", status: "pending" }] },
    });
    expect(todoStore.getTodos()).toEqual([{ content: "parent step", status: "pending" }]);
  });

  it("caps nesting at maxDepth and never spawns beyond it", async () => {
    const { registry } = makeRegistry();
    const newTaskCall = (description: string) =>
      toolCallTurn("c1", "new_task", JSON.stringify({ description, mode: "code" }));
    const providerFactory = vi.fn(() => {
      const depth = providerFactory.mock.calls.length - 1;
      return makeProvider([
        newTaskCall(`level ${depth + 1}`),
        textTurn(`level ${depth} done`),
      ]).provider;
    });
    const deliveries = trackDeliveries();

    const orchestrator = new Orchestrator({
      provider: providerFactory,
      registry,
      modeLoader: new ModeLoader(),
      onTaskResult: deliveries.onResult,
    });
    orchestrator.register(registry);

    const out = await registry.execute(
      { id: "t1", name: "new_task", arguments: { description: "level 0", mode: "code" } },
      ctx,
    );
    expect(out.error).toBeUndefined();

    // depth 0, 1, 2 spawn sub-agents; the depth-3 request returns MAX_DEPTH
    // without a fourth provider call. Each level's run is detached now, so the
    // whole chain settles as three deliveries.
    await deliveries.delivered(3);
    expect(providerFactory).toHaveBeenCalledTimes(3);
    expect(deliveries.messages.join("\n")).toContain("**Result**: level 0 done");
    expect(deliveries.messages.join("\n")).toContain("**Result**: level 1 done");
    expect(deliveries.messages.join("\n")).toContain("**Result**: level 2 done");
  });

  describe("agent definitions (feature-plans.md §F4)", () => {
    let home: string;
    let project: string;
    let prevHome: string | undefined;

    beforeEach(async () => {
      home = await mkdtemp(join(tmpdir(), "agents-home-"));
      project = await mkdtemp(join(tmpdir(), "agents-proj-"));
      prevHome = process.env.NIB_HOME;
      process.env.NIB_HOME = home;
      await mkdir(join(projectDirPath(project), "agents"), { recursive: true });
    });

    afterEach(async () => {
      if (prevHome === undefined) delete process.env.NIB_HOME;
      else process.env.NIB_HOME = prevHome;
      await rm(home, { recursive: true, force: true });
      await rm(project, { recursive: true, force: true });
    });

    it("runs new_task with agent=<name> using the def's mode and model", async () => {
      const { registry } = makeRegistry();
      const { provider, received } = makeProvider([
        toolCallTurn("c1", "read_file", '{"path":"a.txt"}'),
        textTurn("review done"),
      ]);
      await writeFile(
        join(projectDirPath(project), "agents", "reviewer.md"),
        "---\nname: reviewer\ndescription: reviews code\nmode: code\nmodel: deepseek/deepseek-v4-flash\ninstructions: |\n  Be critical.\n  Cite paths.\n---\n",
      );
      const agentLoader = new AgentLoader();
      await agentLoader.load(project);
      const modelIds: (string | undefined)[] = [];
      const deliveries = trackDeliveries();
      const orchestrator = new Orchestrator({
        provider: (modelId?: string) => {
          modelIds.push(modelId);
          return provider;
        },
        registry,
        modeLoader: new ModeLoader(),
        agents: agentLoader,
        onTaskResult: deliveries.onResult,
      });
      orchestrator.register(registry);

      const out = await registry.execute(
        { id: "t1", name: "new_task", arguments: { description: "review this", agent: "reviewer" } },
        ctx,
      );

      expect(out.error).toBeUndefined();
      const delivered = await deliveries.delivered();
      expect(delivered).toContain("**Result**: review done");
      // The def's model override reached the provider factory as "provider/model".
      expect(modelIds).toEqual(["deepseek/deepseek-v4-flash"]);
      // The sub-agent ran with the def mode's toolset plus new_task.
      const subTools = received[0].tools.map((t) => t.name);
      expect(subTools).toEqual(expect.arrayContaining(["read_file", "run_bash", "new_task"]));
      // The def's instructions prepend the sub-agent's system prompt; the
      // def mode's role definition follows.
      const sys = String(received[0].messages[0].content);
      expect(sys.startsWith("Be critical. Cite paths.")).toBe(true);
      expect(sys).toContain("senior software engineer");
    });

    it("returns UNKNOWN_AGENT listing available names without spawning", async () => {
      const { registry } = makeRegistry();
      const { provider } = makeProvider([textTurn("never used")]);
      await writeFile(
        join(projectDirPath(project), "agents", "reviewer.md"),
        "---\nname: reviewer\ndescription: reviews code\nmode: code\n---\n",
      );
      const agentLoader = new AgentLoader();
      await agentLoader.load(project);
      const providerFactory = vi.fn(() => provider);
      const orchestrator = new Orchestrator({
        provider: providerFactory,
        registry,
        modeLoader: new ModeLoader(),
        agents: agentLoader,
      });
      orchestrator.register(registry);

      const out = await registry.execute(
        { id: "t1", name: "new_task", arguments: { description: "x", agent: "nope" } },
        ctx,
      );

      expect(out.error).toBe("UNKNOWN_AGENT");
      expect(out.content).toContain('Unknown agent: "nope"');
      expect(out.content).toContain("Available agents: reviewer");
      expect(providerFactory).not.toHaveBeenCalled();
    });

    it("without the agent param behaves as today: call-provided mode, parent model, no def content", async () => {
      const { registry } = makeRegistry();
      const { provider, received } = makeProvider([
        toolCallTurn("c1", "read_file", '{"path":"a.txt"}'),
        textTurn("plain done"),
      ]);
      await writeFile(
        join(projectDirPath(project), "agents", "reviewer.md"),
        "---\nname: reviewer\ndescription: reviews code\nmode: code\ninstructions: |\n  Be critical.\n---\n",
      );
      const agentLoader = new AgentLoader();
      await agentLoader.load(project);
      const modelIds: (string | undefined)[] = [];
      const deliveries = trackDeliveries();
      const orchestrator = new Orchestrator({
        provider: (modelId?: string) => {
          modelIds.push(modelId);
          return provider;
        },
        registry,
        modeLoader: new ModeLoader(),
        agents: agentLoader,
        onTaskResult: deliveries.onResult,
      });
      orchestrator.register(registry);

      const out = await registry.execute(
        { id: "t1", name: "new_task", arguments: { description: "read the file", mode: "code" } },
        ctx,
      );

      expect(out.error).toBeUndefined();
      await deliveries.delivered();
      // Parent-model path: factory called with no model id.
      expect(modelIds).toEqual([undefined]);
      // No agent instructions, no agents index in the sub-run preamble — the
      // sub-run is byte-identical to a pre-F4 spawn.
      const sys = String(received[0].messages[0].content);
      expect(sys.startsWith("You are a senior software engineer")).toBe(true);
      expect(sys).not.toContain("Be critical");
      expect(sys).not.toContain("# Available agents");
    });
  });

  describe("sub-agent audit (decision H)", () => {
    // A distinct temp dir (not the store-test one — vitest runs files in
    // parallel workers sharing a cwd, and each file rmSyncs its own).
    const AUDIT_HOME = join(process.cwd(), ".test-sessions-orchestrator");
    const AUDIT_CWD = "/workspace";
    let store: SessionStore;
    let parentId: string;

    beforeEach(async () => {
      vi.spyOn(process, "cwd").mockReturnValue(AUDIT_CWD);
      store = new SessionStore(AUDIT_HOME);
      parentId = await store.create({ cwd: AUDIT_CWD, provider: "fake", model: "fake", mode: "code" });
    });

    afterEach(() => {
      rmSync(AUDIT_HOME, { recursive: true, force: true });
      vi.restoreAllMocks();
    });

    function parentJsonlTypes(): string[] {
      const raw = readFileSync(
        join(AUDIT_HOME, "sessions", slugify(AUDIT_CWD), `${parentId}.jsonl`),
        "utf-8",
      );
      return raw.split("\n").filter(Boolean).map((l) => JSON.parse(l).type);
    }

    it("writes sub-agent permission and token rows into the parent session tagged source: \"subagent\"", async () => {
      const { registry } = makeRegistry();
      // run_bash is ask-tier under the default askAll engine; headless (no
      // askUser bridge) resolves to a headless-deny audit row.
      const { provider } = makeProvider([
        toolCallTurn("c1", "run_bash", '{"command":"npm test"}'),
        textTurn("sub done"),
      ]);
      const permissions = new PermissionEngine(undefined, "/workspace");
      const deliveries = trackDeliveries();
      const orchestrator = new Orchestrator({
        provider: () => provider,
        registry,
        modeLoader: new ModeLoader(),
        permissions,
        onTaskResult: deliveries.onResult,
      });
      orchestrator.register(registry);

      const out = await registry.execute(
        { id: "t1", name: "new_task", arguments: { description: "run tests", mode: "code" } },
        { ...ctx, sessionStore: store, sessionId: parentId },
      );
      expect(out.error).toBeUndefined();

      // The sub-run is detached now — the audit rows land while it runs, so
      // wait for the delivery before asserting on them.
      await deliveries.delivered();

      const history = await store.queryPermissionHistory(parentId);
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({ decision: "headless-deny", source: "subagent" });

      // One token row per sub-agent turn, all tagged.
      const usage = await store.queryTokenUsage(parentId);
      expect(usage.length).toBeGreaterThanOrEqual(1);
      expect(usage.every((r) => r.source === "subagent")).toBe(true);
    });

    it("keeps parent rows untagged and sub-agent messages out of the parent transcript", async () => {
      // A parent-side row written directly stays untagged.
      await store.appendPermission(parentId, { tool: "read_file", subject: "./a.ts", decision: "allow-by-rule" });

      const { registry } = makeRegistry();
      const { provider } = makeProvider([
        toolCallTurn("c1", "read_file", '{"path":"a.txt"}'),
        textTurn("sub done"),
      ]);
      const permissions = new PermissionEngine(undefined, "/workspace");
      const deliveries = trackDeliveries();
      const orchestrator = new Orchestrator({
        provider: () => provider,
        registry,
        modeLoader: new ModeLoader(),
        permissions,
        onTaskResult: deliveries.onResult,
      });
      orchestrator.register(registry);

      const out = await registry.execute(
        { id: "t1", name: "new_task", arguments: { description: "read a file", mode: "code" } },
        { ...ctx, sessionStore: store, sessionId: parentId },
      );
      expect(out.error).toBeUndefined();
      await deliveries.delivered();

      const history = await store.queryPermissionHistory(parentId);
      expect(history.map((r) => r.source)).toEqual([undefined, "subagent"]);

      // Sub-agent messages never land in the parent transcript — the parent
      // session has zero messages, and the JSONL holds only audit rows
      // (permission/token) beyond the meta record.
      const loaded = await store.load(parentId);
      expect(loaded!.messages).toEqual([]);
      expect(new Set(parentJsonlTypes())).toEqual(new Set(["meta", "permission", "token"]));
    });

    it("keeps sub-agent todo updates out of the parent session file", async () => {
      // Uses the REAL module-level registry (like the todo-store isolation
      // test above) so the real update_todo_list handler runs against the
      // per-call context the orchestrator builds.
      const { provider: subProvider } = makeProvider([
        toolCallTurn("c1", "update_todo_list", JSON.stringify({
          todos: [{ content: "Sub step A", status: "in_progress" }],
        })),
        textTurn("sub done"),
      ]);
      const deliveries = trackDeliveries();
      const orchestrator = new Orchestrator({
        provider: () => subProvider,
        registry: realRegistry,
        modeLoader: new ModeLoader(),
        onTaskResult: deliveries.onResult,
      });
      orchestrator.register(realRegistry);

      const out = await realRegistry.execute(
        { id: "t1", name: "new_task", arguments: { description: "sub plan", mode: "code" } },
        { workingDir: AUDIT_CWD, sessionId: parentId, signal: new AbortController().signal, sessionStore: store },
      );

      expect(out.error).toBeUndefined();
      // The sub-run is detached — wait for completion before asserting.
      await deliveries.delivered();
      // The parent's checklist panel store was never touched.
      expect(todoStore.getTodos()).toEqual([]);

      // No todo snapshot row (and no message) ever reaches the parent JSONL —
      // the audit-only view blocks appendTodo; the transcript stays empty.
      const types = parentJsonlTypes();
      expect(types).not.toContain("todo");
      expect(types).not.toContain("message");
    });

    it("delivers the result as an appendable parent-session message while audit rows stay tagged", async () => {
      // Persistence honesty (async-subagents.md §4): the delivery callback
      // (the App appends like any message) must produce a normal message row,
      // and the sub-run's audit rows must remain tagged `source: "subagent"` —
      // the security envelope is unchanged by the async contract.
      const { registry } = makeRegistry();
      const { provider } = makeProvider([
        toolCallTurn("c1", "run_bash", '{"command":"npm test"}'),
        textTurn("sub done"),
      ]);
      const permissions = new PermissionEngine(undefined, "/workspace");
      const deliveries = trackDeliveries();
      const orchestrator = new Orchestrator({
        provider: () => provider,
        registry,
        modeLoader: new ModeLoader(),
        permissions,
        onTaskResult: deliveries.onResult,
      });
      orchestrator.register(registry);

      const out = await registry.execute(
        { id: "t1", name: "new_task", arguments: { description: "run tests", mode: "code" } },
        { ...ctx, sessionStore: store, sessionId: parentId },
      );
      expect(out.error).toBeUndefined();

      // The delivery is the App's append point: persist it like any message,
      // then the parent's synthesis follows.
      const delivered = await deliveries.delivered();
      await store.appendMessage(parentId, { role: "user", content: delivered });
      await store.appendMessage(parentId, { role: "assistant", content: "synthesis" });

      const loaded = await store.load(parentId);
      const messages = loaded!.messages;
      expect(messages).toHaveLength(2);
      expect(messages[0]).toMatchObject({ role: "user" });
      expect(String(messages[0].content)).toMatch(/^Sub-agent result \(task task-\d+\): /);
      expect(String(messages[0].content)).toContain("**Result**: sub done");
      expect(messages[1]).toMatchObject({ role: "assistant", content: "synthesis" });

      // The sub-run's permission row stays tagged; only the delivered message
      // (and the parent's synthesis) entered the transcript.
      const history = await store.queryPermissionHistory(parentId);
      expect(history).toHaveLength(1);
      expect(history[0].source).toBe("subagent");
      expect(parentJsonlTypes().filter((t) => t === "message")).toHaveLength(2);
    });
  });
});
