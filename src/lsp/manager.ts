import type { DeepCodeSettings, LspServerConfig } from "../config/loader.js";
import { buildChildEnvironment, prepareSandboxedCommand, spawnContained } from "../sandbox/launcher.js";
import type { SandboxLevel } from "../sandbox/seatbelt.js";
import type { Transport } from "./client.js";
import { detectBuiltinServers } from "./defaults.js";
import { LspServer, type LspServerState, type SpawnFn } from "./server.js";
import type { LspDiagnostic } from "./protocol.js";

/**
 * Commands an LSP server may be launched from under `strictMcpConfig`.
 *
 * Separate from ALLOWED_MCP_COMMANDS by necessity: that list holds launchers
 * (`npx`, `node`, …) because an MCP server is normally a package entry point.
 * A language server is usually a native binary on PATH (`dart`, `gopls`,
 * `rust-analyzer`), so reusing the MCP list would block every real server while
 * still allowing `npx` to fetch arbitrary code. Composed like the MCP list:
 * explicit names only, no user-extensible entries.
 */
export const ALLOWED_LSP_COMMANDS = new Set([
  "dart",
  "typescript-language-server",
  "vscode-json-language-server",
  "vscode-css-language-server",
  "vscode-html-language-server",
  "gopls",
  "rust-analyzer",
  "pyright-langserver",
  "pylsp",
  "clangd",
  "lua-language-server",
  "solargraph",
  "elixir-ls",
  "kotlin-language-server",
  "jdtls",
  "terraform-ls",
  "zls",
  "bash-language-server",
  "yaml-language-server",
  "deno",
  "buf",
]);

/**
 * Whether `command` may launch under `strictMcpConfig`: a bare allowlisted name,
 * resolved through PATH. Any path separator is refused, not reduced to its
 * basename — otherwise a project could ship `./dart` (an allowlisted name) and
 * run its own script.
 */
export function isLspCommandAllowed(command: string): boolean {
  return !/[\\/]/.test(command) && ALLOWED_LSP_COMMANDS.has(command);
}

/**
 * Environment variables that change which program runs or what it loads. An
 * allowlisted `dart` is only the allowlisted `dart` if `PATH` still points at
 * the real one, so under `strictMcpConfig` an entry that sets any of these is
 * refused rather than spawned with it.
 */
const LAUNCH_REDIRECTING_ENV =
  /^(PATH|IFS|BASH_ENV|ENV|GCONV_PATH|LD_.*|DYLD_.*|NODE_.*|PYTHON.*|PERL.*|RUBY.*|JAVA_TOOL_OPTIONS|_JAVA_OPTIONS)$/;

/**
 * Why `strictMcpConfig` refuses this server, or undefined when it may run.
 * Gates the launch only: `args` are not constrained, the same limit as the
 * MCP launcher allowlist (a project entry is also behind trust-on-first-use).
 */
export function lspStrictViolation(config: LspServerConfig): string | undefined {
  if (!isLspCommandAllowed(config.command)) {
    return `command "${config.command}" is not a bare name in the LSP allowlist`;
  }
  const redirect = Object.keys(config.env ?? {}).find((key) => LAUNCH_REDIRECTING_ENV.test(key));
  if (redirect !== undefined) return `env "${redirect}" could redirect the launched program`;
  return undefined;
}

export interface LspStatusEntry {
  name: string;
  state: LspServerState;
  extensions: string[];
  command: string;
}

export interface LspManagerOptions {
  rootDir: string;
  servers: Record<string, LspServerConfig>;
  spawn: SpawnFn;
  /** `strictMcpConfig` — when true, a command outside ALLOWED_LSP_COMMANDS is refused. */
  strict?: boolean;
  /** Startup/one-time notes (a blocked server, a twice-crashed server). */
  onNote?: (text: string) => void;
  quietMs?: number;
  maxWaitMs?: number;
}

/**
 * Routes a file to its language server and owns the set of servers.
 *
 * Servers start lazily on first use: importing nib in a Dart project must not
 * cost a language-server cold start unless an edit or an `lsp` call actually
 * needs one.
 */
export class LspManager {
  private readonly rootDir: string;
  private readonly configs: Record<string, LspServerConfig>;
  private readonly spawn: SpawnFn;
  private readonly onNote: ((text: string) => void) | undefined;
  private readonly quietMs: number | undefined;
  private readonly maxWaitMs: number | undefined;

  private readonly instances = new Map<string, LspServer>();
  /** extension → server name, resolved once. First server wins a duplicate. */
  private readonly byExtension = new Map<string, string>();
  /** Commands refused by the strict allowlist, so nothing spawns and doctor can say why. */
  private readonly blocked = new Map<string, string>();

  constructor(options: LspManagerOptions) {
    this.rootDir = options.rootDir;
    this.configs = options.servers;
    this.spawn = options.spawn;
    this.onNote = options.onNote;
    this.quietMs = options.quietMs;
    this.maxWaitMs = options.maxWaitMs;

    for (const [name, config] of Object.entries(this.configs)) {
      const violation = options.strict ? lspStrictViolation(config) : undefined;
      if (violation !== undefined) {
        // A project-supplied command outside the allowlist. Refused here, at
        // construction, so no path can reach the spawn: the same "only the
        // launch is gated" shape as the MCP allowlist.
        const message =
          `blocked by strictMcpConfig: ${violation}. ` +
          `To allow it, set "strictMcpConfig": false in settings.`;
        this.blocked.set(name, message);
        process.stderr.write(`  [lsp] ${name}: ${message}\n`);
        continue;
      }
      for (const ext of Object.keys(config.extensionToLanguage)) {
        if (!this.byExtension.has(ext)) this.byExtension.set(ext, name);
      }
    }
  }

  /** True when at least one runnable server exists — the prompt guide's condition. */
  get hasServers(): boolean {
    return this.byExtension.size > 0;
  }

  /** Workspace root, for rendering workspace-relative paths in results. */
  get workspaceRoot(): string {
    return this.rootDir;
  }

  /** The name of the server that owns `path`, without starting it. */
  serverNameFor(path: string): string | undefined {
    const match = /(\.[^.\\/]+)$/.exec(path);
    if (!match) return undefined;
    return this.byExtension.get(match[1]!);
  }

  extensionsOf(name: string): string[] {
    return Object.keys(this.configs[name]?.extensionToLanguage ?? {});
  }

  /** The server responsible for `path`, started on demand. */
  serverFor(path: string): LspServer | undefined {
    const match = /(\.[^.\\/]+)$/.exec(path);
    if (!match) return undefined;
    const name = this.byExtension.get(match[1]!);
    if (name === undefined) return undefined;

    const existing = this.instances.get(name);
    if (existing) return existing;

    const config = this.configs[name];
    if (!config) return undefined;
    const server = new LspServer({
      name,
      config,
      rootDir: this.rootDir,
      spawn: this.spawn,
      ...(this.onNote ? { onNote: this.onNote } : {}),
      ...(this.quietMs !== undefined ? { quietMs: this.quietMs } : {}),
      ...(this.maxWaitMs !== undefined ? { maxWaitMs: this.maxWaitMs } : {}),
    });
    this.instances.set(name, server);
    return server;
  }

  /**
   * Diagnostics for each path that has a server, keyed by the path as given.
   * A file whose server fails to start is omitted rather than reported as an
   * error: diagnostics are an enhancement, and a broken server must not turn a
   * successful edit into a failed tool result.
   */
  async diagnosticsFor(paths: readonly string[]): Promise<Map<string, LspDiagnostic[]>> {
    const results = new Map<string, LspDiagnostic[]>();
    const byServer = new Map<LspServer, string[]>();
    for (const path of paths) {
      const server = this.serverFor(path);
      if (!server || server.currentState === "disabled") continue;
      const list = byServer.get(server) ?? [];
      list.push(path);
      byServer.set(server, list);
    }

    for (const [server, serverPaths] of byServer) {
      try {
        for (const path of serverPaths) await server.syncFile(path);
        for (const path of serverPaths) {
          results.set(path, await server.waitForDiagnostics(path));
        }
      } catch {
        // Server would not start (missing binary, bad config, crash cap): drop
        // this server's files, leave the rest of the batch intact.
      }
    }
    return results;
  }

  /** Doctor row data, without starting anything. */
  status(): LspStatusEntry[] {
    return Object.entries(this.configs).map(([name, config]) => {
      const instance = this.instances.get(name);
      const blocked = this.blocked.has(name);
      const state: LspServerState = blocked ? "disabled" : (instance?.currentState ?? "idle");
      return {
        name,
        state,
        extensions: Object.keys(config.extensionToLanguage),
        command: config.command,
      };
    });
  }

  /** Why a server will not run, when the strict allowlist refused it. */
  blockedReason(name: string): string | undefined {
    return this.blocked.get(name);
  }

  async shutdownAll(): Promise<void> {
    await Promise.all([...this.instances.values()].map((server) => server.shutdown()));
    this.instances.clear();
  }
}

export interface LspSpawnOptions {
  cwd: string;
  trustedRoot: string;
  sandboxLevel?: SandboxLevel;
  writeRoots?: string[];
  sessionTempDir?: string;
}

/**
 * The real SpawnFn: a contained child with `Content-Length` pipes, mirroring
 * MCPClient.connect (src/mcp/client.ts). Kept beside the manager so tests can
 * substitute a fake transport without touching this path.
 */
export function createSpawnFn(spawnOptions: LspSpawnOptions): SpawnFn {
  return (config, name): Transport => {
    const args = config.args ?? [];
    const spec = prepareSandboxedCommand(config.command, args, spawnOptions);
    const childEnv = {
      ...buildChildEnvironment(spawnOptions.sessionTempDir),
      ...config.env,
    };
    const contained = spawnContained(spec, [config.command, ...args], {
      cwd: spawnOptions.cwd,
      env: childEnv,
      stdio: { stdin: "pipe" },
    });
    const proc = contained.proc;

    let stderrTail = "";
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-2000);
    });
    // A readiness failure means the profile never applied; the close handler
    // reports it through the same path as an exit so the crash policy applies.
    void contained.readiness.catch(() => undefined);

    const dataHandlers: Array<(chunk: Buffer) => void> = [];
    proc.stdout?.on("data", (chunk: Buffer) => {
      for (const handler of dataHandlers) handler(chunk);
    });

    const closeHandlers: Array<(code: number | null, stderrTail: string) => void> = [];
    let closed = false;
    const fireClose = (code: number | null): void => {
      if (closed) return;
      closed = true;
      for (const handler of closeHandlers) handler(code, stderrTail.trim());
    };
    proc.on("exit", (code) => fireClose(code));
    proc.on("error", (err) => {
      stderrTail = (stderrTail + `\n${err.message}`).slice(-2000);
      fireClose(null);
    });

    return {
      write(bytes: Buffer): void {
        proc.stdin?.write(bytes);
      },
      onData(cb): void {
        dataHandlers.push(cb);
      },
      onClose(cb): void {
        closeHandlers.push(cb);
      },
      kill(): void {
        if (!closed) {
          try {
            proc.kill();
          } catch {
            // Already gone.
          }
        }
      },
    };
  };
}

/**
 * Built-ins ∪ user entries, user wins on a name collision. Built-ins are gated
 * on `lsp.builtinServers` (default on) so a user can turn the table off
 * entirely without listing every name.
 */
export function resolveLspServers(
  config: DeepCodeSettings,
  rootDir: string,
  pathValue?: string,
): Record<string, LspServerConfig> {
  const builtins = config.lsp?.builtinServers === false
    ? {}
    : detectBuiltinServers(rootDir, pathValue);
  return { ...builtins, ...(config.lspServers ?? {}) };
}
