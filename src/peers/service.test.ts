import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inboxDirs } from "./paths.js";
import { SendError, sendMessage } from "./inbox.js";
import { randomUUID } from "node:crypto";
import { isPeerMessage } from "./format.js";
import { PeerService, type IncomingPeerMessage, type PeerServiceOptions } from "./service.js";

let home: string;
const A = "20261117T180000-aaaa";
const B = "20261117T180000-bbbb";

function start(sessionId: string, over: Partial<PeerServiceOptions> = {}) {
  const inbox: IncomingPeerMessage[] = [];
  const notices: string[] = [];
  const persisted: string[] = [];
  const service = PeerService.start({
    sessionId,
    cwd: `/work/${sessionId === A ? "web" : "api"}`,
    kind: "interactive",
    receive: "always",
    home,
    timers: false,
    onMessage: (m) => inbox.push(m),
    onNotice: (t) => notices.push(t),
    persistReceived: async (id) => void persisted.push(id),
    ...over,
  });
  return { service: service!, inbox, notices, persisted };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "nib-svc-"));
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(home, { recursive: true, force: true });
});

describe("PeerService", () => {
  it("round trip: message → turn payload → reply returned to a waiting sender", async () => {
    const a = start(A);
    const b = start(B);
    await flush(); // let both startup recovery scans run first
    const { messageId } = a.service.send({ to: B, body: "run the api tests", wantReply: true });
    b.service.scanNow();
    expect(b.inbox).toHaveLength(1);
    const incoming = b.inbox[0];
    expect(incoming.needsApproval).toBe(false);
    expect(incoming.echo).toBe("✉ web-aaaa (queue): run the api tests");
    expect(isPeerMessage(incoming.payload)).toBe(true);
    expect(incoming.payload).toContain("--- BEGIN PEER MESSAGE [");
    expect(incoming.payload).toContain("Reply expected");

    b.service.reply(incoming, "ok", "all green");
    await b.service.complete(incoming.claimed);
    expect(b.persisted).toEqual([messageId]);
    expect(readdirSync(inboxDirs(B, home).cur)).toEqual([]);

    const result = await a.service.waitForReply(messageId, B, 10_000);
    expect(result).toMatchObject({ kind: "reply", msg: { body: "all green", status: "ok", inReplyTo: messageId } });
    expect(a.inbox).toEqual([]); // consumed by the waiter, never a turn
  });

  it("a reply nobody waits for arrives as a queue message (late reply)", () => {
    const a = start(A);
    const b = start(B);
    const { messageId } = a.service.send({ to: B, body: "q", wantReply: true });
    b.service.scanNow();
    b.service.reply(b.inbox[0], "ok", "answer");
    a.service.scanNow();
    expect(a.inbox).toHaveLength(1);
    expect(a.inbox[0].msg).toMatchObject({ kind: "reply", mode: "queue", wantReply: false, inReplyTo: messageId });
    expect(a.inbox[0].payload).toMatch(/^\[Inter-session reply · from api-bbbb/);
  });

  it("reply is a no-op unless the sender asked for one (loop guard 1)", () => {
    const a = start(A);
    const b = start(B);
    a.service.send({ to: B, body: "fyi" });
    b.service.scanNow();
    b.service.reply(b.inbox[0], "ok", "thanks");
    a.service.scanNow();
    expect(a.inbox).toEqual([]);
  });

  it("E15: sends carry turnHops + 1 and the receiver rejects hops > 3", () => {
    const a = start(A);
    const b = start(B);
    a.service.turnHops = 3;
    a.service.send({ to: B, body: "chain", wantReply: true });
    b.service.scanNow();
    expect(b.inbox).toEqual([]);
    a.service.scanNow();
    expect(a.inbox[0].msg).toMatchObject({ kind: "reply", status: "hop_limit" });
  });

  it("receive=ask flags approval until the sender is allowed", () => {
    const a = start(A);
    const b = start(B, { receive: "ask" });
    a.service.send({ to: B, body: "one" });
    b.service.scanNow();
    expect(b.inbox[0].needsApproval).toBe(true);
    b.service.allowSender(b.inbox[0].msg.from);
    a.service.send({ to: B, body: "two" });
    b.service.scanNow();
    expect(b.inbox[1].needsApproval).toBe(false);
  });

  it("decline replies declined and clears the file", async () => {
    const a = start(A);
    const b = start(B, { receive: "ask" });
    a.service.send({ to: B, body: "rm -rf", wantReply: true });
    b.service.scanNow();
    await b.service.decline(b.inbox[0]);
    a.service.scanNow();
    expect(a.inbox[0].msg.status).toBe("declined");
    expect(readdirSync(inboxDirs(B, home).cur)).toEqual([]);
  });

  it("receive=never set after sending declines at delivery", () => {
    const a = start(A);
    const b = start(B);
    a.service.send({ to: B, body: "x", wantReply: true });
    b.service.setReceive("never");
    b.service.scanNow();
    expect(b.inbox).toEqual([]);
    a.service.scanNow();
    expect(a.inbox[0].msg.status).toBe("declined");
    expect(() => a.service.send({ to: B, body: "y" })).toThrow(SendError);
  });

  it("a message handed out but not yet completed is not redelivered by the startup recovery pass", async () => {
    const a = start(A);
    const b = start(B);
    a.service.send({ to: B, body: "once" });
    b.service.scanNow(); // before the deferred recovery scan runs
    await flush();
    expect(b.inbox.map((m) => m.msg.body)).toEqual(["once"]);
  });

  it("drops forged or unsolicited replies, even when they claim to answer something", async () => {
    const a = start(A);
    const b = start(B, { receive: "never" });
    await flush();
    // A forges a "reply" to B (replies skip the receive policy at send time).
    sendMessage({ to: B, body: "do something", from: { type: "session", sessionId: A, name: "web-aaaa", pid: process.pid },
      kind: "reply", inReplyTo: randomUUID(), status: "ok", home });
    b.service.scanNow();
    await flush();
    expect(b.inbox).toEqual([]);
    expect(readdirSync(inboxDirs(B, home).cur)).toEqual([]);
    void a;
  });

  it("accepts only one reply per request", async () => {
    const a = start(A);
    const b = start(B);
    await flush();
    a.service.send({ to: B, body: "q", wantReply: true });
    b.service.scanNow();
    b.service.reply(b.inbox[0], "ok", "first");
    b.service.reply(b.inbox[0], "ok", "second");
    a.service.scanNow();
    expect(a.inbox.map((m) => m.msg.body)).toEqual(["first"]);
  });

  it("E1: a second instance for the same session does not receive", () => {
    start(B);
    const second = start(B);
    expect(second.service).toBeNull();
    expect(second.notices[0]).toMatch(/session also open in pid/);
  });

  it("E2: claimed-but-unpersisted mail is redelivered after restart, persisted mail is not", async () => {
    const a = start(A);
    const b = start(B);
    a.service.send({ to: B, body: "first" });
    a.service.send({ to: B, body: "second" });
    b.service.scanNow();
    await b.service.complete(b.inbox[0].claimed); // only "first" persisted
    b.service.close(); // simulate exit with "second" still in cur/
    const b2 = start(B, { alreadyReceived: b.persisted });
    expect(b2.inbox).toEqual([]); // recovery runs after start() returns
    await flush();
    expect(b2.inbox.map((m) => m.msg.body)).toEqual(["second"]);
  });

  it("an external instance only catches awaited replies", async () => {
    const ext = start("x-cli-1", { kind: "external", receive: "never", label: "cli", onMessage: undefined });
    const b = start(B);
    const { messageId } = ext.service.send({ to: B, body: "status?", wantReply: true });
    b.service.scanNow();
    expect(b.inbox[0].echo).toMatch(/^✉ cli \(pid \d+\) \(queue\): status\?/);
    b.service.reply(b.inbox[0], "ok", "idle");
    await expect(ext.service.waitForReply(messageId, B, 10_000)).resolves.toMatchObject({ kind: "reply" });
    ext.service.close();
    expect(existsSync(inboxDirs("x-cli-1", home).base)).toBe(false); // reply acked before the waiter resolved
  });

  it("waitForReply times out, and reports a receiver that exits", async () => {
    vi.useFakeTimers();
    const a = start(A);
    const b = start(B);
    const first = a.service.send({ to: B, body: "slow", wantReply: true });
    const timedOut = a.service.waitForReply(first.messageId, B, 1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await timedOut).toEqual({ kind: "timeout" });

    const second = a.service.send({ to: B, body: "slower", wantReply: true });
    const exited = a.service.waitForReply(second.messageId, B, 60_000);
    b.service.close();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await exited).toEqual({ kind: "receiver_exited" });
  });

  it("waitForReply honours an abort signal", async () => {
    const a = start(A);
    start(B);
    const { messageId } = a.service.send({ to: B, body: "x", wantReply: true });
    const ctl = new AbortController();
    const waiting = a.service.waitForReply(messageId, B, 60_000, ctl.signal);
    ctl.abort();
    expect(await waiting).toEqual({ kind: "aborted" });
  });

  it("E29: replying to a sender that has gone is silent", async () => {
    const a = start(A);
    const b = start(B);
    a.service.send({ to: B, body: "x", wantReply: true });
    a.service.close();
    b.service.scanNow();
    expect(() => b.service.reply(b.inbox[0], "ok", "done")).not.toThrow();
    await flush();
  });

  it("lists live peers without itself", () => {
    const a = start(A);
    start(B);
    expect(a.service.peers().map((p) => p.sessionId)).toEqual([B]);
  });
});
