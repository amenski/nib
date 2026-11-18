import { randomBytes } from "node:crypto";
import { loadConfig } from "../config/loader.js";
import { formatPeersTable } from "./format.js";
import { sendMessage, SendError, type DeliveryMode, type ReplyStatus } from "./inbox.js";
import { peersSupported } from "./paths.js";
import { listLivePeers } from "./registry.js";
import { PeerService } from "./service.js";

/** `nib peers` and `nib send` (docs/cross-session-inbox.md §6.3). */

const USAGE = "Usage: nib send <to> <message...|-> [--mode queue|steer|notify] [--wait <seconds>]";
const MODES: readonly string[] = ["queue", "steer", "notify"];
const REFUSED_REPLIES: readonly ReplyStatus[] = ["declined", "hop_limit", "unsupported_version"];

export async function runPeersCommand(argv: string[]): Promise<number> {
  if (argv.length > 0) {
    console.error("Usage: nib peers");
    return 1;
  }
  if (!peersSupported()) {
    console.error("messaging is not supported on this platform");
    return 1;
  }
  process.stdout.write(`${formatPeersTable(listLivePeers()).join("\n")}\n`);
  return 0;
}

export async function runSendCommand(argv: string[]): Promise<number> {
  let mode: DeliveryMode | undefined;
  let waitSeconds: number | undefined;
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") positional.push(...argv.slice(i + 1)), (i = argv.length);
    else if (a === "--mode") {
      const v = argv[++i] ?? "";
      if (!MODES.includes(v)) return fail(`--mode must be one of: ${MODES.join(", ")}`);
      mode = v as DeliveryMode;
    } else if (a === "--wait") {
      const v = argv[++i] ?? "";
      waitSeconds = /^\d+$/.test(v) ? Number(v) : NaN;
      if (!(waitSeconds >= 1 && waitSeconds <= 300)) return fail("--wait must be a whole number of seconds from 1 to 300");
    } else if (a.startsWith("--")) return fail(`Unknown option: ${a}`, true);
    else positional.push(a);
  }

  const [to, ...rest] = positional;
  if (!to || rest.length === 0) {
    console.error(USAGE);
    return 1;
  }
  if (waitSeconds !== undefined && mode === "notify") return fail("--wait cannot be combined with --mode notify (notify never gets a reply)");
  if (!peersSupported()) return fail("messaging is not supported on this platform");
  if (loadConfig().config.messaging?.enabled === false) return fail("messaging is disabled in settings");

  const body = rest.length === 1 && rest[0] === "-" ? (await readStdin()).replace(/\r?\n$/, "") : rest.join(" ");
  if (body.length === 0) return fail("empty message", true);

  if (waitSeconds === undefined) {
    try {
      const { messageId, target } = sendMessage({ to, body, mode, from: { type: "external", label: "cli", pid: process.pid, ppid: process.ppid } });
      process.stdout.write(`delivered ${messageId} to ${target.name} (${target.sessionId})\n`);
      return 0;
    } catch (err) {
      return sendFailure(err);
    }
  }

  const service = PeerService.start({
    sessionId: `cli-${randomBytes(8).toString("hex")}`,
    cwd: process.cwd(),
    kind: "external",
    receive: "never",
    label: "cli",
    onNotice: (text) => console.error(text),
  });
  if (!service) return fail("cannot receive a reply: messaging unavailable here");
  try {
    const { messageId, target } = service.send({ to, body, mode, wantReply: true });
    const result = await service.waitForReply(messageId, target.sessionId, waitSeconds * 1000);
    switch (result.kind) {
      case "reply": {
        const status = result.msg.status ?? "ok";
        if (result.msg.body) process.stdout.write(result.msg.body.endsWith("\n") ? result.msg.body : `${result.msg.body}\n`);
        if (status === "ok") return 0;
        console.error(`${target.name} replied with status ${status}`);
        return REFUSED_REPLIES.includes(status) ? 3 : 1;
      }
      case "timeout":
        console.error(`no reply within ${waitSeconds}s`);
        return 4;
      case "receiver_exited":
        console.error(`${target.name} exited before replying`);
        return 2;
      case "aborted":
        console.error("wait aborted");
        return 1;
    }
  } catch (err) {
    return sendFailure(err);
  } finally {
    service.close();
  }
}

function fail(message: string, withUsage = false): number {
  console.error(message);
  if (withUsage) console.error(USAGE);
  return 1;
}

function sendFailure(err: unknown): number {
  if (!(err instanceof SendError)) return fail((err as Error).message);
  console.error(err.message);
  switch (err.code) {
    case "not_found":
    case "not_running":
    case "not_responding":
      return 2;
    case "refused":
    case "inbox_full":
      return 3;
    default:
      return 1;
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}
