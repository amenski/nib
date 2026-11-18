import { wrapPeerMessage } from "../tools/untrusted-content.js";
import { fromLabel, type PeerFrom, type PeerMessage } from "./inbox.js";
import type { PeerRecord } from "./registry.js";

/** What the model receives for a peer message, and how the TUI shows it (cross-session-inbox.md §5.4). */

const HEADER_RE = /^\[Inter-session (message|reply) · /;

function sender(from: PeerFrom): string {
  return from.type === "session"
    ? `from ${from.name} (session ${from.sessionId}, claimed)`
    : `from ${from.label} (external pid ${from.pid}, claimed)`;
}

/**
 * The user-role text a peer message becomes. The header is ours; the body is
 * fenced. Auto mode and replay recognise it by the header (isPeerMessage).
 */
export function formatPeerPayload(msg: PeerMessage): string {
  if (msg.kind === "reply") {
    return [
      `[Inter-session reply · ${sender(msg.from)} · status=${msg.status ?? "ok"} · in reply to ${msg.inReplyTo} · isUser=false]`,
      wrapPeerMessage(msg.body),
    ].join("\n");
  }
  const lines = [
    `[Inter-session message · ${sender(msg.from)} · mode=${msg.mode} · isUser=false]`,
    wrapPeerMessage(msg.body),
  ];
  if (msg.wantReply) lines.push("Reply expected: your final answer this turn is sent back to the sender.");
  return lines.join("\n");
}

/** A user-role message no human typed: auto mode must not count it as the user's words. */
export function isPeerMessage(text: string): boolean {
  return HEADER_RE.test(text);
}

/** One scrollback line: `✉ web-8a7b (queue): first line…`. */
export function peerEchoText(msg: PeerMessage, max = 120): string {
  const first = msg.body.split("\n", 1)[0] ?? "";
  const clipped = first.length > max ? `${first.slice(0, max - 1)}…` : first;
  const tag = msg.kind === "reply" ? `reply ${msg.status ?? "ok"}` : msg.mode;
  return `✉ ${fromLabel(msg.from)} (${tag}): ${clipped}`;
}

/** Scrollback line for a persisted peer payload on resume (sender + mode from the header). */
export function peerEchoFromPayload(text: string): string | null {
  const header = text.split("\n", 1)[0] ?? "";
  const m = /^\[Inter-session (message|reply) · from (\S+) .*?· (mode=\w+|status=\w+)/.exec(header);
  if (!m) return null;
  const bodyStart = text.indexOf("\n", text.indexOf("--- BEGIN PEER MESSAGE"));
  const body = bodyStart === -1 ? "" : (text.slice(bodyStart + 1).split("\n", 1)[0] ?? "");
  const tag = m[3].replace(/^mode=/, "").replace(/^status=/, "reply ");
  return `✉ ${m[2]} (${tag}): ${body.length > 120 ? `${body.slice(0, 119)}…` : body}`;
}

/** Table for `/peers` and `nib peers`. */
export function formatPeersTable(peers: readonly PeerRecord[], now = Date.now()): string[] {
  if (peers.length === 0) return ["No other live sessions."];
  const rows = peers.map((p) => [p.name, p.sessionId, p.kind === "external" ? "external" : p.status, p.receive, age(now - p.startedAt), p.cwd]);
  const head = ["NAME", "SESSION", "STATUS", "RECEIVE", "AGE", "CWD"];
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cells: string[]) => cells.map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i]))).join("  ");
  return [line(head), ...rows.map(line)];
}

function age(ms: number): string {
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h` : `${Math.floor(h / 24)}d`;
}
