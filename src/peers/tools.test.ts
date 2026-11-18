import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PeerService, type IncomingPeerMessage } from "./service.js";
import { createListSessionsHandler, createSendMessageHandler } from "./tools.js";
import { BUILTIN_ALLOW_RULES } from "../permissions/builtin-allow.js";

let home: string;
const A = "20261117T180000-aaaa";
const B = "20261117T180000-bbbb";
const ctx = () => ({ signal: new AbortController().signal }) as any;

function start(sessionId: string) {
  const inbox: IncomingPeerMessage[] = [];
  const service = PeerService.start({
    sessionId, cwd: `/work/${sessionId.slice(-4)}`, kind: "interactive", receive: "always", home, timers: false,
    onMessage: (m) => inbox.push(m),
  })!;
  return { service, inbox };
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "nib-tools-"));
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(home, { recursive: true, force: true });
});

describe("list_sessions", () => {
  it("lists live peers with ids, filtered by cwdPrefix", async () => {
    const a = start(A);
    start(B);
    const list = createListSessionsHandler(() => a.service);
    const all = await list({}, ctx());
    expect(all.content).toContain("This session: aaaa-aaaa");
    expect(all.content).toContain(B);
    expect((await list({ cwdPrefix: "/elsewhere" }, ctx())).content).toContain("No other live sessions.");
  });

  it("is unavailable without a receiver", async () => {
    expect((await createListSessionsHandler(() => null)({}, ctx())).error).toBe("unavailable");
  });
});

describe("send_message", () => {
  it("delivers and says delivered ≠ read", async () => {
    const a = start(A);
    const b = start(B);
    const out = await createSendMessageHandler(() => a.service)({ to: B, message: "run tests", wantReply: true }, ctx());
    expect(out.error).toBeUndefined();
    expect(out.content).toMatch(/Delivered to bbbb-bbbb \(20261117T180000-bbbb\)'s inbox .*not yet read.*arrive later/);
    b.service.scanNow();
    expect(b.inbox[0].msg).toMatchObject({ body: "run tests", wantReply: true, mode: "queue", hops: 1 });
  });

  it("waitSeconds returns the reply inline, fenced, and it never becomes a turn", async () => {
    const a = start(A);
    const b = start(B);
    const pending = createSendMessageHandler(() => a.service)({ to: B, message: "status?", waitSeconds: 30 }, ctx());
    b.service.scanNow();
    b.service.reply(b.inbox[0], "ok", "all green");
    a.service.scanNow();
    const out = await pending;
    expect(out.content).toMatch(/^\[Inter-session reply · from bbbb-bbbb .* status=ok/);
    expect(out.content).toContain("--- BEGIN PEER MESSAGE [");
    expect(out.content).toContain("all green");
    expect(a.inbox).toEqual([]);
  });

  it("a timed-out wait leaves the late reply to arrive as a message", async () => {
    vi.useFakeTimers();
    const a = start(A);
    const b = start(B);
    const pending = createSendMessageHandler(() => a.service)({ to: B, message: "slow", waitSeconds: 1 }, ctx());
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await pending).content).toMatch(/no reply within 1s/);
    b.service.scanNow();
    b.service.reply(b.inbox[0], "ok", "late answer");
    a.service.scanNow();
    expect(a.inbox[0].msg).toMatchObject({ kind: "reply", body: "late answer" });
  });

  it("E29: reports a receiver that exits while we wait", async () => {
    vi.useFakeTimers();
    const a = start(A);
    const b = start(B);
    const pending = createSendMessageHandler(() => a.service)({ to: B, message: "x", waitSeconds: 60 }, ctx());
    b.service.close();
    await vi.advanceTimersByTimeAsync(5_000);
    expect((await pending).error).toBe("receiver_exited");
  });

  it("E4: no mail to a session that isn't running", async () => {
    const a = start(A);
    const b = start(B);
    b.service.close();
    const out = await createSendMessageHandler(() => a.service)({ to: B, message: "x" }, ctx());
    expect(out.error).toBe("not_found");
  });

  it("E15: hops follow the running turn", async () => {
    const a = start(A);
    const b = start(B);
    a.service.turnHops = 2;
    await createSendMessageHandler(() => a.service)({ to: B, message: "x" }, ctx());
    b.service.scanNow();
    expect(b.inbox[0].msg.hops).toBe(3);
  });

  it("E24: an ambiguous name is an error naming the ids", async () => {
    const a = start(A);
    start("20261117T190000-bbbb"); // cwd /work/bbbb → name bbbb-bbbb, same as B
    start(B);
    const out = await createSendMessageHandler(() => a.service)({ to: "bbbb-bbbb", message: "x" }, ctx());
    expect(out.error).toBe("ambiguous");
    expect(out.content).toContain("20261117T190000-bbbb");
  });

  it("rejects bad arguments", async () => {
    const a = start(A);
    const send = createSendMessageHandler(() => a.service);
    expect((await send({ to: B }, ctx())).error).toBe("invalid_args");
    expect((await send({ to: B, message: "x", mode: "shout" }, ctx())).error).toBe("invalid_args");
    expect((await send({ to: B, message: "x", mode: "notify", waitSeconds: 5 }, ctx())).error).toBe("invalid_args");
  });

  it("D5: both tools are allowed by builtin rule", () => {
    const allowed = BUILTIN_ALLOW_RULES.filter((r) => r.action === "allow").map((r) => r.tool);
    expect(allowed).toEqual(expect.arrayContaining(["list_sessions", "send_message"]));
  });
});
