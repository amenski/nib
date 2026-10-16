/**
 * Slash commands that only open a UI-only modal (a picker/overlay) — no model
 * call, no conversation-history mutation. These are safe to run over an
 * in-flight turn, so App must NOT queue them behind one: otherwise a
 * long-running or hung turn silently locks the user out of switching sessions,
 * models, themes, etc.
 */
const MODAL_COMMANDS = new Set([
  "model",
  "mode",
  "effort",
  "resume",
  "continue",
  "sessions",
  "skills",
  "modes",
  "undo",
  "mcp",
  "tasks",
  "jobs",
  "permissions",
  "usage",
  "help",
  // Read-only diagnostics, same shape as /help: prints and returns without
  // mutating session state, so it is safe to run without queueing behind an
  // active turn.
  "doctor",
  "context",
]);

/**
 * True when a submission opens a UI-only modal. Accepts either a bare command
 * name ("resume") or slash text ("/resume", "/permissions history"); matched on
 * the first token so args don't defeat the match.
 */
export function opensModal(nameOrSlash: string): boolean {
  const first = nameOrSlash.replace(/^\//, "").trim().split(/\s+/)[0];
  return MODAL_COMMANDS.has(first);
}
