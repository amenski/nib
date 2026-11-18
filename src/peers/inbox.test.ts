import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { inboxDirs, peersRoot } from "./paths.js";
import { register, type PeerRecord } from "./registry.js";
import { ackMessage, scanInbox, sendMessage, SendError, SendRateLimiter, type PeerFrom, type PeerMessage } from "./inbox.js";

let home: string;
const RX = "20261117T184458-a1b2";
const FROM: PeerFrom = { type: "session", sessionId: "20261117T180000-beef", name: "web-beef", pid: process.pid };
const noDup = () => false;

function receiver(id = RX, receive: PeerRecord["receive"] = "always") {
  const r = register({ sessionId: id, cwd: "/work/api", kind: "interactive", receive, home, heartbeat: false });
  if (!r.ok) throw new Error("register failed");
  return r.registration;
}

function send(over: Partial<Parameters<typeof sendMessage>[0]> = {}) {
  return sendMessage({ to: RX, body: "run the tests", from: FROM, home, ...over });
}

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof SendError) return err.code;
    throw err;
  }
  return "no error";
}

function writeRawRecord(rec: Partial<PeerRecord> & { sessionId: string }) {
  writeFileSync(
    join(peersRoot(home), "registry", `${rec.sessionId}.json`),
    JSON.stringify({ v: 1, name: "x", pid: process.pid, receive: "always", updatedAt: Date.now(), ...rec }),
  );
}

/** Drop a hand-built file straight into new/. */
function plant(msg: Partial<PeerMessage> | string, name?: string) {
  const id = randomUUID();
  const file = name ?? `${Date.now()}-${id}.json`;
  const body =
    typeof msg === "string"
      ? msg
      : JSON.stringify({
          v: 1, messageId: id, kind: "message", mode: "queue", from: FROM, to: RX, body: "hi",
          wantReply: false, inReplyTo: null, hops: 0, createdAt: Date.now(), expiresAt: Date.now() + 60_000, ...msg,
        });
  writeFileSync(join(inboxDirs(RX, home).new, file), body, { mode: 0o600 });
  return file;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "nib-inbox-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("sendMessage + scanInbox", () => {
  it("delivers once; the file stays in cur/ until acked", () => {
    receiver();
    const { messageId } = send({ wantReply: true, mode: "steer" });
    const first = scanInbox(RX, { home, isDuplicate: noDup });
    expect(first.claimed).toHaveLength(1);
    expect(first.claimed[0].msg).toMatchObject({ messageId, body: "run the tests", mode: "steer", wantReply: true, to: RX });
    expect(existsSync(first.claimed[0].file)).toBe(true);
    expect(scanInbox(RX, { home, isDuplicate: noDup }).claimed).toHaveLength(0);
    ackMessage(first.claimed[0]);
    expect(readdirSync(inboxDirs(RX, home).cur)).toEqual([]);
  });

  it("E2: a crash between claim and persist redelivers exactly once", () => {
    receiver();
    const { messageId } = send();
    scanInbox(RX, { home, isDuplicate: noDup }); // claimed, never acked = crash
    const recovered = scanInbox(RX, { home, isDuplicate: noDup, recoverCur: true });
    expect(recovered.claimed.map((c) => c.msg.messageId)).toEqual([messageId]);
    // …and if the transcript already had it, it is dropped instead
    const persisted = new Set([messageId]);
    expect(scanInbox(RX, { home, isDuplicate: (id) => persisted.has(id), recoverCur: true }).claimed).toEqual([]);
    expect(readdirSync(inboxDirs(RX, home).cur)).toEqual([]);
  });

  it("E3: a duplicate messageId is dropped", () => {
    receiver();
    const name = plant({ messageId: "11111111-1111-4111-8111-11111111111a" });
    expect(scanInbox(RX, { home, isDuplicate: (id) => id.startsWith("1111") }).claimed).toEqual([]);
    expect(existsSync(join(inboxDirs(RX, home).cur, name))).toBe(false);
  });

  it("E7: files in tmp/ are never read", () => {
    receiver();
    writeFileSync(join(inboxDirs(RX, home).tmp, `${Date.now()}-${randomUUID()}.json`), "{\"partial");
    expect(scanInbox(RX, { home, isDuplicate: noDup })).toEqual({ claimed: [], quarantined: [] });
  });

  it("returns messages oldest first", () => {
    receiver();
    const base = Date.now();
    plant({ body: "second" }, `${base + 5}-${randomUUID()}.json`);
    plant({ body: "first" }, `${base - 5}-${randomUUID()}.json`);
    expect(scanInbox(RX, { home, isDuplicate: noDup }).claimed.map((c) => c.msg.body)).toEqual(["first", "second"]);
  });

  it("strips control characters on both ends (E11)", () => {
    receiver();
    send({ body: "a\u001b[2Jb\nc" });
    plant({ body: "x\u0007y" });
    const bodies = scanInbox(RX, { home, isDuplicate: noDup }).claimed.map((c) => c.msg.body).sort();
    expect(bodies).toEqual(["a[2Jb\nc", "xy"]);
  });
});

describe("hostile inbox content", () => {
  beforeEach(() => receiver());

  it("E9: ignores names that don't match the pattern", () => {
    plant("{}", ".DS_Store");
    plant("{}", "../../evil.json");
    expect(scanInbox(RX, { home, isDuplicate: noDup })).toEqual({ claimed: [], quarantined: [] });
  });

  it("E9: quarantines a symlink with a valid name", () => {
    const name = `${Date.now()}-${randomUUID()}.json`;
    symlinkSync("/etc/passwd", join(inboxDirs(RX, home).new, name));
    const r = scanInbox(RX, { home, isDuplicate: noDup });
    expect(r.quarantined).toEqual([{ name, reason: "not_regular", partial: undefined }]);
    expect(readdirSync(inboxDirs(RX, home).bad)).toEqual([name]);
  });

  it("E10: quarantines malformed and oversized files", () => {
    plant("not json");
    plant({ body: "x".repeat(40 * 1024) });
    plant({ hops: -1 });
    const reasons = scanInbox(RX, { home, isDuplicate: noDup }).quarantined.map((q) => q.reason).sort();
    expect(reasons).toEqual(["invalid", "invalid", "too_large"]);
  });

  it("quarantines group/other-writable files", () => {
    const name = plant({});
    chmodSync(join(inboxDirs(RX, home).new, name), 0o666);
    expect(scanInbox(RX, { home, isDuplicate: noDup }).quarantined[0].reason).toBe("unsafe_mode");
  });

  it("quarantines mail addressed to another session", () => {
    plant({ to: "20261117T999999-ffff" });
    expect(scanInbox(RX, { home, isDuplicate: noDup }).quarantined[0].reason).toBe("wrong_recipient");
  });

  it("E21: quarantines expired mail with enough detail to notify", () => {
    const messageId = randomUUID();
    plant({ messageId, expiresAt: Date.now() - 1 });
    const q = scanInbox(RX, { home, isDuplicate: noDup }).quarantined[0];
    expect(q).toMatchObject({ reason: "expired", partial: { messageId, from: FROM } });
  });

  it("E28: quarantines an unknown protocol major with reply detail", () => {
    plant({ v: 2, wantReply: true });
    const q = scanInbox(RX, { home, isDuplicate: noDup }).quarantined[0];
    expect(q).toMatchObject({ reason: "unsupported_version", partial: { wantReply: true } });
  });
});

describe("send refusals", () => {
  it("rejects sending to self", () => {
    receiver();
    expect(code(() => send({ selfId: RX }))).toBe("self");
  });

  it("E4: no mail to dead or stale sessions", () => {
    mkdirSync(join(peersRoot(home), "registry"), { recursive: true, mode: 0o700 });
    chmodSync(peersRoot(home), 0o700);
    writeRawRecord({ sessionId: "s-dead", pid: spawnSync("true").pid! });
    writeRawRecord({ sessionId: "s-stale", updatedAt: Date.now() - 600_000 });
    expect(code(() => send({ to: "s-dead" }))).toBe("not_running");
    expect(code(() => send({ to: "s-stale" }))).toBe("not_responding");
    expect(existsSync(join(peersRoot(home), "inbox", "s-dead"))).toBe(false);
  });

  it("refuses when the receiver's policy is never, but still accepts replies", () => {
    receiver(RX, "never");
    expect(code(() => send())).toBe("refused");
    expect(code(() => send({ kind: "reply", inReplyTo: randomUUID(), status: "ok" }))).toBe("no error");
  });

  it("rejects bodies over 16 KiB", () => {
    receiver();
    expect(code(() => send({ body: "x".repeat(16 * 1024 + 1) }))).toBe("too_large");
  });

  it("E14: caps unread mail per sender", () => {
    receiver();
    for (let i = 0; i < 20; i++) send();
    expect(code(() => send())).toBe("inbox_full");
    const other: PeerFrom = { ...FROM, sessionId: "20261117T170000-cafe" } as PeerFrom;
    expect(code(() => send({ from: other }))).toBe("no error");
  });

  it("E14: rate-limits one sending session to 10 per minute", () => {
    receiver();
    const rateLimiter = new SendRateLimiter();
    const now = Date.now();
    for (let i = 0; i < 10; i++) send({ rateLimiter, now });
    expect(code(() => send({ rateLimiter, now }))).toBe("rate_limited");
    expect(code(() => send({ rateLimiter, now: now + 61_000 }))).toBe("no error");
  });

  it("E22: an unusable inbox is an error to the sender, nothing written", () => {
    receiver();
    chmodSync(inboxDirs(RX, home).new, 0o500);
    expect(code(() => send())).toBe("io");
    expect(readdirSync(inboxDirs(RX, home).tmp)).toEqual([]);
    chmodSync(inboxDirs(RX, home).new, 0o700);
  });
});

describe("addressing (§6.1)", () => {
  it("resolves by exact id, ≥6-char prefix, and exact name", () => {
    receiver();
    expect(send({ to: RX }).target.sessionId).toBe(RX);
    expect(send({ to: "20261117T18" }).target.sessionId).toBe(RX);
    expect(send({ to: "api-a1b2" }).target.sessionId).toBe(RX);
  });

  it("does not resolve prefixes shorter than 6 chars", () => {
    receiver();
    expect(code(() => send({ to: "2026" }))).toBe("not_found");
  });

  it("E24: an ambiguous name is an error listing the ids", () => {
    receiver(RX);
    receiver("20261117T190000-a1b2");
    const err = (() => {
      try {
        send({ to: "api-a1b2" });
      } catch (e) {
        return e as SendError;
      }
    })();
    expect(err?.code).toBe("ambiguous");
    expect(err?.message).toContain("20261117T190000-a1b2");
  });

  it("an unknown target lists the live sessions", () => {
    receiver();
    expect(() => send({ to: "nope" })).toThrow(/Live sessions: api-a1b2/);
  });
});
