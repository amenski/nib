/**
 * Native language-server support (LSP): post-edit diagnostics in the agent loop
 * and the read-only `lsp` tool.
 *
 * Layering, bottom-up: framing (bytes ↔ messages) → client (JSON-RPC) →
 * server (one process' lifecycle) → manager (routing, built-ins, strict
 * allowlist). format turns results into model-facing text; the tool and the
 * agent loop are the two consumers.
 */
export { MessageDecoder, encodeMessage, FramingError } from "./framing.js";
export { JsonRpcConnection, DEFAULT_REQUEST_TIMEOUT_MS, type Transport } from "./client.js";
export {
  LspServer,
  MAX_DIAGNOSTICS_PER_FILE,
  DEFAULT_QUIET_MS,
  DEFAULT_MAX_WAIT_MS,
  type LspServerState,
  type SpawnFn,
  type LspServerOptions,
} from "./server.js";
export {
  LspManager,
  ALLOWED_LSP_COMMANDS,
  isLspCommandAllowed,
  lspStrictViolation,
  createSpawnFn,
  resolveLspServers,
  type LspManagerOptions,
  type LspSpawnOptions,
  type LspStatusEntry,
} from "./manager.js";
export { BUILTIN_LSP_SERVERS, detectBuiltinServers, resolveOnPath } from "./defaults.js";
export { METHODS, relPath, locationFromWire, symbolKindName, symbolsFromWire, hoverText, callsFromWire, type LspDiagnostic, type LspLocation, type WireSymbol, type WireCall } from "./protocol.js";
export { formatDiagnostics, formatHover, formatLocations, formatSymbols, formatCallHierarchy, diagnosticsBlock } from "./format.js";
