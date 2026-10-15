/**
 * Running a shell command outside the OS sandbox, the way Claude Code does:
 * the model may ask for it per call (`unsandboxed: true`, after the sandbox
 * blocked something) and the user may list commands that always run outside
 * it (`sandbox.excludedCommands`, e.g. `flutter`). Either way the call goes
 * through the normal permission flow; the session envelope grant never covers
 * it, because that grant is consent for the sandbox profile and this launch
 * has none.
 */

/** "requested": the model asked for it this call. "excluded": the user's list matched. */
export type UnsandboxedRun = "requested" | "excluded";

import { isSandboxedLevel, type SandboxLevel } from "./seatbelt.js";

let allowRequested = true;
let excluded: string[] = [];
let level: SandboxLevel | undefined;

/**
 * Startup options: the level shell children are sandboxed at (undefined = not
 * sandboxed, so nothing here applies) and the global-only
 * `sandbox.allowUnsandboxedCommands` (default on) and `sandbox.excludedCommands`
 * settings. An entry may end in `*` (`docker *`), which is dropped: matching is
 * by command prefix.
 */
export function configureUnsandboxed(opts: { sandboxLevel?: SandboxLevel; allowUnsandboxedCommands?: boolean; excludedCommands?: string[] }): void {
  level = isSandboxedLevel(opts.sandboxLevel) ? opts.sandboxLevel : undefined;
  allowRequested = opts.allowUnsandboxedCommands !== false;
  excluded = (opts.excludedCommands ?? []).map((e) => e.trim().replace(/\s*\*$/, "")).filter((e) => e !== "");
}

/**
 * Whether the model may ask for an unsandboxed run: the setting allows it and
 * the level is not `strict-sandbox`, which is read-only and has nothing to widen.
 */
export function unsandboxedRequestsAllowed(): boolean {
  return allowRequested && level !== "strict-sandbox";
}

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/;
// Anything that chains, backgrounds or substitutes another command: a prefix
// match must not smuggle a second command out of the sandbox.
const CHAINING = /[;&|`\n]|\$\(/;

/**
 * Whether `command` starts with one of the excluded commands. Leading
 * `VAR=value` assignments are skipped and `2>&1`-style fd redirects ignored; a
 * command that chains anything (`;`, `&&`, `|`, `$(…)`) never matches.
 */
export function isExcludedCommand(command: string): boolean {
  if (excluded.length === 0) return false;
  let c = command.trim().replace(/\d*>&\d+/g, "");
  if (CHAINING.test(c)) return false;
  while (ENV_ASSIGNMENT.test(c)) c = c.replace(ENV_ASSIGNMENT, "");
  return excluded.some((e) => c === e || c.startsWith(`${e} `));
}

/** How a shell tool call asks to leave the sandbox, if it does — undefined when its children are not sandboxed anyway. */
export function unsandboxedRun(tool: string, args: Record<string, unknown>): UnsandboxedRun | undefined {
  if (level === undefined) return undefined;
  if (tool !== "run_bash" && tool !== "run_bash_background") return undefined;
  if (args.unsandboxed === true) return "requested";
  return typeof args.command === "string" && isExcludedCommand(args.command) ? "excluded" : undefined;
}
