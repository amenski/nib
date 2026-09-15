import { spawn } from "node:child_process";
import type { NotifyInput } from "../notify.js";
import { redactSecrets } from "../sessions/redact.js";
import { wrapUntrusted } from "../tools/untrusted-content.js";
import {
  hookContentHash,
  hookTrustKey,
  isHookTrusted,
  loadHookTrust,
  saveHookTrust,
  type ContentHashCache,
} from "./trust.js";
import type { HookEntry, HookEvent, HooksConfig } from "./types.js";
import { BLOCKABLE_EVENTS, CONTEXT_STDOUT_EVENTS } from "./types.js";

/**
 * Hook dispatcher (docs/hooks-spec.md). Sequential per event, config order;
 * `/bin/sh -c` spawns with a minimal env and a one-line redacted JSON payload
 * on stdin; exit-code semantics per spec §4. This is the only file that
 * spawns hook processes — every wiring point calls `dispatch` and interprets
 * the `{ blocked, stdout }` result.
 */

const HOOK_TIMEOUT_MS = 30_000; // spec §4: 30 s default, SIGKILL on timeout
const STDOUT_CAP = 64 * 1024; // spec §3: stdout capture cap, truncation note beyond
const NOTIFY_BODY_MAX = 4096; // fix 8: cap the Notification payload body

export interface DispatchResult {
  /** True when a blockable event was blocked (exit 2 or exit-0 `{decision:"deny"}`). */
  blocked: boolean;
  /**
   * Aggregated stdout (config order), with any parsed decision JSON removed.
   * Meaningful only for events with "appended to …" stdout semantics
   * (UserPromptSubmit, PostToolUse, PostToolUseFailure, PreCompact) — for
   * those, the aggregated context is wrapped in the untrusted-content
   * delimiters before it is returned, so no hook stdout can enter model
   * context unwrapped (security-spec.md T12, fix 2).
   */
  stdout: string;
}

export interface HookRunnerOptions {
  config?: HooksConfig;
  /** Master switch (spec §1): nothing runs, not even trusted hooks. */
  disableAllHooks?: boolean;
  /** Headless mode: untrusted project hooks are skipped with a stderr warning
   *  instead of prompting (spec §6, fail closed). */
  headless?: boolean;
  /** When set, hook stderr / non-blocking errors / truncation notes are
   *  written to stderr (the "debug log" in spec §3-4). */
  debug?: boolean;
  cwd: string;
  sessionId: () => string | undefined;
  /** Permission posture for the payload (spec §3 `permission_mode`). */
  getPermissionMode: () => string;
  /** Overrides the 30 s default — tests only. */
  timeoutMs?: number;
  /** Override for the process-group killer (tests only). */
  killFn?: typeof process.kill;
}

export class HookRunner {
  private byEvent: Record<HookEvent, HookEntry[]>;
  private disableAllHooks: boolean;
  private headless: boolean;
  private debug: boolean;
  private cwd: string;
  private sessionId: () => string | undefined;
  private getPermissionMode: () => string;
  private timeoutMs: number;
  private killFn: typeof process.kill = process.kill.bind(process);
  /** Per-session trust decisions, keyed by trust key — an "n" asks only once per session. */
  private sessionTrust = new Map<string, boolean>();
  /** mtime-gated content-hash cache for file commands (trust.ts, fix 1). */
  private contentHashes: ContentHashCache = new Map();

  /**
   * Interactive ask-tier confirmation for unseen project hooks (TOFU, spec
   * §6): resolves true = trust forever (persisted to hooks-trust.json),
   * false = skip this session. Set by the TUI (App.tsx) — headless runs
   * leave it unset and skip instead.
   */
  confirmTrust?: (entry: HookEntry) => Promise<boolean>;

  constructor(options: HookRunnerOptions) {
    const config = options.config;
    this.byEvent = config?.byEvent ?? ({} as Record<HookEvent, HookEntry[]>);
    this.disableAllHooks = options.disableAllHooks ?? false;
    this.headless = options.headless ?? false;
    this.debug = options.debug ?? false;
    this.cwd = options.cwd;
    this.sessionId = options.sessionId;
    this.getPermissionMode = options.getPermissionMode;
    this.timeoutMs = options.timeoutMs ?? HOOK_TIMEOUT_MS;
    this.killFn = options.killFn ?? process.kill.bind(process);
  }

  get enabled(): boolean {
    return !this.disableAllHooks && Object.values(this.byEvent).some((e) => e.length > 0);
  }

  /**
   * Startup trust check (spec §6): compare each project-origin hook against
   * hooks-trust.json using its content-hashed, project-scoped trust key.
   * Headless: unseen pairs are skipped with a stderr warning right here.
   * Interactive: the pair is marked pending and the ask fires at first
   * dispatch (via confirmTrust), so the confirmation uses the same ask-tier
   * surface as permission prompts.
   */
  verifyTrust(): void {
    if (!this.enabled) return;
    const store = loadHookTrust();
    for (const entry of Object.values(this.byEvent).flat()) {
      if (entry.origin !== "project") continue;
      const key = this.trustKeyFor(entry);
      if (isHookTrusted(store, key)) {
        this.sessionTrust.set(key, true);
      } else if (this.headless) {
        this.sessionTrust.set(key, false);
        process.stderr.write(
          `nib: skipping untrusted project hook (${entry.event}) "${entry.command}" — trust it in an interactive session or remove it from the project settings (docs/hooks-spec.md §6)\n`,
        );
      }
      // interactive + unseen: leave unmarked → first dispatch asks via confirmTrust
    }
  }

  /**
   * Run the hooks for `event` sequentially, in config order. Returns blocked
   * for blockable events (exit 2, or exit-0 `{decision:"deny"}` on stdout)
   * plus the aggregated stdout for context-semantics events.
   */
  async dispatch(event: HookEvent, extra?: Record<string, unknown>): Promise<DispatchResult> {
    if (!this.enabled) return { blocked: false, stdout: "" };
    const entries = this.byEvent[event];
    if (entries.length === 0) return { blocked: false, stdout: "" };

    const payload = { hook_event_name: event, session_id: this.sessionId() ?? undefined, cwd: this.cwd, permission_mode: this.getPermissionMode(), ...extra };
    const payloadLine = JSON.stringify(redactDeep(payload));

    let context = "";
    for (const entry of entries) {
      // Tool matcher (spec §1): skip non-matching entries for tool events.
      if (entry.matches && typeof extra?.tool_name === "string" && !entry.matches(extra.tool_name)) {
        continue;
      }
      if (!(await this.ensureTrusted(entry))) continue;

      const result = await this.runHook(entry, payloadLine);
      const where = `hooks.${entry.event} "${entry.command}"`;

      if (result.error) {
        if (this.debug) process.stderr.write(`${where}: spawn failed: ${result.error}\n`);
        continue;
      }
      if (result.timedOut) {
        if (this.debug) process.stderr.write(`${where}: timed out after ${Math.round(this.timeoutMs / 1000)}s — killed\n`);
        continue;
      }
      if (result.stderr && this.debug) process.stderr.write(`${where} (stderr): ${result.stderr.trimEnd()}\n`);

      if (result.exitCode === 0) {
        if (BLOCKABLE_EVENTS.includes(event)) {
          const decision = parseStdoutDecision(result.stdout);
          if (decision === "deny") return { blocked: true, stdout: context };
          context += stripDecisionJson(result.stdout);
        } else {
          context += result.stdout;
        }
      } else if (result.exitCode === 2 && BLOCKABLE_EVENTS.includes(event)) {
        return { blocked: true, stdout: context };
      } else if (this.debug) {
        process.stderr.write(`${where}: exited with code ${result.exitCode} (non-blocking error)\n`);
      }
    }
    // Context-semantics stdout must never reach the model unwrapped (fix 2) —
    // the untrusted-content delimiters pair with the base-rules standing rule.
    if (context !== "" && CONTEXT_STDOUT_EVENTS.includes(event)) {
      context = wrapUntrusted(context.trimEnd());
    }
    return { blocked: false, stdout: context };
  }

  /** Trust gate for one entry: global = always; project = trust file, else ask (or skip headless). */
  private async ensureTrusted(entry: HookEntry): Promise<boolean> {
    if (entry.origin !== "project") return true;
    const key = this.trustKeyFor(entry);
    const decided = this.sessionTrust.get(key);
    if (decided !== undefined) return decided;
    const store = loadHookTrust();
    if (isHookTrusted(store, key)) {
      this.sessionTrust.set(key, true);
      return true;
    }
    if (this.headless) {
      // Unseen at dispatch time (e.g. the hook entry appeared after startup) —
      // fail closed like the startup path.
      this.sessionTrust.set(key, false);
      process.stderr.write(
        `nib: skipping untrusted project hook (${entry.event}) "${entry.command}" — trust it in an interactive session or remove it from the project settings (docs/hooks-spec.md §6)\n`,
      );
      return false;
    }
    const trusted = this.confirmTrust ? await this.confirmTrust(entry) : false;
    if (trusted) {
      store.hooks[key] = { firstSeen: Date.now(), trusted: true };
      saveHookTrust(store);
      this.sessionTrust.set(key, true);
      return true;
    }
    this.sessionTrust.set(key, false);
    return false;
  }

  /** Content-hashed, project-scoped trust key for an entry (fix 1). */
  private trustKeyFor(entry: HookEntry): string {
    const contentHash = hookContentHash(entry.command, this.cwd, this.contentHashes);
    return hookTrustKey(entry.event, entry.matcher, entry.command, contentHash, this.cwd);
  }

  private runHook(
    entry: HookEntry,
    payloadLine: string,
  ): Promise<{ exitCode: number | null; timedOut: boolean; stdout: string; stderr: string; error?: string }> {
    return new Promise((resolve) => {
      const env: Record<string, string> = {};
      for (const k of ["PATH", "HOME", "TERM"] as const) {
        const v = process.env[k];
        if (v !== undefined) env[k] = v;
      }

      let child;
      try {
        child = spawn("/bin/sh", ["-c", entry.command], {
          cwd: this.cwd,
          env,
          stdio: ["pipe", "pipe", "pipe"],
          // Own process group (fix 7): the timeout kills the whole group so
          // grandchildren die too — a hook must not outlive its deadline, and
          // a backgrounded child of a timed-out hook must not keep running.
          detached: true,
        });
      } catch (err) {
        resolve({ exitCode: null, timedOut: false, stdout: "", stderr: "", error: (err as Error).message });
        return;
      }

      let stdout = "";
      let stderr = "";
      let settled = false;
      const settle = (r: { exitCode: number | null; timedOut: boolean; stdout: string; stderr: string; error?: string }) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(r);
        }
      };
      const killGroup = (): void => {
        try {
          this.killFn(-child.pid!, "SIGKILL");
        } catch {
          // group already gone (ESRCH) or the kill was refused — nothing to reap
        }
      };
      const timer = setTimeout(() => {
        killGroup();
        settle({ exitCode: null, timedOut: true, stdout, stderr });
      }, this.timeoutMs);

      child.stdout?.on("data", (d: Buffer) => {
        const s = d.toString();
        if (stdout.length >= STDOUT_CAP) {
          if (this.debug) process.stderr.write(`hooks.${entry.event} "${entry.command}": stdout truncated at ${STDOUT_CAP} bytes\n`);
          return;
        }
        const room = STDOUT_CAP - stdout.length;
        stdout += room >= s.length ? s : s.slice(0, room);
        if (room < s.length && this.debug) {
          process.stderr.write(`hooks.${entry.event} "${entry.command}": stdout truncated at ${STDOUT_CAP} bytes\n`);
        }
      });
      child.stderr?.on("data", (d: Buffer) => {
        const s = d.toString();
        if (stderr.length >= STDOUT_CAP) {
          if (this.debug) process.stderr.write(`hooks.${entry.event} "${entry.command}": stderr truncated at ${STDOUT_CAP} bytes\n`);
          return;
        }
        const room = STDOUT_CAP - stderr.length;
        stderr += room >= s.length ? s : s.slice(0, room);
        if (room < s.length && this.debug) {
          process.stderr.write(`hooks.${entry.event} "${entry.command}": stderr truncated at ${STDOUT_CAP} bytes\n`);
        }
      });
      child.on("error", (err) => settle({ exitCode: null, timedOut: false, stdout, stderr, error: err.message }));
      child.on("close", (code) => {
        // Reap the detached handle (fix 7): the shell exited but its process
        // group may still hold backgrounded grandchildren — kill them so no
        // hook work outlives the hook.
        killGroup();
        settle({ exitCode: code, timedOut: false, stdout, stderr });
      });

      // The payload is fire-and-forget: a hook that exits instantly without
      // reading stdin closes its read end, and the write then fails EPIPE.
      // Without this listener that surfaces as an uncaughtException and
      // crashes the host process (found via the trust.test.ts flake, 2026-08-14).
      child.stdin.on("error", () => {});
      child.stdin.write(payloadLine + "\n");
      child.stdin.end();
    });
  }
}

/**
 * Exit-0 stdout JSON on blockable events (spec §4): a final JSON object on
 * stdout may carry `{decision: "allow"|"deny"}`. `allow` is advisory only —
 * it never upgrades a rule-derived ask, so it is simply not a block.
 * Malformed JSON = ignored.
 */
function parseStdoutDecision(stdout: string): "allow" | "deny" | undefined {
  const lines = stdout.split("\n").filter((l) => l.trim() !== "");
  if (lines.length === 0) return undefined;
  const last = lines[lines.length - 1].trim();
  try {
    const parsed = JSON.parse(last);
    if (parsed && typeof parsed === "object" && (parsed.decision === "allow" || parsed.decision === "deny")) {
      return parsed.decision;
    }
  } catch {
    // not JSON — treat as context
  }
  return undefined;
}

/** The parsed decision line must not leak into appended context. */
function stripDecisionJson(stdout: string): string {
  if (parseStdoutDecision(stdout) === undefined) return stdout;
  const lines = stdout.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim() !== "") {
      lines.splice(i, 1);
      break;
    }
  }
  return lines.join("\n");
}

/** Recursively redact every string in the payload — values and keys — before
 *  it reaches stdin (spec §3; fix 4 verifies keys too). */
function redactDeep(v: unknown): unknown {
  if (typeof v === "string") return redactSecrets(v);
  if (Array.isArray(v)) return v.map(redactDeep);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) out[redactSecrets(k)] = redactDeep(val);
    return out;
  }
  return v;
}

/**
 * Notification hook payload (spec §7): same fields as the notify env contract
 * (notify-spec.md §3) in JSON form, plus `hook_event_name` added by dispatch.
 * The body is capped (fix 8) — a multi-MB job output must not ride the hook
 * payload to a notification script.
 */
export function buildNotificationPayload(input: NotifyInput): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    status: input.status,
    duration: Math.max(0, Math.round(input.durationMs / 1000)),
    body: (input.body ?? "").slice(0, NOTIFY_BODY_MAX),
    title: (input.title ?? "").slice(0, 120),
  };
  if (input.status === "failed" && input.failReason) {
    payload.fail_reason = input.failReason;
  }
  if (input.status === "job_done" && input.job) {
    payload.job = {
      id: input.job.id,
      command: input.job.command ?? "",
      ...(input.job.exitCode !== null ? { exit_code: input.job.exitCode } : {}),
    };
  }
  return payload;
}

/**
 * Fire Notification hooks from a completion boundary, alongside fireNotify
 * (never instead of it, spec §7). Fire-and-forget like fireNotify — a hook
 * must not delay turn/job completion.
 */
export function fireNotificationHooks(
  hooks: { dispatch: (event: HookEvent, extra?: Record<string, unknown>) => Promise<DispatchResult> } | undefined,
  input: NotifyInput,
): void {
  if (!hooks) return;
  void hooks.dispatch("Notification", buildNotificationPayload(input));
}
