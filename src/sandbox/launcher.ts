import type { SandboxLevel, SandboxSpawn } from "./seatbelt.js";
import { sandboxPrefix } from "./seatbelt.js";

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
 * Builds the executable/argv for a shell command. With no applicable OS
 * sandbox this preserves the existing direct `/bin/sh -c` behavior; when a
 * Seatbelt level applies, the same profile used by Bash/jobs is selected.
 */
export function prepareSandboxedShell(command: string, options: SandboxedShellOptions): SandboxSpawn {
  return sandboxPrefix(
    command,
    options.cwd,
    options.trustedRoot,
    options.sandboxLevel,
    options.writeRoots,
    options.sessionTempDir,
  ) ?? { file: "/bin/sh", args: ["-c", command] };
}

/**
 * Builds the executable/argv for a direct child command. This is used by
 * stdio MCP servers, where inserting a shell would change argv semantics and
 * create an unnecessary command-injection surface. The same Seatbelt profile
 * as shell children is retained when containment is active.
 */
export function prepareSandboxedCommand(
  command: string,
  args: string[],
  options: SandboxedShellOptions,
): SandboxSpawn {
  const shell = sandboxPrefix(
    "",
    options.cwd,
    options.trustedRoot,
    options.sandboxLevel,
    options.writeRoots,
    options.sessionTempDir,
  );
  if (!shell) return { file: command, args };

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
