import { lstatSync, readdirSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { sanitizeControlChars } from "../tools/untrusted-content.js";
import { ensureInbox, inboxDirs, isSafePeerId, PeerDirError, safeUnlink, writeExclusive } from "./paths.js";
import { isLive, PEER_PROTOCOL_VERSION, pidAlive, readAllRecords, readRecord, type PeerRecord } from "./registry.js";

/** Message send / scan / claim (docs/cross-session-inbox.md §5). */

export const MAX_BODY_BYTES = 16 * 1024;
const MAX_FILE_BYTES = 32 * 1024;
const PER_SENDER_PENDING = 20;
const INBOX_CAP = 200;
const RATE_PER_MINUTE = 10;
export const DEFAULT_TTL_MS = 60 * 60 * 1000;
const MAX_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_HOPS = 3;
const FILE_NAME = /^\d{13}-[0-9a-f-]{36}\.json$/;

export type DeliveryMode = "queue" | "steer" | "notify";
export type ReplyStatus = "ok" | "aborted" | "error" | "declined" | "unsupported_version" | "hop_limit";

export type PeerFrom =
  | { type: "session"; sessionId: string; name: string; pid: number }
  /** `sessionId` is set when the external sender registered an inbox to receive the reply on. */
  | { type: "external"; label: string; pid: number; ppid: number; sessionId?: string };

export interface PeerMessage {
  v: number;
  messageId: string;
  kind: "message" | "reply";
  mode: DeliveryMode;
  from: PeerFrom;
  to: string;
  body: string;
  wantReply: boolean;
  inReplyTo: string | null;
  status?: ReplyStatus;
  hops: number;
  createdAt: number;
  expiresAt: number;
}

export type SendErrorCode =
  | "self"
  | "not_found"
  | "ambiguous"
  | "not_running"
  | "not_responding"
  | "refused"
  | "incompatible"
  | "inbox_full"
  | "rate_limited"
  | "too_large"
  | "io";

export class SendError extends Error {
  constructor(public readonly code: SendErrorCode, message: string) {
    super(message);
  }
}

/** Display key for one sender, used for the per-sender pending cap. */
export function senderKey(from: PeerFrom): string {
  return from.type === "session" ? from.sessionId : `external:${from.label}:${from.ppid}`;
}

export function fromLabel(from: PeerFrom): string {
  return from.type === "session" ? from.name : `${from.label} (pid ${from.pid})`;
}

/**
 * §6.1: exact id · unique id prefix (≥ 6 chars) · exact name. Never guesses:
 * zero or several matches is an error naming the candidates.
 */
export function resolvePeer(to: string, home?: string, selfId?: string): PeerRecord {
  const records = readAllRecords(home);
  const exact = records.find((r) => r.sessionId === to);
  let matches = exact
    ? [exact]
    : to.length >= 6
      ? records.filter((r) => r.sessionId.startsWith(to))
      : [];
  if (matches.length === 0) matches = records.filter((r) => r.name === to);
  if (matches.length === 1) {
    if (matches[0].sessionId === selfId) throw new SendError("self", "cannot send a message to this session");
    return matches[0];
  }
  const live = records.filter((r) => isLive(r) && r.sessionId !== selfId);
  if (matches.length === 0) {
    const list = live.map((r) => `${r.name} (${r.sessionId})`).join(", ") || "none";
    throw new SendError("not_found", `no session matches "${to}". Live sessions: ${list}`);
  }
  const list = matches.map((r) => `${r.name} (${r.sessionId})`).join(", ");
  throw new SendError("ambiguous", `"${to}" matches several sessions: ${list}. Use the session id.`);
}

/** In-memory per-sending-session limit (§5.2 step 5). */
export class SendRateLimiter {
  private sent: number[] = [];

  take(now = Date.now()): boolean {
    this.sent = this.sent.filter((t) => now - t < 60_000);
    if (this.sent.length >= RATE_PER_MINUTE) return false;
    this.sent.push(now);
    return true;
  }
}

export interface SendInput {
  to: string;
  body: string;
  from: PeerFrom;
  kind?: PeerMessage["kind"];
  mode?: DeliveryMode;
  wantReply?: boolean;
  inReplyTo?: string | null;
  status?: ReplyStatus;
  hops?: number;
  ttlMs?: number;
  home?: string;
  selfId?: string;
  rateLimiter?: SendRateLimiter;
  now?: number;
}

export interface SendResult {
  messageId: string;
  target: PeerRecord;
}

/** §5.2. Throws SendError; on success the message is in the receiver's `new/` (delivered, not read). */
export function sendMessage(input: SendInput): SendResult {
  const now = input.now ?? Date.now();
  const kind = input.kind ?? "message";
  const body = sanitizeControlChars(input.body);
  if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) {
    throw new SendError("too_large", "message too large (max 16 KiB) — write it to a file and send the path");
  }

  const target = resolvePeer(input.to, input.home, input.selfId);
  if (!pidAlive(target.pid)) throw new SendError("not_running", `receiver ${target.name} is not running`);
  if (!isLive(target, now)) {
    const ago = Math.round((now - target.updatedAt) / 60_000);
    throw new SendError("not_responding", `receiver ${target.name} is not responding (last seen ${ago}m ago)`);
  }
  if (Math.floor(target.v) !== PEER_PROTOCOL_VERSION) {
    throw new SendError("incompatible", `receiver ${target.name} speaks protocol v${target.v}, this nib speaks v${PEER_PROTOCOL_VERSION}`);
  }
  // A reply answers this sender's own earlier request, so the receive policy doesn't gate it.
  if (kind === "message" && target.receive === "never") {
    throw new SendError("refused", `receiver ${target.name} refuses messages`);
  }

  let dirs;
  try {
    dirs = ensureInbox(target.sessionId, input.home);
  } catch (err) {
    throw new SendError("io", err instanceof PeerDirError ? err.message : `inbox unavailable: ${(err as Error).message}`);
  }
  const pending = pendingMessages(target.sessionId, input.home);
  if (pending.length >= INBOX_CAP) throw new SendError("inbox_full", `receiver ${target.name} inbox full`);
  const key = senderKey(input.from);
  if (pending.filter((m) => m && senderKey(m.from) === key).length >= PER_SENDER_PENDING) {
    throw new SendError("inbox_full", `receiver ${target.name} inbox full (20 unread from this sender)`);
  }
  if (input.rateLimiter && !input.rateLimiter.take(now)) {
    throw new SendError("rate_limited", "send rate limit reached (10 per minute)");
  }

  const ttl = Math.min(Math.max(input.ttlMs ?? DEFAULT_TTL_MS, 1), MAX_TTL_MS);
  const msg: PeerMessage = {
    v: PEER_PROTOCOL_VERSION,
    messageId: randomUUID(),
    kind,
    mode: kind === "reply" ? "queue" : (input.mode ?? "queue"),
    from: input.from,
    to: target.sessionId,
    body,
    wantReply: kind === "message" && input.mode !== "notify" && (input.wantReply ?? false),
    inReplyTo: input.inReplyTo ?? null,
    ...(input.status ? { status: input.status } : {}),
    hops: input.hops ?? 0,
    createdAt: now,
    expiresAt: now + ttl,
  };
  const name = `${String(now).padStart(13, "0")}-${msg.messageId}.json`;
  const tmp = join(dirs.tmp, name);
  try {
    writeExclusive(tmp, JSON.stringify(msg));
    renameSync(tmp, join(dirs.new, name));
  } catch (err) {
    safeUnlink(tmp);
    throw new SendError("io", `send failed: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`);
  }
  return { messageId: msg.messageId, target };
}

/** Parsed messages sitting in `new/` and `cur/` (unparseable ones count as null). */
function pendingMessages(id: string, home?: string): (PeerMessage | null)[] {
  const dirs = inboxDirs(id, home);
  const out: (PeerMessage | null)[] = [];
  for (const dir of [dirs.new, dirs.cur]) {
    for (const name of safeReaddir(dir)) {
      if (!FILE_NAME.test(name)) continue;
      try {
        out.push(JSON.parse(readFileSync(join(dir, name), "utf8")) as PeerMessage);
      } catch {
        out.push(null);
      }
    }
  }
  return out;
}

export interface ClaimedMessage {
  msg: PeerMessage;
  /** Path in `cur/`; unlink with ackMessage once persisted. */
  file: string;
}

export type QuarantineReason = "not_regular" | "too_large" | "unsafe_mode" | "invalid" | "wrong_recipient" | "unsupported_version" | "expired";

export interface Quarantined {
  name: string;
  reason: QuarantineReason;
  /** Present when the file parsed far enough to reply / notify about it. */
  partial?: Pick<PeerMessage, "messageId" | "from" | "wantReply">;
}

export interface ScanResult {
  claimed: ClaimedMessage[];
  quarantined: Quarantined[];
}

export interface ScanOptions {
  home?: string;
  now?: number;
  /** True when the transcript already holds this messageId (§5.3 step 5). */
  isDuplicate: (messageId: string) => boolean;
  /** Startup crash recovery: also re-process anything left in `cur/`. */
  recoverCur?: boolean;
}

/** §5.3: claim `new/` → `cur/`, validate, quarantine, dedupe. Oldest first. */
export function scanInbox(selfId: string, opts: ScanOptions): ScanResult {
  const dirs = inboxDirs(selfId, opts.home);
  const now = opts.now ?? Date.now();
  const result: ScanResult = { claimed: [], quarantined: [] };
  const names: string[] = [];

  if (opts.recoverCur) {
    for (const name of safeReaddir(dirs.cur)) if (FILE_NAME.test(name)) names.push(name);
  }
  for (const name of safeReaddir(dirs.new)) {
    if (!FILE_NAME.test(name)) continue;
    try {
      renameSync(join(dirs.new, name), join(dirs.cur, name));
      names.push(name);
    } catch {
      // ENOENT: claimed by someone else between readdir and rename
    }
  }
  names.sort();

  for (const name of names) {
    const file = join(dirs.cur, name);
    const checked = validateFile(file, selfId, now);
    if ("reason" in checked) {
      if (checked.reason === "gone") continue;
      quarantine(dirs.cur, dirs.bad, name);
      result.quarantined.push({ name, reason: checked.reason, partial: checked.partial });
      continue;
    }
    if (opts.isDuplicate(checked.msg.messageId)) {
      safeUnlink(file);
      continue;
    }
    result.claimed.push({ msg: checked.msg, file });
  }
  return result;
}

type Checked =
  | { msg: PeerMessage }
  | { reason: QuarantineReason; partial?: Quarantined["partial"] }
  | { reason: "gone" };

function validateFile(file: string, selfId: string, now: number): Checked {
  let st;
  try {
    st = lstatSync(file);
  } catch {
    return { reason: "gone" };
  }
  if (!st.isFile()) return { reason: "not_regular" };
  if (st.uid !== process.getuid!() || (st.mode & 0o022) !== 0) return { reason: "unsafe_mode" };
  if (st.size > MAX_FILE_BYTES) return { reason: "too_large" };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return { reason: "invalid" };
  }
  const partial = partialOf(raw);
  if (!isRecord(raw)) return { reason: "invalid" };
  if (typeof raw.v !== "number" || Math.floor(raw.v) !== PEER_PROTOCOL_VERSION) {
    return { reason: "unsupported_version", partial };
  }
  const msg = parseMessage(raw);
  if (!msg) return { reason: "invalid" };
  if (msg.to !== selfId) return { reason: "wrong_recipient" };
  if (msg.expiresAt <= now) return { reason: "expired", partial };
  return { msg: { ...msg, body: sanitizeControlChars(msg.body) } };
}

function parseMessage(raw: Record<string, unknown>): PeerMessage | null {
  const ok =
    typeof raw.messageId === "string" &&
    /^[0-9a-f-]{36}$/.test(raw.messageId) &&
    (raw.kind === "message" || raw.kind === "reply") &&
    (raw.mode === "queue" || raw.mode === "steer" || raw.mode === "notify") &&
    parseFrom(raw.from) !== null &&
    isSafePeerId(raw.to) &&
    typeof raw.body === "string" &&
    Buffer.byteLength(raw.body, "utf8") <= MAX_BODY_BYTES &&
    typeof raw.wantReply === "boolean" &&
    (raw.inReplyTo === null || typeof raw.inReplyTo === "string") &&
    Number.isInteger(raw.hops) &&
    (raw.hops as number) >= 0 &&
    typeof raw.createdAt === "number" &&
    typeof raw.expiresAt === "number";
  if (!ok) return null;
  return {
    v: raw.v as number,
    messageId: raw.messageId as string,
    kind: raw.kind as PeerMessage["kind"],
    mode: raw.mode as DeliveryMode,
    from: parseFrom(raw.from)!,
    to: raw.to as string,
    body: raw.body as string,
    wantReply: raw.wantReply as boolean,
    inReplyTo: raw.inReplyTo as string | null,
    ...(typeof raw.status === "string" ? { status: raw.status as ReplyStatus } : {}),
    hops: raw.hops as number,
    createdAt: raw.createdAt as number,
    expiresAt: raw.expiresAt as number,
  };
}

function parseFrom(raw: unknown): PeerFrom | null {
  if (!isRecord(raw) || typeof raw.pid !== "number") return null;
  if (raw.type === "session" && isSafePeerId(raw.sessionId) && typeof raw.name === "string") {
    return { type: "session", sessionId: raw.sessionId, name: sanitizeControlChars(raw.name).slice(0, 80), pid: raw.pid };
  }
  if (raw.type === "external" && typeof raw.label === "string" && typeof raw.ppid === "number") {
    if (raw.sessionId !== undefined && !isSafePeerId(raw.sessionId)) return null;
    return {
      type: "external",
      label: sanitizeControlChars(raw.label).slice(0, 80),
      pid: raw.pid,
      ppid: raw.ppid,
      ...(raw.sessionId !== undefined ? { sessionId: raw.sessionId as string } : {}),
    };
  }
  return null;
}

function partialOf(raw: unknown): Quarantined["partial"] {
  if (!isRecord(raw) || typeof raw.messageId !== "string") return undefined;
  const from = parseFrom(raw.from);
  if (!from) return undefined;
  return { messageId: raw.messageId, from, wantReply: raw.wantReply === true };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function quarantine(cur: string, bad: string, name: string): void {
  try {
    renameSync(join(cur, name), join(bad, name));
  } catch {
    safeUnlink(join(cur, name));
  }
}

/** Drop a claimed message once it is persisted (§5.3 step 8). */
export function ackMessage(claimed: ClaimedMessage): void {
  safeUnlink(claimed.file);
}

/** True when the receiving side should still be considered reachable for a reply. */
export function receiverReachable(sessionId: string, home?: string): boolean {
  const rec = readRecord(sessionId, home);
  return rec !== null && isLive(rec);
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
