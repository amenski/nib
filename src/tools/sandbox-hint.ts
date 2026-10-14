import type { SandboxLevel } from "../sandbox/seatbelt.js";
import { isSandboxedLevel, sandboxAllowsBrowser } from "../sandbox/seatbelt.js";

/**
 * What a sandboxed shell command cannot do, said in advance so a model does not
 * spend a call discovering it. Byte-stable on purpose: it sits in the cached
 * prefix of every request (about 35 tokens), so it must never interpolate
 * anything. Measured 2026-10-10 — a session read a file under `$HOME` outside
 * the workspace with `cat … 2>/dev/null`, which hid the refusal and cost a
 * round trip before the model fell back to `read_file`.
 */
export const SANDBOX_TOOL_NOTE =
  "When the OS sandbox is active, commands cannot read files in your home directory outside the workspace or write outside it — use read_file, list_files or glob for those paths.";

/**
 * macOS reports a Seatbelt refusal as a plain EPERM, so the child's own output
 * says "Operation not permitted" and nothing else. Detected from the output
 * rather than inferred from the exit code, because a blocked command can still
 * exit 0 — `cat x || true`, or `2>/dev/null` — which is exactly how the case
 * that motivated this went unnoticed.
 */
const SANDBOX_BLOCKED = /Operation not permitted/;

/**
 * nib's own note for a blocked result. It is emitted OUTSIDE the untrusted-
 * content wrapper: that wrapper's contract is that everything inside it is text
 * a command produced, and this sentence is not.
 */
export const SANDBOX_BLOCKED_HINT =
  "[nib] The OS sandbox blocked that path. Files in your home directory outside the workspace can be read with read_file, list_files or glob — a shell command cannot reach them.";

/**
 * The note to append to a tool result, or "" when there is nothing to say: the
 * spawn was not sandboxed, or the sandbox refused nothing. Background jobs use
 * the same pair — the job carries whether it was sandboxed, so a note is never
 * added for a refusal an unsandboxed command genuinely hit.
 */
export function sandboxBlockedHint(output: string, sandboxed: boolean): string {
  if (!sandboxed) return "";
  // Checked first: a failed Chrome launch also prints "Operation not
  // permitted" (crashpad xattrs), and the path hint would mislead.
  if (BROWSER_LAUNCH_FAILED.test(output)) return sandboxAllowsBrowser() ? BROWSER_NESTED_SANDBOX_HINT : BROWSER_BLOCKED_HINT;
  return SANDBOX_BLOCKED.test(output) ? SANDBOX_BLOCKED_HINT : "";
}

/**
 * A browser that died at launch: Playwright's `browserType.launch`, Puppeteer's
 * "Failed to launch the browser process", or Chrome's own "Failed to initialize
 * sandbox". Measured 2026-10-14 (session 2026-10-14T0415-c93a): the model read
 * 17 such failures as flaky tests and reran them, and each launch put a macOS
 * crash dialog on screen.
 */
const BROWSER_LAUNCH_FAILED = /browserType\.launch|Failed to launch the browser process|Failed to initialize sandbox/;

/** The browser rules are off: the launch cannot succeed inside the sandbox. */
export const BROWSER_BLOCKED_HINT =
  "[nib] The OS sandbox stopped the browser from starting — rerunning will fail the same way and show the user a crash dialog each time. Do not rerun it. Tell the user browser tests need `\"sandbox\": { \"allowBrowser\": true }` in ~/.nib/settings.json, or that they can run them outside nib.";

/**
 * The browser rules are on, so the remaining cause is Chrome's own sandbox:
 * macOS refuses a nested sandbox_init.
 */
export const BROWSER_NESTED_SANDBOX_HINT =
  "[nib] The browser could not start its own sandbox inside nib's — macOS does not allow nesting. Launch it with its sandbox off (Playwright `chromiumSandbox: false`, Chrome `--no-sandbox`); nib's sandbox still contains it. Ask the user before changing their test configuration.";

/** Whether a sandbox level means the spawn actually runs under a profile. */
export function spawnWasSandboxed(level: SandboxLevel | undefined): boolean {
  return isSandboxedLevel(level);
}
