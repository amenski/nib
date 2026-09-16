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
