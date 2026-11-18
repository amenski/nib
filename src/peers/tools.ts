import type { ToolDef } from "../types.js";
import type { ToolHandler } from "../tools/types.js";
import type { ToolRegistry } from "../tools/registry.js";
import { SendError, type DeliveryMode } from "./inbox.js";
import { formatPeerPayload, formatPeersTable } from "./format.js";
import type { PeerService } from "./service.js";

/** `list_sessions` / `send_message` (docs/cross-session-inbox.md §6.2). */

const MAX_WAIT_SECONDS = 300;
const UNAVAILABLE = { content: "Inter-session messaging is not available in this session.", error: "unavailable" };

const listSessionsDef: ToolDef = {
  name: "list_sessions",
  description:
    "List other live nib sessions on this machine that can receive inter-session messages: name, session id, " +
    "status (idle/busy), receive policy, age and working directory. Use the session id with send_message.",
  parameters: {
    type: "object",
    properties: {
      cwdPrefix: { type: "string", description: "Only sessions whose working directory starts with this path." },
    },
    required: [],
  },
};

const sendMessageDef: ToolDef = {
  name: "send_message",
  description:
    "Send a message to another live nib session (see list_sessions). The receiver's agent treats it as a request " +
    "from another agent, not a command from its user, and runs it under its own permissions. Include all the " +
    "context the receiver needs — it cannot see this conversation. Prefer the session id over the name.\n" +
    "mode: 'queue' (default) runs as its own turn when the receiver is free; 'steer' joins the receiver's running " +
    "turn; 'notify' adds context to the receiver's next turn without starting one (no reply).\n" +
    "wantReply: the receiver's final answer for that turn is sent back. waitSeconds (0-300): wait for that reply " +
    "and return it here; without waiting, the reply arrives later as a separate message.",
  parameters: {
    type: "object",
    properties: {
      to: { type: "string", description: "Target session id (preferred), unique id prefix, or name." },
      message: { type: "string", description: "The request, with all needed context. Max 16 KiB." },
      mode: { type: "string", enum: ["queue", "steer", "notify"], description: "Delivery mode. Default queue." },
      wantReply: { type: "boolean", description: "Ask for the receiver's final answer. Default false." },
      waitSeconds: { type: "number", description: "Seconds to wait for the reply (0-300). Implies wantReply. Default 0." },
    },
    required: ["to", "message"],
  },
};

export function createListSessionsHandler(getPeers: () => PeerService | null): ToolHandler {
  return async (args) => {
    const peers = getPeers();
    if (!peers) return UNAVAILABLE;
    const prefix = typeof args.cwdPrefix === "string" ? args.cwdPrefix : "";
    const live = peers.peers().filter((p) => p.cwd.startsWith(prefix));
    return { content: [`This session: ${peers.name} (${peers.sessionId})`, "", ...formatPeersTable(live)].join("\n") };
  };
}

export function createSendMessageHandler(getPeers: () => PeerService | null): ToolHandler {
  return async (args, ctx) => {
    const peers = getPeers();
    if (!peers) return UNAVAILABLE;
    const to = typeof args.to === "string" ? args.to.trim() : "";
    const message = typeof args.message === "string" ? args.message : "";
    if (!to || !message.trim()) return { content: "Error: `to` and `message` are required.", error: "invalid_args" };
    const mode = (["queue", "steer", "notify"] as const).find((m) => m === args.mode) ?? "queue";
    if (args.mode !== undefined && args.mode !== mode) {
      return { content: `Error: mode must be queue, steer or notify (got ${JSON.stringify(args.mode)}).`, error: "invalid_args" };
    }
    const waitSeconds = typeof args.waitSeconds === "number" ? Math.min(Math.max(Math.floor(args.waitSeconds), 0), MAX_WAIT_SECONDS) : 0;
    if (waitSeconds > 0 && mode === "notify") {
      return { content: "Error: notify messages never get a reply, so waitSeconds can't be used with them.", error: "invalid_args" };
    }
    const wantReply = mode !== "notify" && (waitSeconds > 0 || args.wantReply === true);

    let sent;
    try {
      sent = peers.send({ to, body: message, mode: mode as DeliveryMode, wantReply });
    } catch (err) {
      if (err instanceof SendError) return { content: `Error: ${err.message}`, error: err.code };
      throw err;
    }
    const target = `${sent.target.name} (${sent.target.sessionId})`;
    if (waitSeconds === 0) {
      const later = wantReply ? " The reply will arrive later as a separate message." : "";
      return { content: `Delivered to ${target}'s inbox (message ${sent.messageId}). Delivered means queued, not yet read.${later}` };
    }

    const result = await peers.waitForReply(sent.messageId, sent.target.sessionId, waitSeconds * 1000, ctx.signal);
    switch (result.kind) {
      case "reply":
        // The reply body is the other agent's output: fenced, like the request was on its side.
        return { content: formatPeerPayload(result.msg) };
      case "timeout":
        return { content: `Delivered to ${target} (message ${sent.messageId}), but no reply within ${waitSeconds}s. A late reply will arrive as a separate message.` };
      case "receiver_exited":
        return { content: `Error: ${target} exited before replying (message ${sent.messageId}).`, error: "receiver_exited" };
      case "aborted":
        return { content: `Stopped waiting for ${target}'s reply (message ${sent.messageId}). A late reply will arrive as a separate message.`, error: "aborted" };
    }
  };
}

/** Group `workflow`: present in code and orchestrator modes, absent from read-only ones. */
export function registerPeerTools(registry: ToolRegistry, getPeers: () => PeerService | null): void {
  registry.register({ def: listSessionsDef, handler: createListSessionsHandler(getPeers), groups: ["workflow"] });
  registry.register({ def: sendMessageDef, handler: createSendMessageHandler(getPeers), groups: ["workflow"] });
}
