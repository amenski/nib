import { MCPClient } from "./client.js";
import type { McpSpawnOptions } from "./client.js";
import { registry } from "../tools/index.js";
import type { ToolGroup } from "../tools/types.js";
import type { McpServerConfig } from "../config/loader.js";
import { loadMcpPins, mcpPinsChanged, pinMcpServer } from "./pins.js";
import { wrapUntrusted, sanitizeControlChars } from "../tools/untrusted-content.js";

export type McpServerStatus = "connected" | "failed" | "reconnecting" | "starting";

interface ToolSnapshot {
  name: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpServerStatusEntry {
  name: string;
  status: McpServerStatus;
  toolCount: number;
  /** Present when the server failed to start; naming the reason (e.g. blocked by strictMcpConfig). */
  error?: string;
  /** True when the advertised tool definitions differ from the persisted pin (T10) — re-approve via /mcp. */
  pinChanged?: boolean;
}

/**
 * Commands an MCP server may be launched from when `strictMcpConfig` is enabled.
 * Compared against the basename of `command`, case-sensitively.
 */
const ALLOWED_MCP_COMMANDS = new Set([
  "npx",
  "node",
  "python3",
  "python",
  "uvx",
  "uv",
  "bun",
  "deno",
  "go",
  "java",
]);

function basename(command: string): string {
  const parts = command.split(/[\\/]/);
  return parts[parts.length - 1] || command;
}

const toolSnapshots = new Map<string, ToolSnapshot[]>();
const statusMap = new Map<string, McpServerStatus>();
const errorMap = new Map<string, string>();
const clientsMap = new Map<string, MCPClient>();
const pinChangedMap = new Map<string, boolean>();
let serverConfigsMap = new Map<string, McpServerConfig>();
let strictMcpConfig = false;
let sessionSpawnOptions: McpSpawnOptions | undefined;

export function getServerConfigs(): Record<string, McpServerConfig> {
  return Object.fromEntries(serverConfigsMap);
}

export function getMCPServerStatuses(): McpServerStatusEntry[] {
  const entries: McpServerStatusEntry[] = [];
  for (const [name, status] of statusMap) {
    const tools = toolSnapshots.get(name) ?? [];
    const error = errorMap.get(name);
    entries.push({
      name,
      status,
      toolCount: tools.length,
      ...(error ? { error } : {}),
      ...(pinChangedMap.get(name) ? { pinChanged: true } : {}),
    });
  }
  return entries;
}

export function getMCPServerTools(serverName: string): ToolSnapshot[] {
  return toolSnapshots.get(serverName) ?? [];
}

export async function reconnectMCPServer(
  name: string,
  config: McpServerConfig,
  options?: { approvePinChange?: boolean; spawn?: McpSpawnOptions },
): Promise<void> {
  statusMap.set(name, "reconnecting");
  errorMap.delete(name);

  const staleClient = clientsMap.get(name);
  if (staleClient) {
    staleClient.disconnect();
    clientsMap.delete(name);
  }

  if (strictMcpConfig) {
    const cmd = basename(config.command);
    if (!ALLOWED_MCP_COMMANDS.has(cmd)) {
      const allowed = [...ALLOWED_MCP_COMMANDS].join(", ");
      const msg =
        `blocked by strictMcpConfig: command "${config.command}" ` +
        `(basename "${cmd}") is not in the allowlist {${allowed}}. ` +
        `To allow it, set "strictMcpConfig": false in settings.`;
      statusMap.set(name, "failed");
      errorMap.set(name, msg);
      process.stderr.write(`  [mcp] ${name}: ${msg}\n`);
      return;
    }
  }

  try {
    const client = new MCPClient();
    const spawnOptions = options?.spawn ?? sessionSpawnOptions;
    if (spawnOptions) {
      await client.connect(config.command, config.args || [], config.env, spawnOptions);
    } else {
      await client.connect(config.command, config.args || [], config.env);
    }
    clientsMap.set(name, client);

    const tools = await client.listTools();
    toolSnapshots.set(name, tools.map(t => ({ name: t.name, inputSchema: t.inputSchema as Record<string, unknown> | undefined })));

    // T10 tool-definition pinning: every connect (first-ever or reconnect)
    // compares the advertised defs against the persisted pin. A change is the
    // rug-pull signal — the changed tools are NOT (re)registered until the
    // user approves via /mcp (R → confirmation), which reconnects with
    // approvePinChange to re-pin and register. First-ever connects pin
    // without prompting.
    const pins = loadMcpPins();
    const alreadyPinned = pins.servers[name] !== undefined;
    const pinChanged = mcpPinsChanged(pins, name, tools);
    if (pinChanged && !options?.approvePinChange) {
      pinChangedMap.set(name, true);
      statusMap.set(name, "connected");
      process.stderr.write(
        `  [mcp] ${name}: tool definitions changed since last approval — not re-registered; open /mcp and press R to re-approve\n`,
      );
      return;
    }

    for (const tool of tools) {
      const namespacedName = `mcp__${name}__${tool.name}`;
      registry.register({
        def: {
          name: namespacedName,
          description: tool.description || `MCP tool from ${name}: ${tool.name}`,
          parameters: tool.inputSchema
            ? { type: "object", properties: tool.inputSchema.properties ?? {}, required: tool.inputSchema.required ?? [] }
            : { type: "object", properties: {}, required: [] },
        },
        handler: async (args) => {
          try {
            const result = await client.callTool(tool.name, args);
            const textItems = result.content.filter((c) => c.type === "text");
            const omitted = result.content.length - textItems.length;
            const text = textItems.map((c) => c.text).join("\n");
            // MCP server output is external content — same treatment as
            // web-fetch/web-search/bash (T14 sanitize, T12 wrap). Applies to
            // the isError branch too: `text` there is still server-supplied,
            // not nib's own voice, so it's just as untrusted.
            const sanitized = sanitizeControlChars(text);
            const note = omitted > 0 ? `\n[${omitted} non-text content item(s) omitted]` : "";
            const content = wrapUntrusted(sanitized) + note;
            return result.isError
              ? { content, error: content }
              : { content };
          } catch (err) {
            // nib's own transport-layer error (timeout, disconnect, etc.)
            // — its own voice, so it stays unwrapped.
            return { content: "", error: (err as Error).message };
          }
        },
        groups: ["mcp", name] as ToolGroup[],
      });
    }

    if (pinChanged && options?.approvePinChange) {
      // User approved the changed defs: re-pin them and clear the flag.
      pinMcpServer(pins, name, tools);
      pinChangedMap.delete(name);
    } else if (!alreadyPinned) {
      // First-ever connect: pin without prompting.
      pinMcpServer(pins, name, tools);
    }

    statusMap.set(name, "connected");
  } catch (err) {
    statusMap.set(name, "failed");
    errorMap.set(name, (err as Error).message);
    process.stderr.write(`  [mcp] ${name}: connection failed — ${(err as Error).message}\n`);
  }
}

export async function connectMCPServers(
  servers: Record<string, McpServerConfig>,
  options?: { strictMcpConfig?: boolean; spawn?: McpSpawnOptions },
): Promise<void> {
  // Defaults to true (defense in depth): an MCP server command not in
  // ALLOWED_MCP_COMMANDS is blocked unless the config explicitly opts out
  // with `"strictMcpConfig": false`. Previously defaulted to false, which
  // left the allowlist off for anyone who never set the flag.
  strictMcpConfig = options?.strictMcpConfig ?? true;
  // Store the session policy because UI reconnects intentionally pass only
  // approvePinChange; a reconnect must never silently lose containment.
  sessionSpawnOptions = options?.spawn;
  for (const [name, config] of Object.entries(servers)) {
    serverConfigsMap.set(name, config);
    statusMap.set(name, "starting");
    await reconnectMCPServer(name, config, { spawn: options?.spawn });
  }
}

export function disconnectAllMCPServers(): void {
  for (const client of clientsMap.values()) {
    client.disconnect();
  }
  clientsMap.clear();
  sessionSpawnOptions = undefined;
}
