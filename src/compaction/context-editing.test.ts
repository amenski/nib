import { describe, expect, it } from "vitest";
import type { Message } from "../types.js";
import {
  CLEARED_TOOL_RESULT_PLACEHOLDER,
  CONTEXT_EDITING_TRIGGER_TOKENS,
  editToolResultsForRequest,
} from "./context-editing.js";

function toolUse(id: string, content: string): Message[] {
  return [
    { role: "assistant", content: null, toolCalls: [{ id, name: "read", arguments: {} }] },
    { role: "tool", toolCallId: id, toolName: "read", content },
  ];
}

describe("editToolResultsForRequest", () => {
  it("leaves requests below 100k estimated input tokens byte-for-byte unchanged", () => {
    const messages: Message[] = [
      { role: "user", content: "task" },
      ...toolUse("one", "x".repeat(399_000)),
      ...toolUse("two", "two output"),
      ...toolUse("three", "three output"),
      ...toolUse("four", "four output"),
    ];

    const edited = editToolResultsForRequest(messages);

    expect(CONTEXT_EDITING_TRIGGER_TOKENS).toBe(100_000);
    expect(edited).toBe(messages);
    expect(edited[2]).toEqual(messages[2]);
  });

  it("clears only old provider-copy tool results at 100k while keeping the newest three uses intact", () => {
    const messages: Message[] = [
      { role: "user", content: "task" },
      ...toolUse("one", "a".repeat(399_980)),
      ...toolUse("two", "two output"),
      ...toolUse("three", "three output"),
      ...toolUse("four", "four output"),
    ];

    const edited = editToolResultsForRequest(messages);

    expect(edited).not.toBe(messages);
    expect(edited[1]).toBe(messages[1]);
    expect(edited[2]).toEqual({
      role: "tool",
      toolCallId: "one",
      toolName: "read",
      content: CLEARED_TOOL_RESULT_PLACEHOLDER,
    });
    expect(edited.slice(3)).toEqual(messages.slice(3));
    expect(messages[2]).toEqual({ role: "tool", toolCallId: "one", toolName: "read", content: "a".repeat(399_980) });
  });

  it("protects every fresh result in a batch before keeping the newest three consumed results", () => {
    const messages: Message[] = [
      { role: "user", content: "task" },
      ...toolUse("one", "a".repeat(399_980)),
      ...toolUse("two", "two output"),
      ...toolUse("three", "three output"),
      ...toolUse("four", "four output"),
    ];
    const fresh = new Set(messages.filter((message) => message.role === "tool"));

    expect(editToolResultsForRequest(messages, 0, fresh)).toBe(messages);
    expect(editToolResultsForRequest(messages)[2]).toMatchObject({
      role: "tool",
      toolCallId: "one",
      content: CLEARED_TOOL_RESULT_PLACEHOLDER,
    });
  });

  it("preserves message order and assistant/tool pairing while clearing old results", () => {
    const messages: Message[] = [
      { role: "user", content: "task" },
      ...toolUse("one", "a".repeat(399_980)),
      ...toolUse("two", "two output"),
      ...toolUse("three", "three output"),
      ...toolUse("four", "four output"),
      ...toolUse("five", "five output"),
    ];

    const edited = editToolResultsForRequest(messages);

    // Same shape: nothing is dropped or reordered, only tool content changes.
    expect(edited).toHaveLength(messages.length);
    expect(edited.map((message) => message.role)).toEqual(messages.map((message) => message.role));

    // A tool result must stay glued to the assistant message whose toolCalls
    // requested it — a strict provider rejects an orphaned tool result.
    for (let i = 0; i < edited.length; i++) {
      const message = edited[i];
      if (message.role !== "tool") continue;
      const previous = edited[i - 1];
      expect(previous?.role).toBe("assistant");
      if (previous?.role === "assistant") {
        expect(previous.toolCalls?.map((call) => call.id)).toContain(message.toolCallId);
      }
    }

    // The assistant tool-call messages survive untouched, in place.
    const toolCallMessages = (history: Message[]) =>
      history.filter((message) => message.role === "assistant" && message.toolCalls);
    expect(toolCallMessages(edited)).toEqual(toolCallMessages(messages));

    expect(edited[2]).toMatchObject({ content: CLEARED_TOOL_RESULT_PLACEHOLDER });
    expect(edited[4]).toMatchObject({ content: CLEARED_TOOL_RESULT_PLACEHOLDER });
    expect(edited.slice(5)).toEqual(messages.slice(5));
  });
});
