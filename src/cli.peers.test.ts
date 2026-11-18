import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chmodSync } from "node:fs";
import { formatMessagingLine } from "./cli.js";
import { runPeersCommand, runSendCommand } from "./peers/cli.js";
import { register, type ReceivePolicy, type Registration } from "./peers/registry.js";
import { scanInbox } from "./peers/inbox.js";
import { PeerService, type IncomingPeerMessage } from "./peers/service.js";

const RECV = "20261117T180000-rcvr";

let home: string;
let prevHome: string | undefined;
let out: string;
let err: string;
const registrations: Registration[] = [];
const services: PeerService[] = [];

function receiver(receive: ReceivePolicy = "always"): Registration {
  const r = register({ sessionId: RECV, cwd: "/work/web", kind: "interactive", receive, home, heartbeat: false });
  if (!r.ok) throw new Error("register failed");
  registrations.push(r.registration);
  return r.registration;
}

const flushMicrotasks = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "nib-cli-peers-"));
  prevHome = process.env.NIB_HOME;
  process.env.NIB_HOME = home;
  out = "";
  err = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => ((out += String(chunk)), true));
  vi.spyOn(console, "error").mockImplementation((...a) => void (err += `${a.join(" ")}\n`));
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const s of services.splice(0)) s.close();
  for (const r of registrations.splice(0)) r.close();
  rmSync(home, { recursive: true, force: true });
  if (prevHome === undefined) delete process.env.NIB_HOME;
  else process.env.NIB_HOME = prevHome;
});

describe("nib peers", () => {
  it("lists a registered session", async () => {
    receiver();
    expect(await runPeersCommand([])).toBe(0);
    expect(out).toContain("NAME");
    expect(out).toContain(RECV);
    expect(out).toContain("/work/web");
  });

  it("says so when nobody is live", async () => {
    expect(await runPeersCommand([])).toBe(0);
    expect(out).toContain("No other live sessions.");
  });
});

describe("nib send", () => {
  it("delivers into the receiver's inbox (exit 0)", async () => {
    receiver();
    expect(await runSendCommand([RECV, "run", "the", "tests", "--mode", "steer"])).toBe(0);
    expect(out).toMatch(new RegExp(`^delivered \\S+ to web-\\w+ \\(${RECV}\\)\\n$`));
    const { claimed } = scanInbox(RECV, { home, isDuplicate: () => false });
    expect(claimed).toHaveLength(1);
    expect(claimed[0].msg.body).toBe("run the tests");
    expect(claimed[0].msg.mode).toBe("steer");
    expect(claimed[0].msg.from).toMatchObject({ type: "external", label: "cli" });
  });

  it("unknown target exits 2", async () => {
    expect(await runSendCommand(["nobody-here", "hi"])).toBe(2);
    expect(err).toContain("no session matches");
  });

  it("a receiver with receive=never exits 3", async () => {
    receiver("never");
    expect(await runSendCommand([RECV, "hi"])).toBe(3);
    expect(err).toContain("refuses messages");
  });

  it("missing args print usage and exit 1", async () => {
    expect(await runSendCommand([RECV])).toBe(1);
    expect(err).toContain("Usage: nib send");
  });

  it("rejects bad --wait values and --wait with notify", async () => {
    receiver();
    for (const bad of ["0", "301", "abc", "1.5"]) expect(await runSendCommand([RECV, "hi", "--wait", bad])).toBe(1);
    expect(await runSendCommand([RECV, "hi", "--wait", "5", "--mode", "notify"])).toBe(1);
    expect(scanInbox(RECV, { home, isDuplicate: () => false }).claimed).toHaveLength(0);
  });

  it("--wait prints the reply body and exits 0", async () => {
    const incoming: IncomingPeerMessage[] = [];
    const recv = PeerService.start({ sessionId: RECV, cwd: "/work/web", kind: "interactive", receive: "always", home, timers: false, onMessage: (m) => void incoming.push(m) })!;
    services.push(recv);
    await flushMicrotasks(); // start() defers its crash-recovery scan to a microtask

    const done = runSendCommand([RECV, "ping", "--wait", "20"]);
    const deadline = Date.now() + 5000;
    while (incoming.length === 0 && Date.now() < deadline) {
      recv.scanNow();
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(incoming).toHaveLength(1);
    expect(incoming[0].msg.wantReply).toBe(true);
    recv.reply(incoming[0], "ok", "pong");
    await recv.complete(incoming[0].claimed);

    expect(await done).toBe(0);
    expect(out).toBe("pong\n");
  }, 15_000);

  it("--wait with a declined reply exits 3", async () => {
    const incoming: IncomingPeerMessage[] = [];
    const recv = PeerService.start({ sessionId: RECV, cwd: "/work/web", kind: "interactive", receive: "always", home, timers: false, onMessage: (m) => incoming.push(m) })!;
    services.push(recv);
    await flushMicrotasks(); // start() defers its crash-recovery scan to a microtask
    const done = runSendCommand([RECV, "ping", "--wait", "20"]);
    const deadline = Date.now() + 5000;
    while (incoming.length === 0 && Date.now() < deadline) {
      recv.scanNow();
      await new Promise((r) => setTimeout(r, 50));
    }
    recv.reply(incoming[0], "declined", "");
    await recv.complete(incoming[0].claimed);
    expect(await done).toBe(3);
    expect(err).toContain("declined");
  }, 15_000);

  it("--wait with no reply exits 4", async () => {
    receiver();
    expect(await runSendCommand([RECV, "ping", "--wait", "1"])).toBe(4);
    expect(err).toContain("no reply within 1s");
  }, 10_000);
});

describe("doctor messaging line", () => {
  it("reports not initialised, ok with the policy, and a bad peers dir", () => {
    expect(formatMessagingLine({} as any)).toContain("ok (not initialised yet)");
    receiver();
    expect(formatMessagingLine({ messaging: { enabled: true, receive: "ask" } } as any)).toContain("ok (receive: ask)");
    expect(formatMessagingLine({ messaging: { enabled: false, receive: "ask" } } as any)).toContain("disabled in settings");
    chmodSync(join(home, "peers", "registry"), 0o755);
    expect(formatMessagingLine({} as any)).toMatch(/PROBLEM: .*mode 755, expected 700/);
  });
});
