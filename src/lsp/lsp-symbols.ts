import { pathToFileURL } from "node:url";
import { loadConfig } from "../config/loader.js";
import { checkFolderTrust, buildFolderContentSummary } from "../config/folder-trust.js";
import { LspManager, createSpawnFn, resolveLspServers } from "./index.js";
import { METHODS, symbolsFromWire } from "./protocol.js";
import type { WireSymbol } from "./protocol.js";
import type { DocumentSymbolSource, RepoMapOptions } from "../repomap/index.js";
import { LSP_EXTENSIONS } from "../repomap/index.js";

/**
 * Bridges the LSP manager into the repo map (docs/todo.md D8): a workspace
 * with a configured language server for a non-TS/JS language gets its symbols
 * through `textDocument/documentSymbol`, so Python/Go/Rust/… repos get a map
 * too. Never throws — the caller treats any failure as "no LSP options" and
 * falls back to the plain TS/JS map.
 */
export async function repoMapOptionsFromLsp(workingDir: string): Promise<RepoMapOptions | undefined> {
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

  return { extraExtensions: LSP_EXTENSIONS, documentSymbols };
}
