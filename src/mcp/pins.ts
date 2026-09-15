import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { resolveHome } from "../config/loader.js";

/**
 * Tool-definition pins for MCP servers (security-spec.md T10, mcp-spec.md §6):
 * at connect, each server's advertised tool definitions (names + descriptions
 * + schemas) are hashed and persisted per server name to
 * `~/.nib/mcp-pins.json` (NIB_HOME honored, mode 0600, atomic
 * tmp+rename — same hygiene as the hooks/skill trust stores). Every later
 * connect compares against the pin: a description/schema change — the "rug
 * pull" — flags the server for re-approval, and the changed tools are not
 * re-registered until the user approves. A first-ever connect pins without
 * prompting (the strictMcpConfig allowlist + startup flow already gates it).
 *
 * Only hashes are stored — never descriptions, schemas, or command text.
 */

export interface McpServerPin {
  /** Per-tool full sha256 of `[name, description, canonicalized schema]`. */
  tools: Record<string, string>;
  pinnedAt: number;
}

export interface McpPinsStore {
  servers: Record<string, McpServerPin>;
}

export interface PinnableTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

function mcpPinsFilePath(): string {
  return `${resolveHome()}/mcp-pins.json`;
}

export function loadMcpPins(): McpPinsStore {
  const path = mcpPinsFilePath();
  if (!existsSync(path)) return { servers: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    if (parsed && typeof parsed === "object" && parsed.servers && typeof parsed.servers === "object") {
      return parsed as McpPinsStore;
    }
    return { servers: {} };
  } catch {
    return { servers: {} };
  }
}

/**
 * Write the pins store: mode 0600, atomic (tmp + rename), and any failure is
 * swallowed with a stderr note — a save failure must never become an
 * unhandled rejection at a turn boundary.
 */
export function saveMcpPins(store: McpPinsStore): void {
  const path = mcpPinsFilePath();
  const dir = dirname(path);
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}`;
    writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
    renameSync(tmp, path);
    chmodSync(path, 0o600);
  } catch (err) {
    process.stderr.write(`nib: failed to write mcp-pins.json: ${(err as Error).message}\n`);
  }
}

/** Recursively sort object keys so semantically identical schemas hash identically (key order is not a def change). */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** Full sha256 of a tool definition: name + description + canonicalized input schema. */
export function mcpToolPinHash(tool: PinnableTool): string {
  return createHash("sha256")
    .update(JSON.stringify([tool.name, tool.description ?? "", canonicalize(tool.inputSchema ?? {})]))
    .digest("hex");
}

/**
 * Compare the current advertised tools against the stored pin for a server.
 * No pin (first-ever connect) → not changed. A tool added/removed/renamed or
 * any description/schema hash difference → changed (the rug-pull signal).
 */
export function mcpPinsChanged(store: McpPinsStore, serverName: string, tools: PinnableTool[]): boolean {
  const pinned = store.servers[serverName];
  if (!pinned) return false;
  const pinnedTools = pinned.tools ?? {};
  if (Object.keys(pinnedTools).length !== tools.length) return true;
  for (const tool of tools) {
    if (pinnedTools[tool.name] !== mcpToolPinHash(tool)) return true;
  }
  return false;
}

/** Persist (or replace) the pin for a server — used on first connect and on approved re-pins. */
export function pinMcpServer(store: McpPinsStore, serverName: string, tools: PinnableTool[]): void {
  const toolsPin: Record<string, string> = {};
  for (const tool of tools) toolsPin[tool.name] = mcpToolPinHash(tool);
  store.servers[serverName] = { tools: toolsPin, pinnedAt: Date.now() };
  saveMcpPins(store);
}
