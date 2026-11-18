import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render } from "ink-testing-library";
import App from "./App.js";
import type { AppContext, PeerHandlers } from "./types.js";
import { __resetInputWireForTests } from "./hooks/useTerminalInput.js";
import { stripAnsi } from "./test-helpers.js";
import { todoStore } from "../tools/todo.js";
import type { IncomingPeerMessage } from "../peers/service.js";
import type { DeliveryMode } from "../peers/inbox.js";
import { formatPeerPayload, peerEchoText } from "../peers/format.js";

vi.mock("./core/history-store.js", () => ({
  loadPromptHistory: () => [],
  appendPromptHistory: () => Promise.resolve(),
  HISTORY_CAP: 1000,
}));

// ── doubles ──

function fakePeers() {
  return {
    turnHops: 0,
    name: "api-a1b2",
    sessionId: "20261117T180000-a1b2",
    receive: "always",
    reply: vi.fn(),
    complete: vi.fn(() => Promise.resolve()),
    decline: vi.fn(() => Promise.resolve()),
    allowSender: vi.fn(),
    setStatus: vi.fn(),
    setReceive: vi.fn(),
    peers: vi.fn(() => []),
    pendingCount: vi.fn(() => 0),
  };
}

let seq = 0;
function incoming(mode: DeliveryMode, body = `peer request ${++seq}`, over: { needsApproval?: boolean; hops?: number } = {}): IncomingPeerMessage {
  const msg = {
    v: 1,
    messageId: `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`,
    kind: "message" as const,
    mode,
    from: { type: "session" as const, sessionId: "20261117T170000-beef", name: "web-beef", pid: 1 },
    to: "20261117T180000-a1b2",
    body,
    wantReply: mode !== "notify",
    inReplyTo: null,
    hops: over.hops ?? 0,
    createdAt: 0,
    expiresAt: 1,
  };
  return { claimed: { msg, file: `/x/${msg.messageId}` }, msg, payload: formatPeerPayload(msg), echo: peerEchoText(msg), needsApproval: over.needsApproval ?? false };
}

function makeHarness() {
  let handlers: PeerHandlers | undefined;
  let callbacks: any = null;
  const peers = fakePeers();
  let script: (input: string, cb: any) => Promise<any> = async () => ({ stopReason: "done", messages: [], newMessages: [] });
  const runAgentTurnCore = vi.fn((input: string, cb: any) => {
    callbacks = cb;
    return script(input, cb);
  });
  const ctx = {
    mutable: { conversationHistory: [], sessionInput: 0, sessionOutput: 0, lastContextTokens: 0, sessionUserInputs: [] },
    getProvider: () => ({}),
    sessionId: "test-session",
    activeMode: null,
    permissions: { resolve: () => ({ action: "allow" }), buildDefaultRule: () => null } as any,
    toolRegistry: null,
    compactor: null,
    diagnostics: null,
    skills: [],
    memoryStore: null,
    sessionStore: { appendMessages: () => Promise.resolve(), appendPermission: () => Promise.resolve() },
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
    setPeerHandlers: (h: PeerHandlers) => { handlers = h; },
    getPeers: () => peers,
    gitStatus: null,
  } as any as AppContext;
  return {
    ctx,
    peers,
    runAgentTurnCore,
    deliver: (m: IncomingPeerMessage) => handlers!.onMessage(m),
    notice: (t: string) => handlers!.onNotice(t),
    lastCallbacks: () => callbacks,
    set script(fn: (input: string, cb: any) => Promise<any>) { script = fn; },
  };
}

const flush = () => new Promise((r) => setTimeout(r, 60));
/** Poll instead of a fixed sleep: under a loaded suite a 60 ms flush can end before Ink renders. */
async function waitFor(cond: () => boolean, ms = 5000) {
  const deadline = Date.now() + ms;
  while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
  await flush();
}
const MODAL = "Message from another session";
const done = (text = "") => ({ stopReason: "done", messages: [], newMessages: text ? [{ role: "assistant", content: text }] : [] });

/** Start a user turn that stays in flight until `release` is called. */
async function startHeldTurn(h: ReturnType<typeof makeHarness>, inst: ReturnType<typeof render>) {
  let release!: (v: unknown) => void;
  let calls = 0;
  h.script = () => (++calls === 1 ? new Promise((r) => { release = r; }) : Promise.resolve(done("later")));
  inst.stdin.write("first prompt");
  await flush();
  inst.stdin.write("\r");
  await flush();
  return (v: unknown) => release(v);
}

const mounted: Array<{ unmount: () => void }> = [];
afterEach(() => {
  while (mounted.length) mounted.pop()!.unmount();
  __resetInputWireForTests();
  todoStore.reset();
  vi.restoreAllMocks();
});

function mount(h: ReturnType<typeof makeHarness>) {
  const inst = render(<App ctx={h.ctx} />);
  mounted.push(inst);
  return inst;
}

describe("inter-session messages in the TUI (cross-session-inbox.md §5.4)", () => {
  it("idle queue: starts a turn, echoes ✉ not ❯, replies with the final text, acks, toggles busy/idle", async () => {
    const h = makeHarness();
    h.script = async () => done("tests pass");
    const inst = mount(h);
    await flush();
    const m = incoming("queue", "run the tests");
    h.deliver(m);
    await flush();
    await flush();

    expect(h.runAgentTurnCore).toHaveBeenCalledTimes(1);
    expect(h.runAgentTurnCore.mock.calls[0][0]).toBe(m.payload);
    expect(stripAnsi(inst.lastFrame() ?? "")).toContain("✉ web-beef (queue): run the tests");
    expect(h.peers.reply).toHaveBeenCalledWith(m, "ok", "tests pass");
    expect(h.peers.complete).toHaveBeenCalledWith(m.claimed);
    expect(h.peers.setStatus.mock.calls.map((c) => c[0])).toEqual(["busy", "idle"]);
  });

  it("hops: a peer-started turn sets the service hop count, a human turn resets it", async () => {
    const h = makeHarness();
    let seen = -1;
    h.script = async () => {
      seen = h.peers.turnHops;
      return done();
    };
    mount(h);
    await flush();
    h.deliver(incoming("queue", "x", { hops: 2 }));
    await flush();
    await flush();
    expect(seen).toBe(2);
    expect(h.peers.turnHops).toBe(0);
  });

  it("E16: busy queue message never rides the mailbox; the user's mid-turn input goes first", async () => {
    const h = makeHarness();
    const inst = mount(h);
    await flush();
    const release = await startHeldTurn(h, inst);

    const m = incoming("queue");
    h.deliver(m);
    await flush();
    expect(h.lastCallbacks().pollSteeringMessage()).toBeNull();

    inst.stdin.write("user follow-up");
    await flush();
    inst.stdin.write("\r");
    await flush();
    expect(h.lastCallbacks().pollSteeringMessage()).toBe("user follow-up");

    release(done("first done"));
    await flush();
    await flush();
    expect(h.runAgentTurnCore).toHaveBeenCalledTimes(2);
    expect(h.runAgentTurnCore.mock.calls[1][0]).toBe(m.payload);
    expect(h.peers.reply).toHaveBeenCalledTimes(1);
    expect(h.peers.reply).toHaveBeenCalledWith(m, "ok", "later");
  });

  it("busy steer: injected at the next decision point; replied with that turn's final text", async () => {
    const h = makeHarness();
    const inst = mount(h);
    await flush();
    const release = await startHeldTurn(h, inst);

    const m = incoming("steer", "also check lint");
    h.deliver(m);
    await flush();
    expect(h.lastCallbacks().pollSteeringMessage()).toBe(m.payload);

    release(done("did both"));
    await flush();
    await flush();
    expect(h.runAgentTurnCore).toHaveBeenCalledTimes(1);
    expect(h.peers.reply).toHaveBeenCalledWith(m, "ok", "did both");
    expect(stripAnsi(inst.lastFrame() ?? "")).toContain("✉ web-beef (steer): also check lint");
  });

  it("E17: a steer the turn never polled becomes the next turn instead of being dropped", async () => {
    const h = makeHarness();
    const inst = mount(h);
    await flush();
    const release = await startHeldTurn(h, inst);
    const m = incoming("steer");
    h.deliver(m);
    await flush();

    release(done());
    await flush();
    await flush();
    expect(h.runAgentTurnCore).toHaveBeenCalledTimes(2);
    expect(h.runAgentTurnCore.mock.calls[1][0]).toBe(m.payload);
    expect(h.peers.reply).toHaveBeenCalledWith(m, "ok", "later");
  });

  it("notify: no turn; carried as context by the next turn, acked after it, never replied", async () => {
    const h = makeHarness();
    let notices = "";
    h.script = async (_i, cb) => {
      notices = cb.getPeerNotices();
      return done();
    };
    const inst = mount(h);
    await flush();
    const m = incoming("notify", "deploy finished");
    h.deliver(m);
    await flush();
    expect(h.runAgentTurnCore).not.toHaveBeenCalled();
    expect(stripAnsi(inst.lastFrame() ?? "")).toContain("✉ web-beef (notify): deploy finished");

    inst.stdin.write("next");
    await flush();
    inst.stdin.write("\r");
    await flush();
    await flush();
    expect(notices).toBe(m.payload);
    expect(h.peers.complete).toHaveBeenCalledWith(m.claimed);
    expect(h.peers.reply).not.toHaveBeenCalled();
  });

  it("E19: Esc on a peer-started turn replies aborted; a failed turn replies error", async () => {
    const h = makeHarness();
    h.script = async () => ({ stopReason: "aborted", messages: [], newMessages: [] });
    mount(h);
    await flush();
    const a = incoming("queue");
    h.deliver(a);
    await flush();
    await flush();
    expect(h.peers.reply).toHaveBeenCalledWith(a, "aborted", "");

    h.script = async () => {
      throw new Error("provider down");
    };
    const b = incoming("queue");
    h.deliver(b);
    await flush();
    await flush();
    expect(h.peers.reply).toHaveBeenCalledWith(b, "error", "");
  });

  it("receive=ask: y runs it, n declines without a turn", async () => {
    const h = makeHarness();
    const inst = mount(h);
    await flush();
    const ok = incoming("queue", "please run", { needsApproval: true });
    h.deliver(ok);
    await waitFor(() => stripAnsi(inst.lastFrame() ?? "").includes(MODAL));
    expect(stripAnsi(inst.lastFrame() ?? "")).toContain(MODAL);
    expect(h.runAgentTurnCore).not.toHaveBeenCalled();
    inst.stdin.write("y");
    await waitFor(() => h.runAgentTurnCore.mock.calls.length > 0);
    expect(h.runAgentTurnCore).toHaveBeenCalledTimes(1);

    const no = incoming("queue", "rm -rf", { needsApproval: true });
    h.deliver(no);
    await waitFor(() => stripAnsi(inst.lastFrame() ?? "").includes(MODAL));
    inst.stdin.write("n");
    await waitFor(() => h.peers.decline.mock.calls.length > 0);
    expect(h.peers.decline).toHaveBeenCalledWith(no);
    expect(h.runAgentTurnCore).toHaveBeenCalledTimes(1);
  });

  it("receive=ask: a accepts the sender and its other pending messages", async () => {
    const h = makeHarness();
    mount(h);
    await flush();
    const first = incoming("notify", "one", { needsApproval: true });
    const second = incoming("notify", "two", { needsApproval: true });
    h.deliver(first);
    h.deliver(second);
    const inst = mounted[0] as ReturnType<typeof render>;
    await waitFor(() => stripAnsi(inst.lastFrame() ?? "").includes(MODAL));
    inst.stdin.write("a");
    await waitFor(() => stripAnsi(inst.lastFrame() ?? "").includes("(notify): two"));
    expect(h.peers.allowSender).toHaveBeenCalledWith(first.msg.from);
    const frame = stripAnsi(inst.lastFrame() ?? "");
    expect(frame).not.toContain("Message from another session");
    expect(frame).toContain("(notify): one");
    expect(frame).toContain("(notify): two");
  });

  it("/peers prints this session and the table; /peers receive sets the policy", async () => {
    const h = makeHarness();
    const inst = mount(h);
    await flush();
    inst.stdin.write("/peers");
    await flush();
    inst.stdin.write("\r");
    await flush();
    expect(stripAnsi(inst.lastFrame() ?? "")).toContain("This session: api-a1b2");
    expect(stripAnsi(inst.lastFrame() ?? "")).toContain("No other live sessions.");

    inst.stdin.write("/peers receive never");
    await flush();
    inst.stdin.write("\r");
    await flush();
    expect(h.peers.setReceive).toHaveBeenCalledWith("never");
  });

  it("service notices render as dim bracketed lines", async () => {
    const h = makeHarness();
    const inst = mount(h);
    await flush();
    h.notice("1 expired message from web-beef discarded");
    await flush();
    expect(stripAnsi(inst.lastFrame() ?? "")).toContain("[1 expired message from web-beef discarded]");
  });
});
