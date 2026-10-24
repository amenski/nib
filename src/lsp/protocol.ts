import { fileURLToPath } from "node:url";
import type { LspServerConfig } from "../config/loader.js";

/**
 * LSP 3.17, but only what nib's diagnostics path and the `lsp` tool actually
 * use — the request/notification names are the spec's, spelled once here so no
 * module invents a string literal.
 */

/** Protocol version advertised in `initialize`. */
export const LSP_PROTOCOL_VERSION = "3.17.0";

export const METHODS = {
  initialize: "initialize",
  initialized: "initialized",
  shutdown: "shutdown",
  exit: "exit",
  didOpen: "textDocument/didOpen",
  didChange: "textDocument/didChange",
  didClose: "textDocument/didClose",
  didChangeConfiguration: "workspace/didChangeConfiguration",
  publishDiagnostics: "textDocument/publishDiagnostics",
  definition: "textDocument/definition",
  references: "textDocument/references",
  hover: "textDocument/hover",
  documentSymbol: "textDocument/documentSymbol",
  implementation: "textDocument/implementation",
  prepareCallHierarchy: "textDocument/prepareCallHierarchy",
  incomingCalls: "callHierarchy/incomingCalls",
  outgoingCalls: "callHierarchy/outgoingCalls",
  workspaceSymbol: "workspace/symbol",
  workspaceConfiguration: "workspace/configuration",
  workDoneProgressCreate: "window/workDoneProgress/create",
  registerCapability: "client/registerCapability",
  showMessageRequest: "window/showMessageRequest",
} as const;

/** `$/progress` is a protocol notification with a `$`-prefixed name. */
export const PROGRESS_NOTIFICATION = "$/progress";

/**
 * Diagnostic severity, per the spec's integer enum. Only Error and Warning
 * reach the model: Information/Hint on a fresh file is mostly linter noise, and
 * the post-edit block competes with the model's own next thought.
 */
export const SEVERITY_ERROR = 1;
export const SEVERITY_WARNING = 2;

export interface Position {
  /** 0-based, per the spec. Every user/model-facing string is 1-based. */
  line: number;
  character: number;
}

export interface Range {
  start: Position;
  end: Position;
}

export interface LspDiagnostic {
  path: string;
  /** 1-based, already converted from the wire's 0-based Position. */
  line: number;
  character: number;
  severity: 1 | 2 | 3 | 4;
  message: string;
  code?: string | number;
}

/** A resolved location, for definition/references/implementation. */
export interface LspLocation {
  path: string;
  line: number;
  character: number;
}

export interface InitializeParams {
  processId: number | null;
  clientInfo: { name: string; version: string };
  rootUri: string | null;
  workspaceFolders: Array<{ uri: string; name: string }> | null;
  capabilities: Record<string, unknown>;
  initializationOptions?: unknown;
}

export interface InitializeResult {
  capabilities: Record<string, unknown>;
  serverInfo?: { name?: string; version?: string };
}

/**
 * What nib tells the server it can do. Deliberately minimal: nib accepts
 * pushed diagnostics, does not want snippets/formatting/workspace-edit
 * extensions, and every capability claimed here is one a server is allowed to
 * depend on. Claiming more than the client implements makes servers send
 * requests nib has to answer with `-32601`.
 */
export const CLIENT_CAPABILITIES: Record<string, unknown> = {
  textDocument: {
    synchronization: { dynamicRegistration: false, didSave: false, willSave: false },
    publishDiagnostics: { relatedInformation: false, versionSupport: true },
    hover: { contentFormat: ["plaintext", "markdown"] },
    definition: { linkSupport: false },
    references: {},
    documentSymbol: { hierarchicalDocumentSymbolSupport: true },
    implementation: { linkSupport: false },
    callHierarchy: { dynamicRegistration: false },
  },
  workspace: { symbol: {}, workspaceFolders: true, configuration: true },
  window: { workDoneProgress: true },
};

/** What the client-side defaults need from the config entry, resolved once. */
export interface ResolvedLspServerConfig extends LspServerConfig {
  name: string;
}

export function relPath(rootDir: string, absolutePath: string): string {
  if (!absolutePath.startsWith(rootDir)) return absolutePath;
  return absolutePath.slice(rootDir.length).replace(/^[\\/]/, "");
}

/** Converts a wire `Location`/`LocationLink` into nib's 1-based location. */
export function locationFromWire(raw: unknown): LspLocation | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const loc = raw as Record<string, unknown>;
  // LocationLink uses targetUri/targetSelectionRange; Location uses uri/range.
  const uri = (loc.uri ?? loc.targetUri) as string | undefined;
  const range = (loc.range ?? loc.targetSelectionRange) as Range | undefined;
  if (!uri || !range?.start) return undefined;
  let path: string;
  try {
    path = fileURLToPath(uri);
  } catch {
    return undefined;
  }
  return { path, line: range.start.line + 1, character: range.start.character + 1 };
}

/** The spec's SymbolKind integers, as the words the model recognises. */
const SYMBOL_KINDS: Record<number, string> = {
  1: "file", 2: "module", 3: "namespace", 4: "package", 5: "class",
  6: "method", 7: "property", 8: "field", 9: "constructor", 10: "enum",
  11: "interface", 12: "function", 13: "variable", 14: "constant",
  15: "string", 16: "number", 17: "boolean", 18: "array", 19: "object",
  20: "key", 21: "null", 22: "enumMember", 23: "struct", 24: "event",
  25: "operator", 26: "typeParameter",
};

export function symbolKindName(kind: unknown): string {
  return typeof kind === "number" ? SYMBOL_KINDS[kind] ?? "symbol" : "symbol";
}

export interface WireSymbol {
  name: string;
  kind: string;
  path: string;
  line: number;
}

/**
 * Flattens a `documentSymbol` result. The spec allows two shapes:
 * `DocumentSymbol[]` (hierarchical, optional `selectionRange`) and
 * `SymbolInformation[]` (flat, only when the client did not claim hierarchical
 * support). nib claims hierarchical support, but a server may still answer
 * either, so both are handled.
 */
export function symbolsFromWire(raw: unknown, fallbackPath: string): WireSymbol[] {
  if (!Array.isArray(raw)) return [];
  const out: WireSymbol[] = [];
  const visit = (node: unknown, depth: number): void => {
    if (typeof node !== "object" || node === null) return;
    const s = node as Record<string, unknown>;
    if (typeof s.name !== "string") return;
    let range = (s.selectionRange ?? s.range) as Range | undefined;
    let path = fallbackPath;
    if (typeof s.location === "object" && s.location !== null) {
      // SymbolInformation carries its own location (and its range lives there).
      const located = locationFromWire(s.location);
      if (located) path = located.path;
      range ??= (s.location as { range?: Range }).range;
    }
    if (range?.start === undefined) return;
    out.push({
      name: s.name,
      kind: symbolKindName(s.kind),
      path,
      // Indented names make the tree readable without a nested type.
      line: range.start.line + 1,
    });
    if (Array.isArray(s.children)) for (const child of s.children) visit(child, depth + 1);
  };
  for (const node of raw) visit(node, 0);
  return out;
}

/** Flattens a `textDocument/hover` result to plain text. */
export function hoverText(raw: unknown): string {
  if (typeof raw !== "object" || raw === null) return "";
  const contents = (raw as Record<string, unknown>).contents;
  if (typeof contents === "string") return contents;
  if (Array.isArray(contents)) {
    return contents
      .map((c) => (typeof c === "string" ? c : typeof c === "object" && c !== null ? String((c as any).value ?? "") : ""))
      .filter((s) => s !== "")
      .join("\n");
  }
  if (typeof contents === "object" && contents !== null) return String((contents as any).value ?? "");
  return "";
}

export interface WireCall {
  name: string;
  from: string;
  path: string;
  line: number;
}

/** Flattens `callHierarchy/incomingCalls` or `outgoingCalls`. */
export function callsFromWire(raw: unknown): WireCall[] {
  if (!Array.isArray(raw)) return [];
  const out: WireCall[] = [];
  for (const node of raw) {
    if (typeof node !== "object" || node === null) continue;
    const call = node as Record<string, unknown>;
    // incomingCalls uses `from`, outgoingCalls uses `to`.
    const other = (call.from ?? call.to) as Record<string, unknown> | undefined;
    if (!other || typeof other.name !== "string") continue;
    const located = locationFromWire(other);
    out.push({
      name: other.name,
      from: typeof other.from === "string" ? other.from : String((call as any).from?.name ?? other.name),
      path: located?.path ?? "",
      line: located?.line ?? 0,
    });
  }
  return out;
}
