import type { Message } from "../../types.js";

/** Marker prefix used to detect (and dedupe) a skill already force-loaded into the conversation. */
export function skillLoadMarker(name: string): string {
  return `[skill: ${name}]`;
}

/** True when `history` already contains a user message force-loading `name`. */
export function isSkillAlreadyLoaded(history: Message[], name: string): boolean {
  const marker = skillLoadMarker(name);
  return history.some(
    (m) => m.role === "user" && typeof m.content === "string" && m.content.startsWith(marker),
  );
}

/** Build the user-role message that force-loads a skill's content into the conversation. */
export function buildSkillLoadMessage(name: string, content: string): Message {
  return {
    role: "user",
    content: `${skillLoadMarker(name)}\nThe user loaded this skill; follow its instructions for the rest of the conversation.\n\n${content}`,
  };
}

/**
 * The prompt that starts the turn a force-loaded skill runs in. `/skill` means
 * "start using this now" (skill-spec.md §7) — pushing the skill into history
 * alone left it inert until the user asked again, because no turn was running
 * for it to apply to.
 */
export const SKILL_APPLY_PROMPT =
  "Apply the skill you just loaded, following its instructions now.";

/**
 * The skill name in a `/skill <name>` command, or null when `input` is not
 * exactly that form. Requires whitespace after `skill`, so `/skills` (the list
 * command) and a bare `/skill` never match.
 */
export function parseSkillLoadCommand(input: string): string | null {
  const match = /^\/skill\s+(\S+)\s*$/.exec(input.trim());
  return match ? match[1] : null;
}
