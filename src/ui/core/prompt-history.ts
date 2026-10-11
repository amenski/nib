import type { Message } from "../../types.js";

/**
 * Markers for `user`-role messages the app injected rather than the user
 * typing them. Pressing Up must never surface a compaction summary, a
 * force-loaded skill body, or a tool-failure nudge.
 *
 * Each pattern is matched against a real injection site:
 *   compaction summary  — compactor.ts / cli.tsx: "[Previous conversation summary]";
 *                         sessions/store.ts (resume overlay): "[Earlier in this conversation]"
 *   force-loaded skill  — ui/core/skill-load.ts:  "[skill: <name>]"
 *   error reflection    — selfreflection/index.ts: "Your <tool> call failed: …"
 */
const SYNTHETIC_USER_PATTERNS: RegExp[] = [
  /^\[Previous conversation summary\]/,
  /^\[Earlier in this conversation\]/,
  /^\[skill:/,
  /^Your \S+ call failed:/,
];

function isSyntheticUserMessage(content: string): boolean {
  const text = content.trimStart();
  return SYNTHETIC_USER_PATTERNS.some((p) => p.test(text));
}

/**
 * Build the initial ↑/↓ recall list from a restored conversation, so history
 * survives `--resume`. Returns the user's own turns, oldest first, with
 * injected/synthetic messages and immediate duplicates dropped.
 */
export function seedPromptHistory(messages: Message[] | undefined): string[] {
  if (!messages || messages.length === 0) return [];
  const out: string[] = [];
  for (const m of messages) {
    if (m.role !== "user") continue;
    const text = typeof m.content === "string" ? m.content.trim() : "";
    if (!text) continue;
    if (isSyntheticUserMessage(text)) continue;
    if (out[out.length - 1] === text) continue;
    out.push(text);
  }
  return out;
}
