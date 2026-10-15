import { execFile } from "node:child_process";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import {
  buildChildEnvironment,
  containmentFailureError,
  prepareSandboxedShell,
  spawnContained,
  type ReadinessOutcome,
} from "../../sandbox/launcher.js";
import { isSandboxedLevel, validateCwdWithinTrustedRoot } from "../../sandbox/seatbelt.js";
import type { SandboxedShellOptions } from "../../sandbox/launcher.js";
import type {
  StatusSegment,
  SessionInfo,
  StatusLineConfig,
  StatusLineProviderConfig,
} from "./types.js";
import { sanitizeText } from "./sanitize.js";

export type SegmentProvider = (info: SessionInfo | null) => StatusSegment[];

/** Session containment inherited by command providers. */
export type StatusLineSpawnOptions = Omit<SandboxedShellOptions, "cwd">;

// ── Injectable runners (real implementations below; overridable in tests so no
// real processes or module imports run during unit tests). ──

/** Run a command, resolving to raw stdout. Rejects on timeout/failure. */
export type CommandRunner = (
  command: string,
  opts: {
    timeoutMs: number;
    cwd: string;
    trustedRoot?: string;
    sandboxLevel?: SandboxedShellOptions["sandboxLevel"];
    writeRoots?: string[];
    sessionTempDir?: string;
  },
) => Promise<string>;

/** Import a local module and return its default export (expected callable). */
export type ModuleImporter = (path: string) => Promise<unknown>;

const MAX_STDOUT_BYTES = 1024 * 1024;

export const defaultCommandRunner: CommandRunner = (command, opts) =>
  new Promise((resolvePromise, reject) => {
    const { timeoutMs, cwd, trustedRoot, sandboxLevel, writeRoots, sessionTempDir } = opts;
    const activeSandbox = isSandboxedLevel(sandboxLevel) && trustedRoot
      ? { level: sandboxLevel, trustedRoot }
      : undefined;
    if (activeSandbox) {
      const validation = validateCwdWithinTrustedRoot(cwd, activeSandbox.trustedRoot, writeRoots);
      if (!validation.ok) {
        reject(new Error(validation.error));
        return;
      }
    }
    if (!activeSandbox) {
      // No profile applies: unchanged execFile launch of the platform shell,
      // with execFile's own timeout and maxBuffer semantics.
      const commandSpec = { file: process.env.SHELL || "/bin/sh", args: ["-c", command] };
      execFile(
        commandSpec.file,
        commandSpec.args,
        {
          timeout: timeoutMs,
          cwd,
          windowsHide: true,
          maxBuffer: MAX_STDOUT_BYTES,
          env: process.env,
        },
        (err, stdout) => {
          if (err) reject(err);
          else resolvePromise(stdout);
        },
      );
      return;
    }

    // Contained: the profile is confirmed inside the child before its output
    // counts, so an unapplied profile is reported rather than read as a
    // provider that failed.
    const spec = prepareSandboxedShell(command, {
      cwd,
      trustedRoot: activeSandbox.trustedRoot,
      sandboxLevel: activeSandbox.level,
      writeRoots,
      sessionTempDir,
    });
    const { proc, readiness } = spawnContained(spec, ["/bin/sh", "-c", command], {
      cwd,
      env: sessionTempDir ? buildChildEnvironment(sessionTempDir) : process.env,
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    // One decision point, as in run_bash: the command's outcome is held until
    // readiness is known, because an unapplied profile and a provider that
    // failed arrive as the same events.
    let read: ReadinessOutcome | undefined;
    let exited: { code: number | null; error?: Error } | undefined;
    let timer: NodeJS.Timeout | undefined;
    const finish = (): void => {
      if (settled || read === undefined || exited === undefined) return;
      settled = true;
      clearTimeout(timer);
      if (!read.ready) {
        // The command never ran, so its exit status is the framing shell's:
        // report the unconfirmed containment instead.
        proc.kill("SIGTERM");
        reject(new Error(containmentFailureError(read)));
        return;
      }
      if (exited.error) reject(exited.error);
      else resolvePromise(stdout);
    };

    timer = setTimeout(() => {
      exited = { code: null, error: new Error(`Command timed out after ${timeoutMs}ms`) };
      proc.kill("SIGTERM");
      finish();
    }, timeoutMs);

    proc.stdout?.on("data", (chunk: Buffer) => {
      if (settled) return;
      const text = chunk.toString();
      if (stdout.length + text.length > MAX_STDOUT_BYTES) {
        exited = { code: null, error: new Error("stdout maxBuffer length exceeded") };
        proc.kill("SIGTERM");
        finish();
        return;
      }
      stdout += text;
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      if (settled) return;
      if (stderr.length < 2000) stderr += chunk.toString();
    });
    proc.on("error", (err) => {
      exited = { code: null, error: err };
      finish();
    });
    proc.on("close", (code) => {
      exited = {
        code,
        error: code === 0 ? undefined : new Error(`Command failed with exit code ${code}${stderr.trim() ? `: ${stderr.trim()}` : ""}`),
      };
      finish();
    });
    void readiness.then((outcome) => {
      read = outcome;
      finish();
    });
  });

export const defaultModuleImporter: ModuleImporter = async (path) => {
  const abs = resolve(process.cwd(), path);
  const mod = (await import(pathToFileURL(abs).href)) as { default?: unknown };
  return mod.default;
};

/**
 * Aggregates config-driven statusline providers (command/module). Refreshes on
 * an interval OUTSIDE the React render — results are pushed to a listener via
 * onUpdate. A provider that throws, times out, or blocks never crashes the loop
 * or the render; it just yields an empty (dropped) segment.
 */
export class StatusLineManager {
  private providers: SegmentProvider[] = [];
  private readonly config: StatusLineConfig;
  private readonly runCommand: CommandRunner;
  private readonly importModule: ModuleImporter;
  private readonly spawnOptions?: StatusLineSpawnOptions;
  private listener: ((segments: StatusSegment[]) => void) | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private refreshing = false;
  private lastSegments: StatusSegment[] = [];

  constructor(
    config: StatusLineConfig,
    deps?: {
      runCommand?: CommandRunner;
      importModule?: ModuleImporter;
      spawn?: StatusLineSpawnOptions;
    },
  ) {
    this.config = config;
    this.runCommand = deps?.runCommand ?? defaultCommandRunner;
    this.importModule = deps?.importModule ?? defaultModuleImporter;
    this.spawnOptions = deps?.spawn;
  }

  // ── Legacy synchronous provider API (kept for back-compat) ──

  addProvider(provider: SegmentProvider): void {
    this.providers.push(provider);
  }

  build(info: SessionInfo | null): StatusSegment[] {
    const segments: StatusSegment[] = [];
    for (const provider of this.providers) {
      segments.push(...provider(info));
    }
    return segments;
  }

  // ── Config-driven async layer ──

  get separator(): string {
    return this.config.separator;
  }

  /** The most recent successfully-built segment set. */
  get segments(): StatusSegment[] {
    return this.lastSegments;
  }

  /** Register the callback that receives fresh segments after each refresh. */
  onUpdate(listener: (segments: StatusSegment[]) => void): void {
    this.listener = listener;
  }

  /** Start the refresh loop (no-op if disabled or no providers). Fires once immediately. */
  start(): void {
    if (this.timer) return;
    if (!this.config.enabled || this.config.providers.length === 0) return;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.config.refreshMs);
    // Do not keep the process alive solely for the status line.
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Run every provider once, sanitize, and push the resulting segments. */
  async refresh(): Promise<StatusSegment[]> {
    if (this.refreshing) return this.lastSegments;
    this.refreshing = true;
    try {
      const results = await Promise.all(
        this.config.providers.map((p) => this.runProvider(p)),
      );
      const segments = results.filter((s): s is StatusSegment => s !== null);
      this.lastSegments = segments;
      this.listener?.(segments);
      return segments;
    } finally {
      this.refreshing = false;
    }
  }

  private async runProvider(
    provider: StatusLineProviderConfig,
  ): Promise<StatusSegment | null> {
    try {
      const raw =
        provider.type === "command"
          ? await this.runCommandProvider(provider)
          : await this.runModuleProvider(provider);
      const firstLine = raw.split(/\r?\n/, 1)[0] ?? "";
      const text = sanitizeText(firstLine);
      if (!text) return null;
      return { id: provider.id, text, color: provider.color };
    } catch {
      // Timeout, non-zero exit, import failure, or throwing module: drop segment.
      return null;
    }
  }

  private async runCommandProvider(
    provider: Extract<StatusLineProviderConfig, { type: "command" }>,
  ): Promise<string> {
    return this.runCommand(provider.command, {
      timeoutMs: provider.timeoutMs ?? 1500,
      cwd: provider.cwd ? resolve(process.cwd(), provider.cwd) : process.cwd(),
      ...this.spawnOptions,
    });
  }

  private async runModuleProvider(
    provider: Extract<StatusLineProviderConfig, { type: "module" }>,
  ): Promise<string> {
    const exported = await this.importModule(provider.path);
    if (typeof exported !== "function") {
      throw new Error(`module provider "${provider.id}" has no callable default export`);
    }
    const value = await exported();
    return value == null ? "" : String(value);
  }
}

export function createDefaultProviders(): SegmentProvider[] {
  return [
    (info) => {
      if (!info) return [{ id: "mode", text: "chat" }];
      return [{ id: "mode", text: info.activeSessionId ? "chat" : "idle" }];
    },
    (info) => {
      if (!info || !info.model) return [];
      return [{ id: "model", text: info.model }];
    },
    (info) => {
      if (!info || info.totalTokens === 0) return [];
      const pct = info.maxContextTokens > 0 ? Math.round((info.activeTokens / info.maxContextTokens) * 100) : 0;
      return [{ id: "ctx", text: `ctx ${pct}%` }];
    },
  ];
}
