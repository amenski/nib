import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { inboxDirs, PeerDirError, peersRoot } from "./paths.js";
import { listLivePeers, peerName, readRecord, register, type PeerRecord } from "./registry.js";

let home: string;
const ID = "20261117T184458-a1b2";
const mode = (p: string) => statSync(p).mode & 0o777;
const deadPid = () => spawnSync("true").pid!;

function reg(sessionId = ID) {
  return register({ sessionId, cwd: "/work/api", kind: "interactive", receive: "always", home, heartbeat: false });
}

function writeRecord(rec: Partial<PeerRecord> & { sessionId: string }) {
  const dir = join(peersRoot(home), "registry");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, `${rec.sessionId}.json`), JSON.stringify({ v: 1, pid: process.pid, updatedAt: Date.now(), ...rec }));
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "nib-peers-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("peerName", () => {
  it("joins cwd basename and the id's trailing hex", () => {
    expect(peerName("/Users/x/api", ID)).toBe("api-a1b2");
  });
});

describe("register", () => {
  it("creates a 0600 record and 0700 dirs including the inbox", () => {
    const r = reg();
    expect(r.ok).toBe(true);
    const rec = readRecord(ID, home)!;
    expect(rec).toMatchObject({ sessionId: ID, name: "api-a1b2", pid: process.pid, status: "idle", receive: "always" });
    expect(mode(join(peersRoot(home), "registry", `${ID}.json`))).toBe(0o600);
    expect(mode(join(peersRoot(home), "registry", `${ID}.lock`))).toBe(0o600);
    const dirs = inboxDirs(ID, home);
    for (const d of [peersRoot(home), dirs.base, dirs.tmp, dirs.new, dirs.cur, dirs.bad]) expect(mode(d)).toBe(0o700);
  });

  it("E1: a second live owner of the same id is refused", () => {
    expect(reg().ok).toBe(true);
    expect(reg()).toEqual({ ok: false, heldByPid: process.pid });
  });

  it("reclaims a lock whose holder is dead", () => {
    writeRecord({ sessionId: ID, pid: deadPid() });
    writeFileSync(join(peersRoot(home), "registry", `${ID}.lock`), JSON.stringify({ pid: deadPid() }));
    expect(reg().ok).toBe(true);
  });

  it("reclaims a lock whose holder's heartbeat is stale", () => {
    writeRecord({ sessionId: ID, updatedAt: Date.now() - 120_000 });
    writeFileSync(join(peersRoot(home), "registry", `${ID}.lock`), JSON.stringify({ pid: process.pid }));
    expect(reg().ok).toBe(true);
  });

  it("E8: refuses a symlinked inbox dir", () => {
    const elsewhere = mkdtempSync(join(tmpdir(), "nib-elsewhere-"));
    mkdirSync(peersRoot(home), { mode: 0o700 });
    symlinkSync(elsewhere, join(peersRoot(home), "inbox"));
    expect(() => reg()).toThrow(PeerDirError);
    rmSync(elsewhere, { recursive: true, force: true });
  });

  it("refuses a pre-existing peers dir with loose permissions", () => {
    mkdirSync(peersRoot(home));
    chmodSync(peersRoot(home), 0o755);
    expect(() => reg()).toThrow(/expected 700/);
  });

  it("rejects ids that could escape the peers tree", () => {
    expect(() => reg("../x")).toThrow(/invalid session id/);
  });
});

describe("Registration", () => {
  it("setStatus rewrites the record", () => {
    const r = reg();
    if (!r.ok) throw new Error("register failed");
    r.registration.setStatus("busy");
    expect(readRecord(ID, home)!.status).toBe("busy");
  });

  it("close removes record, lock and an empty inbox", () => {
    const r = reg();
    if (!r.ok) throw new Error("register failed");
    r.registration.close();
    expect(readRecord(ID, home)).toBeNull();
    expect(existsSync(join(peersRoot(home), "registry", `${ID}.lock`))).toBe(false);
    expect(existsSync(inboxDirs(ID, home).base)).toBe(false);
  });

  it("close keeps an inbox with pending mail", () => {
    const r = reg();
    if (!r.ok) throw new Error("register failed");
    writeFileSync(join(inboxDirs(ID, home).new, "pending.json"), "{}");
    r.registration.close();
    expect(existsSync(inboxDirs(ID, home).new)).toBe(true);
  });
});

describe("listLivePeers", () => {
  it("E5: reaps a record whose pid is alive but heartbeat is stale", () => {
    writeRecord({ sessionId: "s-stale", updatedAt: Date.now() - 120_000 });
    writeRecord({ sessionId: "s-fresh" });
    expect(listLivePeers(home).map((r) => r.sessionId)).toEqual(["s-fresh"]);
    expect(readRecord("s-stale", home)).toBeNull();
  });

  it("reaps a record whose pid is dead", () => {
    writeRecord({ sessionId: "s-dead", pid: deadPid() });
    expect(listLivePeers(home)).toEqual([]);
    expect(readRecord("s-dead", home)).toBeNull();
  });

  it("removes orphan inboxes older than 7 days, keeps recent ones", () => {
    const old = join(peersRoot(home), "inbox", "s-old");
    const recent = join(peersRoot(home), "inbox", "s-recent");
    for (const d of [old, recent]) mkdirSync(join(d, "new"), { recursive: true });
    const eightDaysAgo = (Date.now() - 8 * 86_400_000) / 1000;
    for (const p of [join(old, "new"), old]) utimesSync(p, eightDaysAgo, eightDaysAgo);
    listLivePeers(home);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(recent)).toBe(true);
  });

  it("ignores unparseable registry files", () => {
    mkdirSync(join(peersRoot(home), "registry"), { recursive: true });
    writeFileSync(join(peersRoot(home), "registry", "junk.json"), "not json");
    expect(listLivePeers(home)).toEqual([]);
    expect(readFileSync(join(peersRoot(home), "registry", "junk.json"), "utf8")).toBe("not json");
  });
});
