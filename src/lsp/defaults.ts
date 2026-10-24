import { accessSync, constants, existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { LspServerConfig } from "../config/loader.js";

/**
 * A built-in zero-config server.
 *
 * The `command` and `args` here MUST stay hardcoded literals. The repository
 * decides only WHETHER a server runs (its `marker` file exists, and the binary
 * resolves on PATH); it never decides WHAT runs. Same rule, and the same
 * injection reasoning, as detectLinter in src/diagnostics/index.ts: a project
 * file is untrusted input, and cloning a repo must not be able to choose a
 * spawned executable.
 */
export interface BuiltinLspServer {
  /** File whose presence in the working directory signals "this project uses it". */
  marker: string;
  /** Literal command, resolved on PATH. */
  command: string;
  args: string[];
  extensionToLanguage: Record<string, string>;
}

export const BUILTIN_LSP_SERVERS: Record<string, BuiltinLspServer> = {
  dart: {
    marker: "pubspec.yaml",
    command: "dart",
    args: ["language-server", "--protocol=lsp"],
    extensionToLanguage: { ".dart": "dart" },
  },
  typescript: {
    marker: "tsconfig.json",
    command: "typescript-language-server",
    args: ["--stdio"],
    extensionToLanguage: {
      ".ts": "typescript",
      ".tsx": "typescriptreact",
      ".js": "javascript",
      ".jsx": "javascriptreact",
      ".mts": "typescript",
      ".cts": "typescript",
    },
  },
};

/**
 * Resolves an executable the way a shell would, without a shell: a manual PATH
 * walk plus `accessSync(X_OK)`. Deliberately not `which` — spawning a process
 * to answer "is there a process to spawn" is both slower and one more surface,
 * and the manual walk is trivially testable by passing a PATH.
 */
export function resolveOnPath(
  command: string,
  pathValue: string = process.env.PATH ?? "",
): string | undefined {
  // An explicit path is not a PATH lookup.
  if (command.includes("/")) {
    return isExecutable(command) ? command : undefined;
  }
  for (const dir of pathValue.split(delimiter)) {
    if (dir === "") continue;
    const candidate = join(dir, command);
    if (isExecutable(candidate)) return candidate;
  }
  return undefined;
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The built-in servers that actually apply to `rootDir`: the marker file must
 * exist AND the binary must resolve. A missing binary is the common case (most
 * machines have no language server installed) and must stay silent — the
 * doctor row is where that gets reported, not the startup path.
 */
export function detectBuiltinServers(
  rootDir: string,
  pathValue?: string,
): Record<string, LspServerConfig> {
  const found: Record<string, LspServerConfig> = {};
  for (const [name, builtin] of Object.entries(BUILTIN_LSP_SERVERS)) {
    if (!existsSync(join(rootDir, builtin.marker))) continue;
    if (resolveOnPath(builtin.command, pathValue) === undefined) continue;
    found[name] = {
      command: builtin.command,
      args: [...builtin.args],
      extensionToLanguage: { ...builtin.extensionToLanguage },
    };
  }
  return found;
}
