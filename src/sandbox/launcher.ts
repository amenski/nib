import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import type { SandboxLevel, SandboxSpawn } from "./seatbelt.js";
import { sandboxPrefix } from "./seatbelt.js";

/**
 * The containment-readiness protocol (docs/permission-ux-redesign.md).
 *
 * A Seatbelt profile that fails to apply must not be mistaken for an ordinary
 * command failure — today `sandbox-exec` exits non-zero and prints to stderr,
 * which is indistinguishable from the command's own output. The fix is a
 * trusted step *inside* the applied profile: a fixed shell frame writes one
 * byte on fd 3 and only then becomes the real command. The byte can therefore
 * arrive only if the profile applied.
 *
 * The frame is authored text, never interpolated with the command — the
 * command stays an argv element. That matters twice over: the command cannot
 * break the frame's syntax (a parse error in a concatenated prefix would make
 * the frame never run, which would read as a containment failure for a
 * perfectly valid command), and `exec "$@"` reproduces the target's argv,
 * environment, cwd and PID exactly.
 *
 * `exec 3>&-` before the exec is what makes the pipe unforgeable and
 * unretainable: the frame closes it, so the target process is never handed a
 * descriptor it could write to in order to fake a readiness signal.
 *
 * The byte is written *before* `exec`, which is why a missing target binary
 * still reports readiness and then fails normally — a broken MCP server path
 * is not misreported as a sandbox failure.
 */
const READINESS_FD = 3;
const READINESS_FRAME = `printf '\\001' >&${READINESS_FD}; exec ${READINESS_FD}>&-; exec "$@"`;
/** `$0` for the frame, so its own diagnostics are attributable in stderr. */
const READINESS_ARGV0 = "nib-readiness";

/**
 * How long the frame gets to signal. It does no work beyond a single write, so
 * this only has to cover process start and profile application; it is
 * deliberately far shorter than any command timeout, and a launch that misses
 * it is treated as unconfirmed containment rather than as a slow command.
 */
const READINESS_TIMEOUT_MS = 5_000;

/** The result of waiting for a contained child's readiness signal. */
export type ReadinessOutcome =
  | { ready: true }
  | {
      ready: false;
      reason: "spawn-error" | "exited-before-ready" | "timeout";
      detail: string;
    };

export interface ContainedSpawn {
  proc: ChildProcess;
  /**
   * Settles exactly once and never rejects. Missing readiness is an outcome to
   * be reported, not an exception to be thrown.
   */
  readiness: Promise<ReadinessOutcome>;
}

/** Streams the caller needs on the framed child, beyond the readiness pipe. */
export interface ContainedStdio {
  /** `"pipe"` for surfaces that feed the child (hooks, stdio MCP servers). */
  stdin?: "ignore" | "pipe";
  /** `"ignore"` for fire-and-forget surfaces, which must not own an undrained pipe. */
  stdout?: "pipe" | "ignore";
  stderr?: "pipe" | "ignore";
}

export interface ContainedSpawnOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv | Record<string, string>;
  detached?: boolean;
  /**
   * Defaults preserve the run_bash shape: stdin ignored, both output streams
   * piped for the caller to read. The readiness pipe is always added on fd 3.
   */
  stdio?: ContainedStdio;
}

/** Inputs shared by child-process surfaces that execute a shell command. */
export interface SandboxedShellOptions {
  cwd: string;
  /** Session workspace root used as the fixed Seatbelt write boundary. */
  trustedRoot: string;
  sandboxLevel?: SandboxLevel;
  writeRoots?: string[];
  sessionTempDir?: string;
}

/**
 * Builds the executable/argv for a shell command, or null when no OS sandbox
 * applies to this run — in which case the caller spawns directly and there is
 * no containment to confirm. When a Seatbelt level does apply, the same profile
 * used by Bash/jobs is selected.
 */
export function prepareSandboxedShell(command: string, options: SandboxedShellOptions): SandboxSpawn | null {
  return sandboxPrefix(
    command,
    options.cwd,
    options.trustedRoot,
    options.sandboxLevel,
    options.writeRoots,
    options.sessionTempDir,
  );
}

/**
 * Builds the executable/argv for a direct child command, or null when no OS
 * sandbox applies. This is used by stdio MCP servers, where inserting a shell
 * would change argv semantics and create an unnecessary command-injection
 * surface. The same Seatbelt profile as shell children is retained when
 * containment is active.
 */
export function prepareSandboxedCommand(
  command: string,
  args: string[],
  options: SandboxedShellOptions,
): SandboxSpawn | null {
  const shell = sandboxPrefix(
    "",
    options.cwd,
    options.trustedRoot,
    options.sandboxLevel,
    options.writeRoots,
    options.sessionTempDir,
  );
  if (!shell) return null;

  // sandboxPrefix emits [sandbox-exec, -p, profile, /bin/sh, -c, command].
  // Keep only the first two args (`-p <profile>`) — everything from `/bin/sh`
  // on is the shell form and must be dropped, or the child runs as
  // `sh <command> <args>` and an interpreted script is read as a shell script
  // instead of being executed (measured 2026-09-16: a contained stdio MCP
  // server died with "cannot execute binary file"). Then run the requested
  // executable directly so its configured argv is byte-for-byte preserved.
  return { file: shell.file, args: shell.args.slice(0, 2).concat(command, args) };
}

/** Minimal child environment plus the private session scratch directory. */
export function buildChildEnvironment(sessionTempDir?: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ["PATH", "HOME", "TERM"] as const) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  if (sessionTempDir) {
    env.TMPDIR = sessionTempDir;
    env.TMP = sessionTempDir;
    env.TEMP = sessionTempDir;
    env.npm_config_cache = `${sessionTempDir}/npm-cache`;
  }
  return env;
}

/**
 * Spawns a contained child and reports whether the profile was confirmed
 * inside it. The one place a Seatbelt-wrapped child is started, so Bash,
 * background jobs, MCP servers, hooks, the statusline and notifications all
 * get the same launch and the same failure behavior.
 *
 * `prefix` is the {@link sandboxPrefix} output — `[sandbox-exec, -p, profile,
 * …]` — and `target` is the argv to run inside it. When `prefix` is null there
 * is no containment to confirm, so the readiness promise resolves ready and
 * the child is spawned without the frame, exactly as before.
 */
export function spawnContained(
  prefix: SandboxSpawn | null,
  target: string[],
  options: ContainedSpawnOptions,
): ContainedSpawn {
  const stdio: Array<"ignore" | "pipe"> = [
    options.stdio?.stdin ?? "ignore",
    options.stdio?.stdout ?? "pipe",
    options.stdio?.stderr ?? "pipe",
  ];
  if (!prefix) {
    const proc = spawn(target[0]!, target.slice(1), {
      cwd: options.cwd,
      detached: options.detached,
      stdio,
      env: options.env,
    });
    return { proc, readiness: Promise.resolve({ ready: true }) };
  }

  // Keep only `-p <profile>`; everything from `/bin/sh` on is the shell form
  // this function replaces. Same convention as prepareSandboxedCommand.
  const argv = [
    ...prefix.args.slice(0, 2),
    "/bin/sh",
    "-c",
    READINESS_FRAME,
    READINESS_ARGV0,
    ...target,
  ];
  const proc = spawn(prefix.file, argv, {
    cwd: options.cwd,
    detached: options.detached,
    stdio: [...stdio, "pipe"],
    env: options.env,
  });
  return { proc, readiness: readReadiness(proc) };
}

/**
 * Hands a contained child to the OS so it cannot hold the parent's event loop
 * open (notifications are fire-and-forget). The process handle alone is not
 * enough: the readiness pipe is a stream of its own with its own handle, so it
 * is unref'd too.
 */
export function unrefContained(contained: ContainedSpawn): void {
  contained.proc.unref();
  for (const stream of contained.proc.stdio) {
    // The declared stdio type does not carry unref, but every pipe Node
    // creates here is a Socket, which has it. "ignore" streams are null.
    (stream as { unref?: () => void } | null)?.unref?.();
  }
}

/**
 * Waits for the fd-3 readiness byte, or for evidence it will never arrive.
 * Exported for its own test: the timeout watchdog is what keeps a launcher that
 * neither signals nor exits from holding a Bash call open forever (the command
 * timeout cannot settle an outcome whose readiness was never established), and
 * no real fixture on a capable runner can produce that hang.
 */
export function readReadiness(proc: ChildProcess): Promise<ReadinessOutcome> {
  return new Promise((resolve) => {
    const pipe = proc.stdio[READINESS_FD];
    if (!pipe) {
      // No pipe means the spawn itself never produced the stdio we asked for.
      resolve({ ready: false, reason: "spawn-error", detail: "the readiness pipe was not created" });
      return;
    }
    let settled = false;
    const finish = (outcome: ReadinessOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      pipe.removeListener("data", onData);
      proc.removeListener("close", onClose);
      proc.removeListener("error", onError);
      resolve(outcome);
    };
    // The byte's value carries no meaning — the pipe is private to this child,
    // so *any* byte on it is the signal. Which byte arrives is not a channel.
    const onData = (): void => finish({ ready: true });
    const onClose = (code: number | null): void =>
      finish({
        ready: false,
        reason: "exited-before-ready",
        detail: `the sandboxed launcher exited with code ${code} before signalling readiness`,
      });
    const onError = (err: Error): void =>
      finish({ ready: false, reason: "spawn-error", detail: err.message });
    const timer = setTimeout(
      () =>
        finish({
          ready: false,
          reason: "timeout",
          detail: `no readiness signal within ${READINESS_TIMEOUT_MS}ms`,
        }),
      READINESS_TIMEOUT_MS,
    );
    pipe.on("data", onData);
    proc.on("close", onClose);
    proc.on("error", onError);
  });
}

/**
 * The user-facing text for unconfirmed containment. Deliberately explicit that
 * the command did not run and that nothing was retried outside the sandbox:
 * the failure a user must never be able to misread is "the sandbox was
 * probably fine, the command just failed".
 *
 * The raw `sandbox-exec` stderr is supplementary detail, never the evidence —
 * the missing signal is.
 */
export function containmentFailureError(outcome: Extract<ReadinessOutcome, { ready: false }>): string {
  return `SANDBOX_NOT_APPLIED: the macOS sandbox profile was not confirmed inside the child (${outcome.detail}), so this command was not run and no unsandboxed retry was attempted.`;
}

/**
 * Why a launch's containment promise did not hold. Both are reported to the
 * agent gate, which revokes any session grant covering the call and records the
 * reason — a grant approved against a profile that this machine refuses to
 * apply, or that no longer describes the launch, has no business outliving it.
 *
 * - `containment-not-applied`: the child never confirmed its profile.
 * - `envelope-changed`: the profile this launch would run under is not the one
 *   the grant was approved against (a write root, the level, or the scratch
 *   directory changed after consent).
 */
export type SandboxFailureReason = "containment-not-applied" | "envelope-changed";
