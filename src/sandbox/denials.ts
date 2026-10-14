import { execFile, spawn, type ChildProcess } from "node:child_process";
import { homedir } from "node:os";
import { createInterface } from "node:readline";

/**
 * The kernel logs every Seatbelt denial — process, pid, operation, target —
 * even when the command hides stderr or exits 0, which is exactly how output
 * matching (sandbox-hint.ts) misses them. This module reads that stream
 * (`log stream`, unprivileged, ~13 ms latency) and attributes each denial to
 * the nib surface that caused it, so the user and the model are told every time.
 *
 * Measured 2026-10-14, one compact-style line per denial:
 *   `... (Sandbox) Sandbox: touch(53058) deny(1) file-write-create /opt/x`
 * and repeats fold into
 *   `... (Sandbox) 3 duplicate reports for Sandbox: touch(53058) deny(1) ...`.
 * The stream is system-wide: unrelated daemons (imagent, ...) deny things all
 * day, and `allow` lines from other processes appear too — attribution below
 * exists to keep that noise out of a command's result.
 */

export interface SandboxDenial {
  proc: string;
  pid: number;
  op: string;
  target: string;
  count: number;
  at: number;
}

export type DenialOpClass = "write" | "read" | "exec" | "mach" | "network" | "other";

export interface DenialGroup {
  opClass: DenialOpClass;
  key: string;
  ops: string[];
  samples: string[];
  count: number;
}

export type DenialSurface =
  | { kind: "bash"; callId: string }
  | { kind: "job"; jobId: string }
  | { kind: "hook"; event: string }
  | { kind: "mcp"; server: string }
  | { kind: "statusline" };

/** How long a surface keeps listening after its process closes: log latency plus margin. */
export const GRACE_MS = 250;
/** Groups shown in one block; the rest collapse into "+N more". */
export const MAX_DISPLAYED_GROUPS = 8;

const DENY_LINE = /(?:(\d+) duplicate reports? for )?Sandbox: (.+?)\((\d+)\) deny\(\d+\) (\S+)(?: (.*))?$/;

/** One denial from one `log stream` line, or null for headers, `allow` lines and other senders. A duplicate-report line carries its repeat count. */
export function parseDenialLine(line: string, at: number = Date.now()): SandboxDenial | null {
  const m = DENY_LINE.exec(line);
  if (!m) return null;
  return { proc: m[2], pid: Number(m[3]), op: m[4], target: (m[5] ?? "").trim(), count: m[1] ? Number(m[1]) : 1, at };
}

export function opClassOf(op: string): DenialOpClass {
  if (op.startsWith("file-write")) return "write";
  if (op.startsWith("file-read")) return "read";
  if (op.startsWith("process-exec")) return "exec";
  if (op.startsWith("mach-")) return "mach";
  if (op.startsWith("network")) return "network";
  return "other";
}

/** `~/<first dir>` under home, else `/<first>/<second>` of the containing directory — never the file itself. */
function pathKey(target: string, home: string): string {
  if (!target.startsWith("/")) return target;
  const underHome = home !== "" && (target === home || target.startsWith(`${home}/`));
  const segs = (underHome ? target.slice(home.length) : target).split("/").filter(Boolean);
  const dirs = segs.slice(0, -1);
  if (underHome) return segs.length === 0 ? "~" : `~/${dirs.length > 0 ? dirs[0] : segs[0]}`;
  if (segs.length === 0) return "/";
  return dirs.length === 0 ? `/${segs[0]}` : `/${dirs.slice(0, 2).join("/")}`;
}

function keyFor(opClass: DenialOpClass, target: string, home: string): string {
  return opClass === "write" || opClass === "read" || opClass === "exec" ? pathKey(target, home) : target;
}

const MAX_SAMPLES = 3;

/** Fold denials into one group per (operation class, key), most frequent first. */
export function groupDenials(denials: SandboxDenial[], home: string = homedir()): DenialGroup[] {
  const groups = new Map<string, DenialGroup>();
  for (const d of denials) {
    const opClass = opClassOf(d.op);
    const key = keyFor(opClass, d.target, home);
    const id = `${opClass}\0${key}`;
    let g = groups.get(id);
    if (!g) {
      g = { opClass, key, ops: [], samples: [], count: 0 };
      groups.set(id, g);
    }
    g.count += d.count;
    if (!g.ops.includes(d.op)) g.ops.push(d.op);
    if (d.target !== "" && !g.samples.includes(d.target) && g.samples.length < MAX_SAMPLES) g.samples.push(d.target);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count);
}

/** `file-write-create under ~/.pub-cache (3×); mach-lookup com.apple.foo (1×)` — no `[nib]` prefix, for the transcript. */
export function summarizeDenials(groups: DenialGroup[]): string {
  const shown = groups.slice(0, MAX_DISPLAYED_GROUPS).map((g) => {
    const where = g.opClass === "write" || g.opClass === "read" || g.opClass === "exec" ? `under ${g.key}` : g.key;
    return `${g.ops.join(",")} ${where}`.trim() + ` (${g.count}×)`;
  });
  const extra = groups.length - shown.length;
  return shown.join("; ") + (extra > 0 ? `; +${extra} more` : "");
}

/** The line appended to a tool result, outside the untrusted-content wrapper; "" when nothing was denied. */
export function formatDenialBlock(groups: DenialGroup[]): string {
  return groups.length === 0 ? "" : `[nib] sandbox denied: ${summarizeDenials(groups)}`;
}

export interface DenialAttachment {
  /** Resolves with the denials attributed to this process once it has closed and the grace period has passed. */
  settle(): Promise<DenialGroup[]>;
  /** Denials attributed so far. */
  snapshot(): DenialGroup[];
  /** Move the attachment to another surface (run_bash timeout → background job); collected denials stay. */
  retarget(surface: DenialSurface): void;
}

export interface DenialReaderDeps {
  spawnLog?: () => ChildProcess;
  /** Process group of `pid`, or null when the process no longer exists. */
  psPgid?: (pid: number) => Promise<number | null>;
  graceMs?: number;
  now?: () => number;
}

interface Entry {
  surface: DenialSurface;
  pid: number;
  matchGroup: boolean;
  denials: SandboxDenial[];
  done: Promise<void>;
}

function spawnLogStream(): ChildProcess {
  // Full path: zsh has a `log` builtin.
  return spawn("/usr/bin/log", ["stream", "--style", "compact", "--predicate", 'sender == "Sandbox"'], {
    stdio: ["ignore", "pipe", "ignore"],
  });
}

function psPgid(pid: number): Promise<number | null> {
  return new Promise((resolve) => {
    execFile("/bin/ps", ["-o", "pgid=", "-p", String(pid)], (err, stdout) => {
      const n = err ? NaN : Number.parseInt(stdout.trim(), 10);
      resolve(Number.isNaN(n) ? null : n);
    });
  });
}

const PGID_CACHE_MAX = 500;
const START_TIMEOUT_MS = 1500;

export class DenialReader {
  /** True while the log stream is up. When false callers keep the output-matching fallback. */
  running = false;
  private proc: ChildProcess | undefined;
  private readonly entries = new Set<Entry>();
  private readonly pending = new Set<Promise<void>>();
  private readonly listeners = new Set<(surface: DenialSurface | null, denial: SandboxDenial, probable: boolean) => void>();
  private readonly pgidCache = new Map<number, number | null>();
  private readonly graceMs: number;
  private readonly now: () => number;

  constructor(private readonly deps: DenialReaderDeps = {}) {
    this.graceMs = deps.graceMs ?? GRACE_MS;
    this.now = deps.now ?? Date.now;
  }

  /** Start the stream. Never throws: a failure leaves `running` false and says why. */
  start(): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (this.running) return Promise.resolve({ ok: true });
    if (!this.deps.spawnLog && process.platform !== "darwin") return Promise.resolve({ ok: false, reason: "only available on macOS" });
    return new Promise((resolve) => {
      let proc: ChildProcess;
      try {
        proc = (this.deps.spawnLog ?? spawnLogStream)();
      } catch (err) {
        resolve({ ok: false, reason: (err as Error).message });
        return;
      }
      let answered = false;
      const answer = (r: { ok: true } | { ok: false; reason: string }): void => {
        if (answered) return;
        answered = true;
        clearTimeout(timer);
        if (!r.ok) {
          this.running = false;
          proc.kill();
        }
        resolve(r);
      };
      const up = (): void => {
        this.running = true;
        this.proc = proc;
        answer({ ok: true });
      };
      const timer = setTimeout(() => (proc.exitCode === null && proc.signalCode === null ? up() : answer({ ok: false, reason: "log stream exited" })), START_TIMEOUT_MS);
      proc.once("error", (err) => answer({ ok: false, reason: err.message }));
      proc.once("exit", (code) => {
        this.running = false;
        answer({ ok: false, reason: `log stream exited (${code})` });
      });
      if (proc.stdout) {
        createInterface({ input: proc.stdout, historySize: 0 }).on("line", (line) => {
          if (!answered) up();
          this.feed(line);
        });
      }
      proc.unref();
      process.once("exit", () => proc.kill());
    });
  }

  stop(): void {
    this.running = false;
    this.proc?.kill();
    this.proc = undefined;
  }

  /** Every attributed denial as it arrives; `surface` is null when it happened during overlapping commands and cannot be pinned on one. */
  subscribe(fn: (surface: DenialSurface | null, denial: SandboxDenial, probable: boolean) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * Listen for denials caused by `proc`. `matchGroup` also claims its
   * descendants (Bash, jobs and hooks spawn `detached`, so the process group is
   * `proc.pid`); MCP servers and the status line are matched by pid only.
   */
  attach(proc: ChildProcess, surface: DenialSurface, opts: { matchGroup: boolean }): DenialAttachment {
    if (!this.running || proc.pid === undefined) {
      return { settle: () => Promise.resolve([]), snapshot: () => [], retarget: () => {} };
    }
    let finish!: () => void;
    const entry: Entry = {
      surface,
      pid: proc.pid,
      matchGroup: opts.matchGroup,
      denials: [],
      done: new Promise<void>((r) => { finish = r; }),
    };
    this.entries.add(entry);
    // After close, keep listening for the grace period: the log lags the process.
    proc.once("close", () => {
      setTimeout(() => {
        this.entries.delete(entry);
        finish();
      }, this.graceMs).unref();
    });
    return {
      settle: async () => {
        await entry.done;
        while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
        return groupDenials(entry.denials);
      },
      snapshot: () => groupDenials(entry.denials),
      retarget: (s) => { entry.surface = s; },
    };
  }

  /** One line of `log stream` output. Public so tests (and nothing else) can drive it. */
  feed(line: string): void {
    if (this.entries.size === 0) return;
    const d = parseDenialLine(line, this.now());
    if (!d) return;
    // Candidates are fixed now: a slow `ps` must not lose a denial to an entry
    // whose grace period ended while it ran.
    const candidates = [...this.entries];
    const exact = candidates.find((e) => e.pid === d.pid);
    if (exact) {
      this.record(exact, d, false);
      return;
    }
    const p: Promise<void> = this.attribute(d, candidates).finally(() => { this.pending.delete(p); });
    this.pending.add(p);
  }

  private async pgidOf(pid: number): Promise<number | null> {
    if (this.pgidCache.has(pid)) return this.pgidCache.get(pid) ?? null;
    const pgid = await (this.deps.psPgid ?? psPgid)(pid);
    if (this.pgidCache.size >= PGID_CACHE_MAX) this.pgidCache.clear();
    this.pgidCache.set(pid, pgid);
    return pgid;
  }

  private async attribute(d: SandboxDenial, candidates: Entry[]): Promise<void> {
    const pgid = await this.pgidOf(d.pid);
    if (pgid !== null) {
      // Alive, so it is knowable: ours if it sits in a watched group, otherwise
      // some other process's denial (a daemon) — not this command's business.
      const owner = candidates.find((e) => e.matchGroup && e.pid === pgid);
      if (owner) this.record(owner, d, false);
      return;
    }
    // Gone before we could ask (`touch` lives ~1 ms). Only a long-lived daemon
    // would have survived `ps`, so a short-lived stranger is almost certainly a
    // child of whatever is running now.
    const inFlight = candidates.filter((e) => e.matchGroup);
    if (inFlight.length === 1) {
      this.record(inFlight[0], d, true);
      return;
    }
    if (inFlight.length === 0) return;
    // Commands run one at a time in the foreground (agent.ts), so with several
    // surfaces attached the foreground Bash call is the likeliest.
    const bash = inFlight.filter((e) => e.surface.kind === "bash");
    if (bash.length === 1) this.record(bash[0], d, true);
    else this.emit(null, d, true);
  }

  private record(entry: Entry, d: SandboxDenial, probable: boolean): void {
    entry.denials.push(d);
    this.emit(entry.surface, d, probable);
  }

  private emit(surface: DenialSurface | null, d: SandboxDenial, probable: boolean): void {
    for (const fn of this.listeners) fn(surface, d, probable);
  }
}

export const denialReader = new DenialReader();
