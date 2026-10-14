import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { resolveHome } from "../config/loader.js";
import { updateSettings } from "../config/settings-writer.js";
import { ALLOWED_MCP_COMMANDS } from "./connector.js";

/**
 * `nib mcp add | list | remove` — manage MCP servers in the global
 * `~/.nib/settings.json` without hand-editing JSON (Claude Code's
 * `claude mcp add` shape). Global only: a project's servers need folder-trust
 * consent anyway, and `sandbox: false` is honoured only from the global file.
 */

export interface McpCommandDeps {
  homeDir?: string;
}

const NAME_RE = /^[A-Za-z0-9_-]+$/;

function usage(): void {
  console.error("Usage: nib mcp <add|list|remove>");
  console.error("  nib mcp add <name> [--env KEY=VALUE]... [--no-sandbox] -- <command> [args...]");
  console.error("  nib mcp list");
  console.error("  nib mcp remove <name>");
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function readServers(homeDir?: string): Record<string, unknown> {
  const path = join(homeDir ?? resolveHome(), "settings.json");
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    return isObject(parsed) && isObject(parsed.mcpServers) ? parsed.mcpServers : {};
  } catch {
    return {};
  }
}

export async function runMcp(argv: string[], deps: McpCommandDeps = {}): Promise<number> {
  const sub = argv[0];
  if (sub === "add") return runAdd(argv.slice(1), deps);
  if (sub === "list") return runList(deps);
  if (sub === "remove") return runRemove(argv.slice(1), deps);
  usage();
  return 1;
}

function runAdd(args: string[], deps: McpCommandDeps): number {
  const sep = args.indexOf("--");
  if (sep === -1 || sep === args.length - 1) {
    console.error("Missing the server command after `--`.");
    usage();
    return 1;
  }
  const [command, ...commandArgs] = args.slice(sep + 1);
  const opts = args.slice(0, sep);

  let name: string | undefined;
  let sandbox = true;
  const env: Record<string, string> = {};
  for (let i = 0; i < opts.length; i++) {
    const a = opts[i];
    if (a === "--no-sandbox") sandbox = false;
    else if (a === "--env" || a === "-e") {
      const pair = opts[++i] ?? "";
      const eq = pair.indexOf("=");
      if (eq <= 0) { console.error(`--env needs KEY=VALUE, got "${pair}"`); return 1; }
      env[pair.slice(0, eq)] = pair.slice(eq + 1);
    }
    else if (a.startsWith("-")) { console.error(`Unknown option: ${a}`); usage(); return 1; }
    else if (name === undefined) name = a;
    else { console.error(`Unexpected argument: ${a}`); usage(); return 1; }
  }

  if (!name) { console.error("Missing the server name."); usage(); return 1; }
  if (!NAME_RE.test(name)) {
    console.error(`Invalid name "${name}": use letters, digits, _ and - only.`);
    return 1;
  }
  if (name in readServers(deps.homeDir)) {
    console.error(`"${name}" already exists. Remove it first: nib mcp remove ${name}`);
    return 1;
  }

  const entry: Record<string, unknown> = { command, args: commandArgs };
  if (Object.keys(env).length > 0) entry.env = env;
  if (!sandbox) entry.sandbox = false;
  updateSettings((config) => {
    const servers = isObject(config.mcpServers) ? config.mcpServers : {};
    servers[name!] = entry;
    config.mcpServers = servers;
  }, deps.homeDir);

  console.log(`Added "${name}" to ~/.nib/settings.json. Restart nib, then run /mcp.`);
  if (!sandbox) {
    console.log(`"${name}" runs outside nib's sandbox: it can read and write anything your user can.`);
  }
  if (!ALLOWED_MCP_COMMANDS.has(basename(command))) {
    console.log(
      `Note: "${basename(command)}" is not on the MCP command allowlist, so it is blocked ` +
      `unless "strictMcpConfig": false is set in ~/.nib/settings.json.`,
    );
  }
  return 0;
}

function runList(deps: McpCommandDeps): number {
  const servers = readServers(deps.homeDir);
  const names = Object.keys(servers);
  if (names.length === 0) {
    console.log("No MCP servers in ~/.nib/settings.json. Add one: nib mcp add <name> -- <command> [args...]");
    return 0;
  }
  for (const name of names) {
    const s = servers[name];
    if (!isObject(s)) continue;
    const args = Array.isArray(s.args) ? s.args.filter((a) => typeof a === "string") : [];
    const line = [s.command, ...args].join(" ");
    console.log(`  ${name}  ${line}${s.sandbox === false ? "  (unsandboxed)" : ""}`);
  }
  return 0;
}

function runRemove(args: string[], deps: McpCommandDeps): number {
  const name = args[0];
  if (!name || args.length > 1) { usage(); return 1; }
  if (!(name in readServers(deps.homeDir))) {
    console.error(`No MCP server named "${name}" in ~/.nib/settings.json.`);
    return 1;
  }
  updateSettings((config) => {
    if (isObject(config.mcpServers)) delete config.mcpServers[name];
  }, deps.homeDir);
  console.log(`Removed "${name}". Restart nib for it to take effect.`);
  return 0;
}
