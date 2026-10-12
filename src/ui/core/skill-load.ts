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
 * Hidden turn prompt for a bare `/skill <name>`: run the skill now (Claude Code
 * behaviour). The old "apply the skill" prompt let the model guess missing
 * inputs — in onramp it began the task loop on a guessed tracker file — so
 * this one tells it to ask instead.
 */
export const SKILL_START_PROMPT =
  "Start the skill you just loaded. If it needs input you don't have (a task, file, or target), ask me for it instead of guessing.";

/**
 * The skill name (and optional instruction) in a `/skill <name> [text]`
 * command, or null when `input` is not that form. Requires whitespace after
 * `skill`, so `/skills` (the list command) and a bare `/skill` never match.
 *
 * `text` is everything after the name, trimmed — the instruction to run with
 * (`/skill task-loop implement phase 1 from ~/…`). It used to be impossible to
 * give one in the same step, and `/skill <name>` started a turn on its own: in
 * onramp at 12:35:34 that hidden turn began the task loop on a guessed tracker
 * file 11 s before the user's real instruction arrived.
 */
export function parseSkillLoadCommand(input: string): { name: string; text: string } | null {
  const match = /^\/skill\s+(\S+)(?:\s+([\s\S]*))?$/.exec(input.trim());
  if (!match) return null;
  return { name: match[1], text: (match[2] ?? "").trim() };
}
