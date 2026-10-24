import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { LspServerConfig } from "../config/loader.js";
import { JsonRpcConnection, type Transport } from "./client.js";
import {
  CLIENT_CAPABILITIES,
  LSP_PROTOCOL_VERSION,
  METHODS,
  PROGRESS_NOTIFICATION,
  SEVERITY_ERROR,
  SEVERITY_WARNING,
  type InitializeResult,
  type LspDiagnostic,
  type Position,
  type Range,
} from "./protocol.js";

export type LspServerState = "idle" | "starting" | "ready" | "dead" | "disabled";

/** Builds a transport for one server. Injected so tests drive a scripted fake. */
export type SpawnFn = (config: LspServerConfig, name: string) => Transport;

/**
 * How long to wait for a server to settle its diagnostics. A server typically
 * publishes an empty list on `didOpen` and the real one after analysis, so the
 * quiet window (300 ms with no new publish) is what distinguishes the two. The
 * hard cap bounds a server that never settles — better a slightly stale answer
 * than a stalled turn.
 */
export const DEFAULT_QUIET_MS = 300;
export const DEFAULT_MAX_WAIT_MS = 3_000;
/** `initialize` gets longer than an ordinary request: it is the server's cold start. */
const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 2_000;

/** Bounds on a per-file diagnostic list, so one broken file cannot flood context. */
export const MAX_DIAGNOSTICS_PER_FILE = 20;

/** One publish, as the store keeps it: an entry per file, plus when it landed. */
interface DiagnosticsEntry {
  diagnostics: LspDiagnostic[];
  /** `Date.now()` of the most recent publish for this path. */
  at: number;
}

interface Waiter {
  settle: (diagnostics: LspDiagnostic[] | undefined) => void;
  quietTimer: ReturnType<typeof setTimeout> | undefined;
  capTimer: ReturnType<typeof setTimeout>;
}

export interface LspServerOptions {
  name: string;
  config: LspServerConfig;
  rootDir: string;
  spawn: SpawnFn;
  /** Receives the one-time "disabled for this session" note. */
  onNote?: (text: string) => void;
  /** Overridable for tests. */
  quietMs?: number;
  maxWaitMs?: number;
}

/**
 * One language server process, with the lifecycle the plan specifies: lazy
 * start, per-file sync, a diagnostic wait that settles on a quiet window, and a
 * crash policy that gives a flaky server exactly one restart before it is
 * disabled for the session.
 *
 * The extension→language mapping and path→server routing live in the manager;
 * this class knows only "here is a file, give me its diagnostics".
 */
export class LspServer {
  readonly name: string;
  private readonly config: LspServerConfig;
  private readonly rootDir: string;
  private readonly spawnFn: SpawnFn;
  private readonly onNote: ((text: string) => void) | undefined;
  private readonly quietMs: number;
  private readonly maxWaitMs: number;

  private state: LspServerState = "idle";
  private connection: JsonRpcConnection | undefined;
  private startPromise: Promise<void> | undefined;
  private hasRestarted = false;

  /** Per-file latest publish, keyed by absolute path. */
  private readonly diagnostics = new Map<string, DiagnosticsEntry>();
  /** Files already announced with `didOpen`, and their current version. */
  private readonly openVersions = new Map<string, number>();
  /** Pending `$/progress` tokens — a token's `end` settles the wait early. */
  private readonly progressTokens = new Set<string>();

  private waiters: Waiter[] = [];

  constructor(options: LspServerOptions) {
    this.name = options.name;
    this.config = options.config;
    this.rootDir = options.rootDir;
    this.spawnFn = options.spawn;
    this.onNote = options.onNote;
    this.quietMs = options.quietMs ?? DEFAULT_QUIET_MS;
    this.maxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  }

  get currentState(): LspServerState {
    return this.state;
  }

  get extensions(): string[] {
    return Object.keys(this.config.extensionToLanguage);
  }

  /** Lazily starts the server; resolves immediately when already ready. */
  async start(): Promise<void> {
    if (this.state === "ready") return;
    if (this.state === "disabled") throw new Error(`${this.name}: disabled for this session`);
    if (this.startPromise) return this.startPromise;

    this.state = "starting";
    this.startPromise = this.doStart().finally(() => {
      this.startPromise = undefined;
    });
    return this.startPromise;
  }

  private async doStart(): Promise<void> {
    const transport = this.spawnFn(this.config, this.name);
    const connection = new JsonRpcConnection(transport);
    this.connection = connection;

    // A crash mid-life must be visible to every waiter instead of leaving the
    // turn hanging until the cap.
    connection.onClose(() => this.handleCrash());

    connection.onNotification((method, params) => this.handleNotification(method, params));
    connection.onRequest((method, params) => this.handleServerRequest(method, params));

    try {
      await connection.request<InitializeResult>(
        METHODS.initialize,
        {
          processId: process.pid,
          clientInfo: { name: "nib", version: "0.7" },
          rootUri: pathToFileURL(this.rootDir).toString(),
          workspaceFolders: [{ uri: pathToFileURL(this.rootDir).toString(), name: this.name }],
          capabilities: CLIENT_CAPABILITIES,
          ...(this.config.initializationOptions !== undefined
            ? { initializationOptions: this.config.initializationOptions }
            : {}),
        },
        this.config.startupTimeout ?? DEFAULT_STARTUP_TIMEOUT_MS,
      );
      connection.notify(METHODS.initialized, {});
      if (this.config.settings !== undefined) {
        connection.notify(METHODS.didChangeConfiguration, { settings: this.config.settings });
      }
      this.state = "ready";
    } catch (err) {
      this.state = "dead";
      connection.dispose();
      this.connection = undefined;
      throw err;
    }
  }

  /**
   * Tells the server about a file's current on-disk content. The first sync of
   * a path is `didOpen`; every later one is a full-content `didChange` with an
   * incremented version (full sync: no incremental ranges are advertised in
   * CLIENT_CAPABILITIES, so the server must accept whole documents).
   */
  async syncFile(path: string): Promise<void> {
    if (this.state === "dead" && !this.hasRestarted) {
      // One restart per server, on the next use after a crash.
      this.hasRestarted = true;
      this.diagnostics.clear();
      this.openVersions.clear();
      this.state = "idle";
    }
    if (this.state === "disabled") return;
    await this.start();
    const connection = this.connection;
    if (!connection) return;

    let text: string;
    try {
      text = readFileSync(path, "utf-8");
    } catch {
      return;
    }

    const uri = pathToFileURL(path).toString();
    const languageId = this.languageFor(path);
    const version = this.openVersions.get(path);

    if (version === undefined) {
      this.openVersions.set(path, 1);
      connection.notify(METHODS.didOpen, {
        textDocument: { uri, languageId, version: 1, text },
      });
    } else {
      this.openVersions.set(path, version + 1);
      connection.notify(METHODS.didChange, {
        textDocument: { uri, version: version + 1 },
        contentChanges: [{ text }],
      });
    }
  }

  /**
   * Resolves the file's diagnostics once the server has settled. A server that
   * publishes twice (empty, then real) settles on the quiet window; a server
   * that signals `$/progress` end settles immediately; the hard cap covers the
   * rest.
   */
  waitForDiagnostics(path: string): Promise<LspDiagnostic[]> {
    const existing = this.diagnostics.get(path);
    return new Promise<LspDiagnostic[]>((resolve) => {
      const capTimer = setTimeout(() => this.settle(null), this.maxWaitMs);
      const waiter: Waiter = {
        settle: (list) => {
          clearTimeout(capTimer);
          if (waiter.quietTimer !== undefined) clearTimeout(waiter.quietTimer);
          this.waiters = this.waiters.filter((w) => w !== waiter);
          resolve(list ?? this.diagnostics.get(path)?.diagnostics ?? []);
        },
        // A publish already on record still gets its quiet window: the caller
        // asked *after* the notify, and a second publish may be coming.
        quietTimer: setTimeout(
          () => this.settle(waiter),
          existing ? this.quietMs : this.maxWaitMs,
        ),
        capTimer,
      };
      this.waiters.push(waiter);
    });
  }

  /** Settles `target` (or every waiter) with the current stored list. */
  private settle(target: Waiter | null): void {
    const waiters = target ? [target] : [...this.waiters];
    for (const waiter of waiters) waiter.settle(undefined);
  }

  async request<T>(method: string, params: unknown, timeoutMs?: number): Promise<T> {
    await this.start();
    const connection = this.connection;
    if (!connection) throw new Error(`${this.name}: not running`);
    return connection.request<T>(method, params, timeoutMs);
  }

  private handleNotification(method: string, params: unknown): void {
    if (method === METHODS.publishDiagnostics) {
      this.handlePublish(params);
      return;
    }
    if (method === PROGRESS_NOTIFICATION) {
      const p = params as { token?: string | number; value?: { kind?: string } } | undefined;
      const kind = p?.value?.kind;
      if (kind === "begin" && p?.token !== undefined) this.progressTokens.add(String(p.token));
      if (kind === "end") {
        if (p?.token !== undefined) this.progressTokens.delete(String(p.token));
        // Analysis finished: no need to wait out the quiet window.
        this.settle(null);
      }
    }
  }

  private handlePublish(params: unknown): void {
    const p = params as
      | { uri?: string; diagnostics?: Array<{
          range?: Range;
          severity?: number;
          message?: string;
          code?: string | number;
        }> }
      | undefined;
    if (!p?.uri) return;

    let path: string;
    try {
      path = fileURLToPath(p.uri);
    } catch {
      return;
    }

    const list: LspDiagnostic[] = [];
    for (const raw of p.diagnostics ?? []) {
      const start: Position | undefined = raw.range?.start;
      const severity = (raw.severity ?? SEVERITY_ERROR) as 1 | 2 | 3 | 4;
      if (typeof raw.message !== "string") continue;
      list.push({
        path,
        // The wire is 0-based; everything nib shows the model is 1-based.
        line: (start?.line ?? 0) + 1,
        character: (start?.character ?? 0) + 1,
        severity,
        message: raw.message,
        ...(raw.code !== undefined ? { code: raw.code } : {}),
      });
    }

    this.diagnostics.set(path, { diagnostics: list, at: Date.now() });

    // Restart every waiter's quiet window: a publish means the server is still
    // talking, so the previous one was not the final answer.
    for (const waiter of this.waiters) {
      if (waiter.quietTimer !== undefined) clearTimeout(waiter.quietTimer);
      waiter.quietTimer = setTimeout(() => this.settle(waiter), this.quietMs);
    }
  }

  /** Answers the server→client requests an ordinary session produces. */
  private handleServerRequest(method: string, params: unknown): unknown {
    switch (method) {
      case METHODS.workDoneProgressCreate:
      case METHODS.registerCapability:
        return null;
      case METHODS.showMessageRequest:
        // A modal prompt would block a headless run forever.
        return null;
      case METHODS.workspaceConfiguration: {
        const items = (params as { items?: unknown[] } | undefined)?.items ?? [];
        return items.map(() => this.config.settings ?? null);
      }
      default:
        throw new Error(`method not found: ${method}`);
    }
  }

  private handleCrash(): void {
    this.connection = undefined;
    this.progressTokens.clear();
    // Waiters settle with what is on record rather than hanging to the cap.
    this.settle(null);

    if (this.state === "disabled") return;
    if (this.hasRestarted) {
      this.state = "disabled";
      this.onNote?.(
        `[nib] ${this.name} language server crashed twice — disabled for .${this.primaryExtension().replace(/^\./, "")} this session`,
      );
      return;
    }
    this.state = "dead";
  }

  private primaryExtension(): string {
    return Object.keys(this.config.extensionToLanguage)[0] ?? "";
  }

  private languageFor(path: string): string {
    const match = /(\.[^.\\/]+)$/.exec(path);
    const ext = match?.[1] ?? "";
    return this.config.extensionToLanguage[ext] ?? "plaintext";
  }

  async shutdown(): Promise<void> {
    const connection = this.connection;
    this.state = "dead";
    this.connection = undefined;
    this.settle(null);
    if (!connection) return;
    try {
      await connection.request(METHODS.shutdown, undefined, this.config.shutdownTimeout ?? DEFAULT_SHUTDOWN_TIMEOUT_MS);
      connection.notify(METHODS.exit);
    } catch {
      // A server that never answers `shutdown` still gets killed below.
    }
    connection.dispose();
  }
}

export { SEVERITY_ERROR, SEVERITY_WARNING };
