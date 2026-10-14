import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DenialReader,
  GRACE_MS,
  formatDenialBlock,
  groupDenials,
  opClassOf,
  parseDenialLine,
  summarizeDenials,
  type DenialSurface,
  type SandboxDenial,
} from "./denials.js";

const line = (pid: number, op: string, target: string, proc = "touch") =>
  `2026-10-14 18:14:33.145 E  kernel[0:40c235] (Sandbox) Sandbox: ${proc}(${pid}) deny(1) ${op} ${target}`;

describe("parseDenialLine", () => {
  it("reads process, pid, operation and target", () => {
    expect(parseDenialLine(line(21540, "file-write-create", "/opt/x"), 5)).toEqual({
      proc: "touch", pid: 21540, op: "file-write-create", target: "/opt/x", count: 1, at: 5,
    });
  });

  it("keeps spaces in process names and targets", () => {
    const d = parseDenialLine(line(7, "file-read-data", "/Users/a/My Docs/x.txt", "Google Chrome Helper"));
    expect(d?.proc).toBe("Google Chrome Helper");
    expect(d?.target).toBe("/Users/a/My Docs/x.txt");
  });

  it("folds duplicate-report lines into a count", () => {
    const dup = "2026-10-14 18:14:35.774 E  kernel[0:3f8127] (Sandbox) 3 duplicate reports for Sandbox: touch(21540) deny(1) file-write-create /opt/x";
    expect(parseDenialLine(dup)).toMatchObject({ pid: 21540, op: "file-write-create", target: "/opt/x", count: 3 });
    expect(parseDenialLine(dup.replace("3 duplicate reports", "1 duplicate report"))?.count).toBe(1);
  });

  it("accepts an operation with no target", () => {
    expect(parseDenialLine(line(9, "process-fork", "").trimEnd())).toMatchObject({ op: "process-fork", target: "" });
  });

  it("ignores headers, allow lines and other policy subsystems", () => {
    expect(parseDenialLine('Filtering the log data using "sender == "Sandbox""')).toBeNull();
    expect(parseDenialLine("Timestamp               Ty Process[PID:TID]")).toBeNull();
    expect(parseDenialLine("2026-10-14 18:14:35.514 Df kernel[0:40bfc0] (Sandbox) Sandbox: ContextStoreAgent(900) allow file-read-data /Applications/Firefox.app")).toBeNull();
    expect(parseDenialLine("2026-10-14 18:14:35.267 E  kernel[0:3e7733] (Sandbox) System Policy: RTProtectionDaemon(566) deny(1) system-privilege 1016")).toBeNull();
    expect(parseDenialLine("")).toBeNull();
  });
});

describe("groupDenials", () => {
  const home = "/Users/me";
  const d = (op: string, target: string, count = 1): SandboxDenial => ({ proc: "p", pid: 1, op, target, count, at: 0 });

  it("classifies operations", () => {
    expect(["file-write-create", "file-write-data", "file-read-data", "process-exec*", "mach-lookup", "network-outbound", "file-ioctl"].map(opClassOf))
      .toEqual(["write", "write", "read", "exec", "mach", "network", "other"]);
  });

  it("keys paths by the containing directory, never the file", () => {
    const g = groupDenials([
      d("file-write-create", "/opt/x"),
      d("file-write-create", "/opt/y"),
      d("file-write-data", "/private/var/folders/k9/abc/T/f"),
      d("file-write-create", "/Users/me/.pub-cache/hosted/pkg/a"),
      d("file-write-create", "/Users/me/loose.txt"),
    ], home);
    expect(g.map((x) => x.key).sort()).toEqual(["/opt", "/private/var", "~/.pub-cache", "~/loose.txt"]);
    const opt = g.find((x) => x.key === "/opt")!;
    expect(opt).toMatchObject({ opClass: "write", count: 2, ops: ["file-write-create"], samples: ["/opt/x", "/opt/y"] });
  });

  it("keys services and network targets as given, sums repeat counts, most frequent first", () => {
    const g = groupDenials([d("mach-lookup", "com.apple.foo"), d("network-outbound", "remote tcp 1.2.3.4:443", 5), d("mach-lookup", "com.apple.foo", 2)], home);
    expect(g.map((x) => [x.opClass, x.key, x.count])).toEqual([
      ["network", "remote tcp 1.2.3.4:443", 5],
      ["mach", "com.apple.foo", 3],
    ]);
  });

  it("keeps the same path under write and read apart and caps samples", () => {
    const g = groupDenials([d("file-write-create", "/opt/a"), d("file-read-data", "/opt/b"), ...["c", "d", "e", "f"].map((n) => d("file-write-create", `/opt/${n}`))], home);
    expect(g).toHaveLength(2);
    expect(g.find((x) => x.opClass === "write")!.samples).toHaveLength(3);
  });
});

describe("formatDenialBlock", () => {
  it("is empty with nothing denied", () => {
    expect(formatDenialBlock([])).toBe("");
  });

  it("names the operation, the place and the count", () => {
    const groups = groupDenials([
      { proc: "p", pid: 1, op: "file-write-create", target: "/Users/me/.pub-cache/a", count: 3, at: 0 },
      { proc: "p", pid: 1, op: "mach-lookup", target: "com.apple.foo", count: 1, at: 0 },
    ], "/Users/me");
    expect(formatDenialBlock(groups)).toBe("[nib] sandbox denied: file-write-create under ~/.pub-cache (3×); mach-lookup com.apple.foo (1×)");
  });

  it("collapses past eight groups", () => {
    const denials = Array.from({ length: 10 }, (_, i) => ({ proc: "p", pid: 1, op: "mach-lookup", target: `svc.${i}`, count: 1, at: 0 }));
    expect(summarizeDenials(groupDenials(denials))).toMatch(/; \+2 more$/);
  });
});

describe("DenialReader attribution", () => {
  function fakeProc(pid: number): ChildProcess & EventEmitter {
    return Object.assign(new EventEmitter(), { pid }) as unknown as ChildProcess & EventEmitter;
  }
  const bash = (callId: string): DenialSurface => ({ kind: "bash", callId });

  /** Reader with a fake `ps`: `table` maps pid → pgid; a missing pid is a process that is gone. */
  function makeReader(table: Record<number, number> = {}) {
    const psPgid = vi.fn(async (pid: number) => table[pid] ?? null);
    const reader = new DenialReader({ psPgid });
    reader.running = true;
    const seen: Array<{ surface: DenialSurface | null; probable: boolean }> = [];
    reader.subscribe((surface, _d, probable) => seen.push({ surface, probable }));
    return { reader, psPgid, seen };
  }
  const close = async (p: EventEmitter) => {
    p.emit("close", 0);
    await vi.advanceTimersByTimeAsync(GRACE_MS);
  };

  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("attributes by exact pid without asking ps", async () => {
    const { reader, psPgid } = makeReader();
    const p = fakeProc(100);
    const a = reader.attach(p, bash("c1"), { matchGroup: true });
    reader.feed(line(100, "file-write-create", "/opt/x", "sh"));
    await close(p);
    expect(await a.settle()).toMatchObject([{ key: "/opt", count: 1 }]);
    expect(psPgid).not.toHaveBeenCalled();
  });

  it("attributes a descendant by process group", async () => {
    const { reader } = makeReader({ 555: 100 });
    const p = fakeProc(100);
    const a = reader.attach(p, bash("c1"), { matchGroup: true });
    reader.feed(line(555, "file-write-create", "/opt/x"));
    await close(p);
    expect(await a.settle()).toHaveLength(1);
  });

  it("does not claim a live process from another group (a daemon)", async () => {
    const { reader, seen } = makeReader({ 947: 947 });
    const p = fakeProc(100);
    const a = reader.attach(p, bash("c1"), { matchGroup: true });
    reader.feed(line(947, "mach-lookup", "com.apple.contactsd.persistence", "imagent"));
    await close(p);
    expect(await a.settle()).toEqual([]);
    expect(seen).toEqual([]);
  });

  it("attributes a vanished process to the single command in flight, flagged probable", async () => {
    const { reader, seen } = makeReader();
    const p = fakeProc(100);
    const a = reader.attach(p, bash("c1"), { matchGroup: true });
    reader.feed(line(9001, "file-write-create", "/opt/x"));
    await close(p);
    expect(await a.settle()).toHaveLength(1);
    expect(seen).toEqual([{ surface: bash("c1"), probable: true }]);
  });

  it("prefers the foreground bash surface over background jobs", async () => {
    const { reader } = makeReader();
    const job = fakeProc(200);
    reader.attach(job, { kind: "job", jobId: "j" }, { matchGroup: true });
    const p = fakeProc(100);
    const a = reader.attach(p, bash("c1"), { matchGroup: true });
    reader.feed(line(9001, "file-write-create", "/opt/x"));
    await close(p);
    expect(await a.settle()).toHaveLength(1);
  });

  it("leaves an ambiguous denial unattributed", async () => {
    const { reader, seen } = makeReader();
    const j1 = fakeProc(200);
    const j2 = fakeProc(300);
    const a = reader.attach(j1, { kind: "job", jobId: "1" }, { matchGroup: true });
    reader.attach(j2, { kind: "job", jobId: "2" }, { matchGroup: true });
    reader.feed(line(9001, "file-write-create", "/opt/x"));
    await close(j1);
    expect(await a.settle()).toEqual([]);
    expect(seen).toEqual([{ surface: null, probable: true }]);
  });

  it("matches pid-only surfaces exactly and never by heuristic", async () => {
    const { reader } = makeReader({ 555: 100 });
    const mcp = fakeProc(100);
    const a = reader.attach(mcp, { kind: "mcp", server: "s" }, { matchGroup: false });
    reader.feed(line(555, "file-write-create", "/opt/x"));
    reader.feed(line(9001, "file-write-create", "/opt/y"));
    reader.feed(line(100, "file-write-create", "/opt/z", "node"));
    await close(mcp);
    expect((await a.settle()).map((g) => g.samples)).toEqual([["/opt/z"]]);
  });

  it("keeps listening through the grace period and stops after it", async () => {
    const { reader } = makeReader();
    const p = fakeProc(100);
    const a = reader.attach(p, bash("c1"), { matchGroup: true });
    p.emit("close", 0);
    await vi.advanceTimersByTimeAsync(GRACE_MS - 1);
    reader.feed(line(100, "file-write-create", "/opt/late", "sh"));
    await vi.advanceTimersByTimeAsync(1);
    reader.feed(line(100, "file-write-create", "/opt/too-late", "sh"));
    expect((await a.settle()).flatMap((g) => g.samples)).toEqual(["/opt/late"]);
  });

  it("settle waits for an in-flight ps lookup", async () => {
    let release!: (v: number | null) => void;
    const reader = new DenialReader({ psPgid: () => new Promise((r) => { release = r; }) });
    reader.running = true;
    const p = fakeProc(100);
    const a = reader.attach(p, bash("c1"), { matchGroup: true });
    reader.feed(line(555, "file-write-create", "/opt/x"));
    await close(p);
    let done = false;
    const settled = a.settle().then((g) => { done = true; return g; });
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toBe(false);
    release(100);
    expect(await settled).toHaveLength(1);
  });

  it("retarget keeps what was collected and reports the new surface afterwards", async () => {
    const { reader, seen } = makeReader();
    const p = fakeProc(100);
    const a = reader.attach(p, bash("c1"), { matchGroup: true });
    reader.feed(line(100, "file-write-create", "/opt/a", "sh"));
    a.retarget({ kind: "job", jobId: "j1" });
    reader.feed(line(100, "file-write-create", "/opt/b", "sh"));
    expect(a.snapshot()[0].samples).toEqual(["/opt/a", "/opt/b"]);
    expect(seen.map((s) => s.surface)).toEqual([bash("c1"), { kind: "job", jobId: "j1" }]);
  });

  it("is inert when the stream is not running", async () => {
    const reader = new DenialReader();
    const a = reader.attach(fakeProc(100), bash("c1"), { matchGroup: true });
    expect(await a.settle()).toEqual([]);
  });
});

describe("DenialReader.start", () => {
  type FakeLog = ChildProcess & { stdout: PassThrough };
  function fakeLog(): FakeLog {
    return Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      exitCode: null,
      signalCode: null,
      kill: vi.fn(),
      unref: vi.fn(),
    }) as unknown as FakeLog;
  }

  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("is up after the first line and feeds later ones", async () => {
    const log = fakeLog();
    const reader = new DenialReader({ spawnLog: () => log, psPgid: async () => null });
    const started = reader.start();
    log.stdout.write('Filtering the log data using "sender == "Sandbox""\n');
    await expect(started).resolves.toEqual({ ok: true });
    expect(reader.running).toBe(true);
  });

  it("reports a spawn error and stays down", async () => {
    const log = fakeLog();
    const reader = new DenialReader({ spawnLog: () => log });
    const started = reader.start();
    log.emit("error", new Error("spawn /usr/bin/log ENOENT"));
    await expect(started).resolves.toEqual({ ok: false, reason: "spawn /usr/bin/log ENOENT" });
    expect(reader.running).toBe(false);
  });

  it("reports an early exit", async () => {
    const log = fakeLog();
    const reader = new DenialReader({ spawnLog: () => log });
    const started = reader.start();
    log.emit("exit", 1);
    await expect(started).resolves.toEqual({ ok: false, reason: "log stream exited (1)" });
  });

  it("counts a silent but live process as up after the timeout", async () => {
    const log = fakeLog();
    const reader = new DenialReader({ spawnLog: () => log });
    const started = reader.start();
    await vi.advanceTimersByTimeAsync(1500);
    await expect(started).resolves.toEqual({ ok: true });
  });
});
