import { readdirSync, watch, type FSWatcher } from "node:fs";
import {
  ackMessage,
  fromLabel,
  MAX_HOPS,
  receiverReachable,
  scanInbox,
  senderKey,
  sendMessage,
  SendError,
  SendRateLimiter,
  type ClaimedMessage,
  type DeliveryMode,
  type PeerFrom,
  type PeerMessage,
  type ReplyStatus,
  type SendResult,
} from "./inbox.js";
import { formatPeerPayload, peerEchoText } from "./format.js";
import { PeerDirError, inboxDirs, peersSupported } from "./paths.js";
import { listLivePeers, register, type PeerRecord, type ReceivePolicy, type Registration } from "./registry.js";

/**
 * One session's end of the cross-session inbox (docs/cross-session-inbox.md):
 * registration, wake (fs.watch hint + 2 s scan), receive policy, replies and
 * waiting senders. Interactive TUI sessions receive; `external` instances
 * (headless runs, `nib send --wait`) exist only so replies have an inbox.
 */

const SCAN_INTERVAL_MS = 2_000;
const LIVENESS_CHECK_MS = 5_000;

export interface IncomingPeerMessage {
  claimed: ClaimedMessage;
  msg: PeerMessage;
  /** User-role text for the model. */
  payload: string;
  /** Scrollback line. */
  echo: string;
  /** Receive policy is `ask` and this sender isn't allowed yet. */
  needsApproval: boolean;
}

export interface PeerServiceOptions {
  sessionId: string;
  cwd: string;
  kind: PeerRecord["kind"];
  receive: ReceivePolicy;
  home?: string;
  /** messageIds this session's transcript already holds (dedupe source of truth). */
  alreadyReceived?: Iterable<string>;
  /** Persist the dedupe ledger entry. Runs before the inbox file is deleted. */
  persistReceived?: (messageId: string) => Promise<void>;
  onMessage?: (incoming: IncomingPeerMessage) => void;
  onNotice?: (text: string) => void;
  /** Label for `from` on an external instance (`cli`, `exec`). */
  label?: string;
  /** Watch + interval scan. Off in tests, which call scanNow(). */
  timers?: boolean;
}

export type WaitResult =
  | { kind: "reply"; msg: PeerMessage }
  | { kind: "timeout" }
  | { kind: "receiver_exited" }
  | { kind: "aborted" };

export class PeerService {
  /** Hop count of the turn now running (0 = a human turn). Sends go out at +1. */
  turnHops = 0;

  private readonly received: Set<string>;
  /** Handed out but not completed yet; a recovery pass over cur/ must not deliver them twice. */
  private readonly inFlight = new Set<string>();
  private readonly allowedSenders = new Set<string>();
  private readonly waits = new Map<string, (r: WaitResult) => void>();
  /** Ids this session sent with wantReply and has not had answered. A `reply`
   *  is accepted only against one of these — the kind is a sender's claim, and
   *  replies skip the receive policy. In memory: after a restart, late replies drop. */
  private readonly awaitingReply = new Set<string>();
  private readonly rate = new SendRateLimiter();
  private watcher: FSWatcher | undefined;
  private interval: NodeJS.Timeout | undefined;
  private closed = false;

  private constructor(
    private readonly reg: Registration,
    private readonly opts: PeerServiceOptions,
  ) {
    this.received = new Set(opts.alreadyReceived ?? []);
  }

  /**
   * Register and start receiving. Returns null (after one notice) when
   * messaging can't run here: Windows, unsafe peers dir, or the session is
   * already open in another live process.
   */
  static start(opts: PeerServiceOptions): PeerService | null {
    if (!peersSupported()) return null;
    let result;
    try {
      result = register({ sessionId: opts.sessionId, cwd: opts.cwd, kind: opts.kind, receive: opts.receive, home: opts.home, heartbeat: opts.timers !== false });
    } catch (err) {
      const why = err instanceof PeerDirError ? err.message : (err as Error).message;
      opts.onNotice?.(`messaging off: ${why}`);
      return null;
    }
    if (!result.ok) {
      opts.onNotice?.(`messaging off: session also open in pid ${result.heldByPid}`);
      return null;
    }
    const service = new PeerService(result.registration, opts);
    // Deferred so the caller has stored the service before a recovered message
    // reaches its handler (the handler looks the service up to reply).
    queueMicrotask(() => service.scan(true));
    if (opts.timers !== false) service.startTimers();
    return service;
  }

  get sessionId(): string {
    return this.reg.record.sessionId;
  }

  get name(): string {
    return this.reg.record.name;
  }

  get receive(): ReceivePolicy {
    return this.reg.record.receive;
  }

  private get from(): PeerFrom {
    const rec = this.reg.record;
    return rec.kind === "interactive"
      ? { type: "session", sessionId: rec.sessionId, name: rec.name, pid: rec.pid }
      : { type: "external", label: this.opts.label ?? "external", pid: rec.pid, ppid: process.ppid, sessionId: rec.sessionId };
  }

  setStatus(status: "idle" | "busy"): void {
    this.safe(() => this.reg.setStatus(status));
  }

  setReceive(receive: ReceivePolicy): void {
    this.safe(() => this.reg.setReceive(receive));
  }

  /** `a` in the ask modal: accept this sender for the rest of this session (not persisted). */
  allowSender(from: PeerFrom): void {
    this.allowedSenders.add(senderKey(from));
  }

  /** Live peers, excluding this session. */
  peers(): PeerRecord[] {
    return listLivePeers(this.opts.home).filter((r) => r.sessionId !== this.sessionId);
  }

  scanNow(): void {
    this.scan(false);
  }

  private scan(recoverCur: boolean): void {
    if (this.closed) return;
    let result;
    try {
      result = scanInbox(this.sessionId, { home: this.opts.home, isDuplicate: (id) => this.received.has(id), recoverCur });
    } catch {
      return; // inbox vanished or unreadable; the next tick retries
    }
    for (const q of result.quarantined) {
      if (q.reason === "expired" && q.partial) {
        this.opts.onNotice?.(`1 expired message from ${fromLabel(q.partial.from)} discarded`);
      }
      if (q.reason === "unsupported_version" && q.partial?.wantReply) {
        this.replyTo(q.partial.from, q.partial.messageId, "unsupported_version", "");
      }
    }
    for (const claimed of result.claimed) this.route(claimed);
  }

  private route(claimed: ClaimedMessage): void {
    const msg = claimed.msg;
    if (this.inFlight.has(msg.messageId)) return;
    this.inFlight.add(msg.messageId);
    if (msg.kind === "reply") {
      if (!msg.inReplyTo || !this.awaitingReply.delete(msg.inReplyTo)) {
        void this.complete(claimed); // unsolicited or duplicate reply: never a turn
        return;
      }
    }
    if (msg.kind === "reply" && msg.inReplyTo && this.waits.has(msg.inReplyTo)) {
      const resolve = this.waits.get(msg.inReplyTo)!;
      this.waits.delete(msg.inReplyTo);
      // Ack first: a `nib send --wait` closes right after, and close() keeps an inbox that still holds mail.
      void this.complete(claimed).finally(() => resolve({ kind: "reply", msg }));
      return;
    }
    // External instances only exist to catch awaited replies.
    if (this.reg.record.kind === "external" || !this.opts.onMessage) {
      void this.complete(claimed);
      return;
    }
    if (msg.kind === "message" && msg.hops > MAX_HOPS) {
      this.replyTo(msg.from, msg.messageId, "hop_limit", "", msg.wantReply);
      void this.complete(claimed);
      return;
    }
    if (msg.kind === "message" && this.receive === "never") {
      this.replyTo(msg.from, msg.messageId, "declined", "", msg.wantReply);
      void this.complete(claimed);
      return;
    }
    // A late reply (its waiter timed out) still reaches the model as a queue message.
    const deliverable: PeerMessage = msg.kind === "reply" ? { ...msg, mode: "queue", wantReply: false } : msg;
    this.opts.onMessage({
      claimed,
      msg: deliverable,
      payload: formatPeerPayload(deliverable),
      echo: peerEchoText(deliverable),
      needsApproval: msg.kind === "message" && this.receive === "ask" && !this.allowedSenders.has(senderKey(msg.from)),
    });
  }

  /** The message reached the transcript (or was dropped on purpose): ledger first, then the file. */
  async complete(claimed: ClaimedMessage): Promise<void> {
    const id = claimed.msg.messageId;
    this.received.add(id);
    this.inFlight.delete(id);
    try {
      await this.opts.persistReceived?.(id);
    } catch {
      // a lost ledger row means a possible duplicate after a crash, never a lost message
    }
    ackMessage(claimed);
  }

  /** Declined in the ask modal. */
  async decline(incoming: IncomingPeerMessage): Promise<void> {
    this.replyTo(incoming.msg.from, incoming.msg.messageId, "declined", "", incoming.msg.wantReply);
    await this.complete(incoming.claimed);
  }

  /** Send the one reply a `wantReply` message is owed (§5.7). No-op otherwise. */
  reply(incoming: IncomingPeerMessage, status: ReplyStatus, body: string): void {
    this.replyTo(incoming.msg.from, incoming.msg.messageId, status, body, incoming.msg.wantReply);
  }

  private replyTo(to: PeerFrom, inReplyTo: string, status: ReplyStatus, body: string, wanted = true): void {
    if (!wanted || !to.sessionId) return;
    try {
      sendMessage({
        to: to.sessionId,
        body: truncateUtf8(body, 16 * 1024),
        from: this.from,
        kind: "reply",
        inReplyTo,
        status,
        home: this.opts.home,
        selfId: this.sessionId,
      });
    } catch {
      // sender gone (E29): nothing left to tell
    }
  }

  /** Outgoing message from this session (send_message tool, `nib send`). Throws SendError. */
  send(args: { to: string; body: string; mode?: DeliveryMode; wantReply?: boolean }): SendResult {
    const sent = sendMessage({
      ...args,
      from: this.from,
      hops: this.turnHops + 1,
      home: this.opts.home,
      selfId: this.sessionId,
      rateLimiter: this.rate,
    });
    if (args.wantReply && args.mode !== "notify") this.awaitingReply.add(sent.messageId);
    return sent;
  }

  /** Resolve with the reply to `messageId`, or why none came. A late reply after timeout becomes a queue message. */
  waitForReply(messageId: string, targetId: string, timeoutMs: number, signal?: AbortSignal): Promise<WaitResult> {
    return new Promise<WaitResult>((resolve) => {
      const finish = (r: WaitResult) => {
        clearTimeout(timeout);
        clearInterval(liveness);
        signal?.removeEventListener("abort", onAbort);
        this.waits.delete(messageId);
        resolve(r);
      };
      const onAbort = () => finish({ kind: "aborted" });
      const timeout = setTimeout(() => finish({ kind: "timeout" }), timeoutMs);
      const liveness = setInterval(() => {
        this.scanNow();
        if (this.waits.has(messageId) && !receiverReachable(targetId, this.opts.home)) finish({ kind: "receiver_exited" });
      }, LIVENESS_CHECK_MS);
      if (signal?.aborted) return finish({ kind: "aborted" });
      signal?.addEventListener("abort", onAbort);
      this.waits.set(messageId, finish);
      this.scanNow();
    });
  }

  /** Files waiting in new/ + cur/ (for /peers). */
  pendingCount(): number {
    const dirs = inboxDirs(this.sessionId, this.opts.home);
    let n = 0;
    for (const d of [dirs.new, dirs.cur]) {
      try {
        n += readdirSync(d).length;
      } catch {
        // missing dir = nothing pending
      }
    }
    return n;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.watcher?.close();
    if (this.interval) clearInterval(this.interval);
    for (const finish of [...this.waits.values()]) finish({ kind: "aborted" });
    this.safe(() => this.reg.close());
  }

  private startTimers(): void {
    try {
      // A hint only: FSEvents coalesces and drops; the interval scan is the truth.
      this.watcher = watch(inboxDirs(this.sessionId, this.opts.home).new, () => this.scanNow());
      this.watcher.on("error", () => this.watcher?.close());
      this.watcher.unref();
    } catch {
      // no watch support (network home): interval only
    }
    this.interval = setInterval(() => this.scanNow(), SCAN_INTERVAL_MS);
    this.interval.unref();
  }

  private safe(fn: () => void): void {
    try {
      fn();
    } catch {
      // registry write failed; the heartbeat goes stale and senders see "not responding"
    }
  }
}

export { SendError };

function truncateUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let out = text.slice(0, maxBytes);
  while (Buffer.byteLength(out, "utf8") > maxBytes - 3) out = out.slice(0, -64);
  return `${out}…`;
}
