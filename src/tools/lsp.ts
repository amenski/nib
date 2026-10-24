import { isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { ToolOutput, ToolDef } from "../types.js";
import type { ToolHandler, ToolContext } from "./types.js";
import { ToolRegistry } from "./registry.js";
import { wrapUntrusted, sanitizeControlChars } from "./untrusted-content.js";
import {
  METHODS,
  formatCallHierarchy,
  formatHover,
  formatLocations,
  formatSymbols,
  callsFromWire,
  hoverText,
  locationFromWire,
  symbolsFromWire,
  type LspLocation,
} from "../lsp/index.js";

/** Same bound as an MCP tool call — a navigation query is not the slow part of a turn. */
const TIMEOUT_MS = 10_000;
/** Matches the search tool's cap: one symbol in a huge file can be hundreds of lines. */
const MAX_LINES = 50;
const MAX_LINE_CHARS = 500;

const OPERATIONS = [
  "goToDefinition",
  "findReferences",
  "hover",
  "documentSymbol",
  "goToImplementation",
  "workspaceSymbol",
  "prepareCallHierarchy",
  "incomingCalls",
  "outgoingCalls",
] as const;

type Operation = (typeof OPERATIONS)[number];

/**
 * Read-only: every call needs a path inside the workspace. `writeRoots` are
 * accepted too, because they are directories the session was explicitly
 * granted — reading a symbol in an `--add-dir` tree is the same trust class as
 * reading the file there.
 */
function insideWorkspace(path: string, ctx: ToolContext): boolean {
  const root = resolve(ctx.workingDir);
  const target = resolve(ctx.workingDir, path);
  if (isWithin(root, target)) return true;
  for (const extra of ctx.writeRoots ?? []) {
    if (isWithin(resolve(extra), target)) return true;
  }
  return false;
}

function isWithin(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** 1-based (the model's convention) → 0-based (the wire's). */
function position(args: Record<string, unknown>): { line: number; character: number } {
  const line = typeof args.line === "number" && args.line >= 1 ? Math.floor(args.line) - 1 : 0;
  const character =
    typeof args.character === "number" && args.character >= 1 ? Math.floor(args.character) - 1 : 0;
  return { line, character };
}

function capLines(text: string): string {
  return text
    .split("\n")
    .slice(0, MAX_LINES)
    .map((line) => (line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…[truncated]` : line))
    .join("\n");
}

/**
 * The read-only `lsp` tool: Claude Code's schema (nine operations over
 * `filePath`/`line`/`character`/`query`).
 *
 * Every response is server-supplied text — a compiler's hover markdown, symbol
 * names from the file — so it is sanitized and wrapped as untrusted content on
 * the way out, exactly like MCP tool output. nib's own refusals (no server, out
 * of workspace) stay unwrapped: those are its own voice.
 */
const lspHandler: ToolHandler = async (args, ctx) => {
  const operation = args.operation as Operation;
  const rawPath = args.filePath;
  if (typeof rawPath !== "string" || rawPath === "") {
    return { content: "Error: filePath is required", error: "filePath is required" };
  }
  if (!OPERATIONS.includes(operation)) {
    return {
      content: `Error: unknown operation "${String(operation)}"`,
      error: `unknown operation "${String(operation)}"`,
    };
  }
  if (!insideWorkspace(rawPath, ctx)) {
    return {
      content: "PERMISSION_DENIED: lsp only reads files inside the workspace",
      error: "PERMISSION_DENIED: lsp only reads files inside the workspace",
    };
  }

  const manager = ctx.lsp;
  const filePath = resolve(ctx.workingDir, rawPath);
  if (!manager) {
    const ext = /(\.[^.\\/]+)$/.exec(filePath)?.[1] ?? "this file type";
    return {
      content: `No language server configured for ${ext} (lspServers in settings)`,
      error: `No language server configured for ${ext}`,
    };
  }
  const server = manager.serverFor(filePath);
  if (!server) {
    const ext = /(\.[^.\\/]+)$/.exec(filePath)?.[1] ?? "this file type";
    return {
      content: `No language server configured for ${ext} (lspServers in settings)`,
      error: `No language server configured for ${ext}`,
    };
  }

  try {
    // The file on disk is the source of truth for a read-only query, so sync
    // first — a stale buffer would answer about code that is no longer there.
    await server.syncFile(filePath);
    const uri = pathToFileURL(filePath).toString();
    const pos = position(args);
    const textDocument = { uri };

    let body: string;

    switch (operation) {
      case "goToDefinition":
      case "goToImplementation": {
        const method = operation === "goToDefinition" ? METHODS.definition : METHODS.implementation;
        const raw = await server.request<unknown>(method, { textDocument, position: pos }, TIMEOUT_MS);
        body = formatLocations(locationsFromWire(raw), ctx.workingDir);
        break;
      }
      case "findReferences": {
        const raw = await server.request<unknown[]>(METHODS.references, {
          textDocument,
          position: pos,
          context: { includeDeclaration: true },
        }, TIMEOUT_MS);
        body = formatLocations(locationsFromWire(raw), ctx.workingDir);
        break;
      }
      case "hover": {
        const raw = await server.request<unknown>(METHODS.hover, { textDocument, position: pos }, TIMEOUT_MS);
        body = formatHover({ contents: hoverText(raw) } as { contents: string });
        break;
      }
      case "documentSymbol": {
        const raw = await server.request<unknown>(METHODS.documentSymbol, { textDocument }, TIMEOUT_MS);
        body = formatSymbols(symbolsFromWire(raw, filePath), ctx.workingDir);
        break;
      }
      case "workspaceSymbol": {
        const query = typeof args.query === "string" ? args.query : "";
        if (query === "") {
          return { content: "Error: query is required for workspaceSymbol", error: "query is required for workspaceSymbol" };
        }
        const raw = await server.request<unknown>(METHODS.workspaceSymbol, { query }, TIMEOUT_MS);
        body = formatSymbols(symbolsFromWire(raw, filePath), ctx.workingDir);
        break;
      }
      case "prepareCallHierarchy": {
        const raw = await server.request<unknown>(METHODS.prepareCallHierarchy, { textDocument, position: pos }, TIMEOUT_MS);
        const item = Array.isArray(raw) ? raw[0] : undefined;
        const located = item ? locationFromWire(item) : undefined;
        body = located
          ? formatLocations([located], ctx.workingDir)
          : "";
        break;
      }
      case "incomingCalls":
      case "outgoingCalls": {
        // Both need the prepared item, per the spec.
        const prepared = await server.request<unknown>(METHODS.prepareCallHierarchy, { textDocument, position: pos }, TIMEOUT_MS);
        const item = Array.isArray(prepared) ? prepared[0] : undefined;
        if (!item) {
          body = "";
          break;
        }
        const method = operation === "incomingCalls" ? METHODS.incomingCalls : METHODS.outgoingCalls;
        const raw = await server.request<unknown[]>(method, { item }, TIMEOUT_MS);
        body = formatCallHierarchy(callsFromWire(raw), ctx.workingDir);
        break;
      }
    }

    if (body.trim() === "") return { content: "No results" };
    return { content: wrapUntrusted(sanitizeControlChars(capLines(body))) };
  } catch (err) {
    // Transport/config failures are nib's own voice (same rule as MCP).
    return { content: "", error: (err as Error).message };
  }
};

/** Both Location[] and LocationLink[] arrive here; the second is LSP3-only. */
function locationsFromWire(raw: unknown): LspLocation[] {
  if (!Array.isArray(raw)) {
    const single = locationFromWire(raw);
    return single ? [single] : [];
  }
  return raw.map(locationFromWire).filter((l): l is LspLocation => l !== undefined);
}

const lspDef: ToolDef = {
  name: "lsp",
  description:
    "Query a language server for code intelligence: definitions, references, hover types, document/workspace symbols, implementations, and call hierarchies. Read-only, inside the workspace. Prefer this over grep for symbol lookups.",
  parameters: {
    type: "object",
    properties: {
      operation: {
        type: "string",
        enum: [...OPERATIONS],
        description: "Which query to run. goToDefinition/findReferences/hover/goToImplementation/prepareCallHierarchy/incomingCalls/outgoingCalls need line+character; documentSymbol needs only the file; workspaceSymbol needs query.",
      },
      filePath: { type: "string", description: "Path to the file (absolute, or relative to the workspace)" },
      line: { type: "integer", description: "1-based line number of the symbol" },
      character: { type: "integer", description: "1-based column number of the symbol" },
      query: { type: "string", description: "Search query for workspaceSymbol" },
    },
    required: ["operation", "filePath"],
  },
};

export function registerLsp(registry: ToolRegistry): void {
  registry.register({ def: lspDef, handler: lspHandler, groups: ["read"] });
}
