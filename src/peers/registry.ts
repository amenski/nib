import { readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  ensureInbox,
  ensureRegistryDir,
  inboxDirs,
  isSafePeerId,
  peersRoot,
  registryDir,
  safeUnlink,
  writeAtomicPrivate,
  writeExclusive,
} from "./paths.js";

/** Peer discovery registry (docs/cross-session-inbox.md §4). */

export const PEER_PROTOCOL_VERSION = 1;
export const HEARTBEAT_MS = 30_000;
export const STALE_MS = 90_000;
const ORPHAN_INBOX_MS = 7 * 24 * 60 * 60 * 1000;

export type ReceivePolicy = "never" | "ask" | "always";
export type PeerStatus = "idle" | "busy";

export interface PeerRecord {
  v: number;
  sessionId: string;
  name: string;
  pid: number;
  instance: string;
  cwd: string;
  kind: "interactive" | "external";
  status: PeerStatus;
  receive: ReceivePolicy;
  startedAt: number;
  updatedAt: number;
}

/** `<cwd basename>-<last 4 hex of the session id>`, e.g. `api-3f2a`. */
export function peerName(cwd: string, sessionId: string): string {
  const base = basename(cwd).replace(/[^A-Za-z0-9._-]/g, "") || "nib";
  const hex = sessionId.replace(/[^0-9a-f]/gi, "").slice(-4).toLowerCase();
  return `${base}-${hex}`;
}

/** EPERM means another OS user's process — never one of ours, so the record is bogus. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function isLive(rec: PeerRecord, now = Date.now()): boolean {
  return pidAlive(rec.pid) && now - rec.updatedAt < STALE_MS;
}

function recordPath(id: string, home?: string): string {
  return join(registryDir(home), `${id}.json`);
}

function lockPath(id: string, home?: string): string {
  return join(registryDir(home), `${id}.lock`);
}

export function readRecord(id: string, home?: string): PeerRecord | null {
  if (!isSafePeerId(id)) return null;
  try {
    const rec = JSON.parse(readFileSync(recordPath(id, home), "utf8")) as PeerRecord;
    if (typeof rec?.pid !== "number" || rec.sessionId !== id) return null;
    return rec;
  } catch {
    return null;
  }
}

function removeRecordAndLock(id: string, home?: string): void {
  safeUnlink(recordPath(id, home));
  safeUnlink(lockPath(id, home));
}

/** Every registry record, live or not (unparseable files skipped). */
export function readAllRecords(home?: string): PeerRecord[] {
  let names: string[];
  try {
    names = readdirSync(registryDir(home));
  } catch {
    return [];
  }
  const out: PeerRecord[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const rec = readRecord(name.slice(0, -5), home);
    if (rec) out.push(rec);
  }
  return out;
}

/**
 * Live peers. Stale records are reaped on the way, plus inbox dirs with no
 * record and nothing younger than 7 days.
 */
export function listLivePeers(home?: string, now = Date.now()): PeerRecord[] {
  const live: PeerRecord[] = [];
  for (const rec of readAllRecords(home)) {
    if (isLive(rec, now)) live.push(rec);
    else removeRecordAndLock(rec.sessionId, home);
  }
  reapOrphanInboxes(new Set(live.map((r) => r.sessionId)), home, now);
  return live;
}

function reapOrphanInboxes(liveIds: Set<string>, home: string | undefined, now: number): void {
  const root = join(peersRoot(home), "inbox");
  let ids: string[];
  try {
    ids = readdirSync(root);
  } catch {
    return;
  }
  for (const id of ids) {
    if (!isSafePeerId(id) || liveIds.has(id)) continue;
    // A session that exited cleanly with mail pending keeps its inbox until resume or expiry.
    if (newestMtime(join(root, id)) > now - ORPHAN_INBOX_MS) continue;
    rmSync(join(root, id), { recursive: true, force: true });
  }
}

function newestMtime(path: string): number {
  let newest = 0;
  try {
    const st = statSync(path);
    newest = st.mtimeMs;
    if (!st.isDirectory()) return newest;
    for (const child of readdirSync(path)) newest = Math.max(newest, newestMtime(join(path, child)));
  } catch {
    // vanished mid-walk
  }
  return newest;
}

export type RegisterResult = { ok: true; registration: Registration } | { ok: false; heldByPid: number };

export interface RegisterOptions {
  sessionId: string;
  cwd: string;
  kind: PeerRecord["kind"];
  receive: ReceivePolicy;
  home?: string;
  /** Start the 30 s heartbeat timer. Off in tests. */
  heartbeat?: boolean;
}

/**
 * Claim `sessionId` for this process: exclusive lock, registry record, inbox.
 * Fails (without throwing) when another live process already owns the id.
 * Throws PeerDirError when the peers tree fails its permission checks.
 */
export function register(opts: RegisterOptions): RegisterResult {
  if (!isSafePeerId(opts.sessionId)) throw new Error(`invalid session id: ${opts.sessionId}`);
  ensureRegistryDir(opts.home);
  const instance = randomBytes(16).toString("hex");
  const lock = lockPath(opts.sessionId, opts.home);
  const lockBody = JSON.stringify({ pid: process.pid, instance });

  for (let attempt = 0; ; attempt++) {
    try {
      writeExclusive(lock, lockBody);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const holder = readLockPid(lock);
      const rec = readRecord(opts.sessionId, opts.home);
      const holderLive = holder !== null && pidAlive(holder) && rec !== null && rec.pid === holder && isLive(rec);
      // A second EEXIST after clearing a stale lock means another process won the race.
      if (holderLive || attempt > 0) return { ok: false, heldByPid: holder ?? -1 };
      removeRecordAndLock(opts.sessionId, opts.home);
    }
  }

  ensureInbox(opts.sessionId, opts.home);
  const now = Date.now();
  const record: PeerRecord = {
    v: PEER_PROTOCOL_VERSION,
    sessionId: opts.sessionId,
    name: peerName(opts.cwd, opts.sessionId),
    pid: process.pid,
    instance,
    cwd: opts.cwd,
    kind: opts.kind,
    status: "idle",
    receive: opts.receive,
    startedAt: now,
    updatedAt: now,
  };
  const registration = new Registration(record, opts.home);
  registration.heartbeat();
  if (opts.heartbeat !== false) registration.startTimer();
  return { ok: true, registration };
}

function readLockPid(lock: string): number | null {
  try {
    const pid = JSON.parse(readFileSync(lock, "utf8"))?.pid;
    return typeof pid === "number" ? pid : null;
  } catch {
    return null;
  }
}

export class Registration {
  private timer: NodeJS.Timeout | undefined;
  private closed = false;

  constructor(private rec: PeerRecord, private home?: string) {}

  get record(): Readonly<PeerRecord> {
    return this.rec;
  }

  heartbeat(): void {
    if (this.closed) return;
    this.rec = { ...this.rec, updatedAt: Date.now() };
    writeAtomicPrivate(recordPath(this.rec.sessionId, this.home), JSON.stringify(this.rec));
  }

  setStatus(status: PeerStatus): void {
    if (this.rec.status === status) return;
    this.rec = { ...this.rec, status };
    this.heartbeat();
  }

  setReceive(receive: ReceivePolicy): void {
    this.rec = { ...this.rec, receive };
    this.heartbeat();
  }

  /** Node fires an overdue interval as soon as the process wakes from sleep / SIGCONT. */
  startTimer(): void {
    this.timer = setInterval(() => {
      try {
        this.heartbeat();
      } catch {
        // disk trouble: the record goes stale and senders see "not responding"
      }
    }, HEARTBEAT_MS);
    this.timer.unref();
  }

  /** Clean exit: drop record + lock; drop the inbox only if nothing is pending. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    removeRecordAndLock(this.rec.sessionId, this.home);
    const dirs = inboxDirs(this.rec.sessionId, this.home);
    const pending = [dirs.new, dirs.cur].some((d) => {
      try {
        return readdirSync(d).length > 0;
      } catch {
        return false;
      }
    });
    if (!pending) rmSync(dirs.base, { recursive: true, force: true });
  }
}
