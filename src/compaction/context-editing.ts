import type { Message } from "../types.js";
import { estimateTokens } from "./budget.js";

/** Anthropic's documented default for beginning request-time tool-result clearing. */
export const CONTEXT_EDITING_TRIGGER_TOKENS = 100_000;
export const RECENT_TOOL_RESULTS_TO_KEEP = 3;
export const CLEARED_TOOL_RESULT_PLACEHOLDER = "[Tool result cleared from provider context after it was consumed. The complete result remains in the local session transcript.]";

/**
 * Produces a provider-only view of history. It never mutates the local
 * transcript: the newest tool results remain complete, while old results are
 * replaced only after the assembled request reaches the editing threshold.
 */
export function editToolResultsForRequest(
  messages: Message[],
  overheadTokens = 0,
  freshToolResults: ReadonlySet<Message> = new Set(),
): Message[] {
  if (estimateTokens(messages) + overheadTokens < CONTEXT_EDITING_TRIGGER_TOKENS) {
    return messages;
  }

  const toolIndexes = messages.reduce<number[]>((indexes, message, index) => {
    if (message.role === "tool") indexes.push(index);
    return indexes;
  }, []);
  const consumedIndexes = toolIndexes.filter((index) => {
    const message = messages[index];
    return message.role === "tool" && !freshToolResults.has(message);
  });
  const preserved = new Set(consumedIndexes.slice(-RECENT_TOOL_RESULTS_TO_KEEP));
  if (consumedIndexes.length <= RECENT_TOOL_RESULTS_TO_KEEP) return messages;

  return messages.map((message, index) => (
    message.role === "tool" && !freshToolResults.has(message) && !preserved.has(index)
      ? { ...message, content: CLEARED_TOOL_RESULT_PLACEHOLDER }
      : message
  ));
}
