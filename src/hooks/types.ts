/**
 * Lifecycle hooks (docs/hooks-spec.md): user-configured shell commands fired
 * on agent events. The full 15-event set, the dispatch map, and the exit-code
 * contract live in the spec — this file only carries the types.
 */

export const ALL_HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "PostToolUseFailure",
  "PostToolBatch",
  "PreCompact",
  "PostCompact",
  "MessageDisplay",
  "Notification",
  "Stop",
  "SubagentStart",
  "SubagentStop",
  "SessionEnd",
] as const;

export type HookEvent = (typeof ALL_HOOK_EVENTS)[number];

/** Events that carry a tool name and therefore accept a `matcher`. */
export const TOOL_EVENTS: readonly HookEvent[] = [
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "PostToolUseFailure",
];

/** Events whose stdout is appended to model context (hooks-spec.md §2) — it is
 *  wrapped in the untrusted-content delimiters (security-spec.md T12) before
 *  it can reach the model (fix 2). All other events' stdout is debug-log only. */
export const CONTEXT_STDOUT_EVENTS: readonly HookEvent[] = [
  "UserPromptSubmit",
  "PostToolUse",
  "PostToolUseFailure",
  "PreCompact",
];

/** Events where exit 2 (and an exit-0 `{decision: "deny"}`) blocks. */
export const BLOCKABLE_EVENTS: readonly HookEvent[] = [
  "UserPromptSubmit",
  "PreToolUse",
  "PermissionRequest",
];

export interface HookEntry {
  event: HookEvent;
  /** Single shell string, spawned via `/bin/sh -c` with cwd = project root. */
  command: string;
  /** Raw matcher string from config (tool events only); omitted = all tools. */
  matcher?: string;
  /**
   * Origin drives TOFU (hooks-spec.md §6): global (~/.nib) hooks are
   * trusted implicitly; project hooks must clear the trust store.
   */
  origin: "global" | "project";
  /**
   * Compiled matcher — undefined matches all tools. `*` → undefined;
   * `^[A-Za-z0-9_|,]+$` → exact-name list; anything else → unanchored regex
   * (invalid regex is a fail-fast config error, naming the entry).
   */
  matches?: (toolName: string) => boolean;
}

export interface HooksConfig {
  entries: HookEntry[];
  byEvent: Record<HookEvent, HookEntry[]>;
}
