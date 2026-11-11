import { pathToFileURL } from "node:url";
import { loadConfig } from "../config/loader.js";
import { checkFolderTrust, buildFolderContentSummary } from "../config/folder-trust.js";
import { LspManager, createSpawnFn, resolveLspServers } from "./index.js";
import { METHODS, symbolsFromWire } from "./protocol.js";
import type { WireSymbol } from "./protocol.js";
import type { DocumentSymbolSource, RepoMapOptions } from "../repomap/index.js";
import { LSP_EXTENSIONS } from "../repomap/index.js";

/**
 * Total time the startup repo map may spend on language servers. The map is
 * built before the prompt appears, files are queried one by one, and a cold
 * server (jdtls importing Gradle, the Dart analyzer after `pub get`) can take
 * minutes — so past this budget the map goes partial rather than block boot.
 */
export const REPOMAP_LSP_BUDGET_MS = 3_000;

/**
 * Bounds every call through `source` by ONE deadline shared across all calls.
 * A call still running at the deadline resolves to `[]`; calls after it return
 * `[]` without touching the server.
 */
export function withSharedDeadline(source: DocumentSymbolSource, budgetMs: number): DocumentSymbolSource {
  const deadline = Date.now() + budgetMs;
  return async (path) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<WireSymbol[]>((resolve) => {
      timer = setTimeout(() => resolve([]), remaining);
    });
    // The abandoned call rejects later when the servers are shut down.
    const work = source(path).catch(() => [] as WireSymbol[]);
    try {
      return await Promise.race([work, expired]);
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * Bridges the LSP manager into the repo map (docs/todo.md D8): a workspace
 * with a configured language server for a non-TS/JS language gets its symbols
 * through `textDocument/documentSymbol`, so Python/Go/Rust/… repos get a map
 * too. Never throws — the caller treats any failure as "no LSP options" and
 * falls back to the plain TS/JS map. The caller must call `shutdown` once the
 * map is built: the servers started here serve the map only.
 */
export async function repoMapOptionsFromLsp(
  workingDir: string,
): Promise<{ options: RepoMapOptions; shutdown: () => Promise<void> } | undefined> {
  const { config } = loadConfig(workingDir);
  const folderTrusted =
    checkFolderTrust(workingDir, buildFolderContentSummary(workingDir, { config } as never)).status === "trusted";
  const servers = resolveLspServers(config, workingDir, folderTrusted);
  if (Object.keys(servers).length === 0) return undefined;

  const manager = new LspManager({
    rootDir: workingDir,
    servers,
    strict: config.strictMcpConfig,
    spawn: createSpawnFn({ cwd: workingDir, trustedRoot: workingDir }),
  });

  // The map only serves languages the TS parser cannot read; a server whose
  // extensions are all TS/JS adds nothing here.
  const coversLspLanguage = LSP_EXTENSIONS.some((ext) => manager.serverNameFor(`x${ext}`) !== undefined);
  if (!coversLspLanguage) return undefined;

  const documentSymbols: DocumentSymbolSource = async (path: string): Promise<WireSymbol[]> => {
    const server = manager.serverFor(path);
    if (!server) return [];
    await server.syncFile(path);
    const raw = await server.request<unknown>(
      METHODS.documentSymbol,
      { textDocument: { uri: pathToFileURL(path).toString() } },
      10_000,
    );
    return symbolsFromWire(raw, path);
  };

  return {
    options: {
      extraExtensions: LSP_EXTENSIONS,
      documentSymbols: withSharedDeadline(documentSymbols, REPOMAP_LSP_BUDGET_MS),
    },
    shutdown: () => manager.shutdownAll(),
  };
}
