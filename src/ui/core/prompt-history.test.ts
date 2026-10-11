import { describe, it, expect } from "vitest";
import { seedPromptHistory } from "./prompt-history.js";
import type { Message } from "../../types.js";

const user = (content: string): Message => ({ role: "user", content });
const assistant = (content: string): Message => ({ role: "assistant", content });

describe("seedPromptHistory", () => {
  it("returns the user's own turns, oldest first", () => {
    const msgs: Message[] = [
      user("first question"),
      assistant("an answer"),
      user("second question"),
    ];
    expect(seedPromptHistory(msgs)).toEqual(["first question", "second question"]);
  });

  it("ignores assistant and tool messages", () => {
    const msgs: Message[] = [
      assistant("not mine"),
      { role: "tool", toolCallId: "t1", content: "tool output" },
      user("mine"),
    ];
    expect(seedPromptHistory(msgs)).toEqual(["mine"]);
  });

  it("drops the compaction summary the compactor injects as a user message", () => {
    const msgs: Message[] = [
      user("[Previous conversation summary]\nWe did some things."),
      user("real prompt"),
    ];
    expect(seedPromptHistory(msgs)).toEqual(["real prompt"]);
  });

  it("drops the persisted compaction overlay a resumed session starts with", () => {
    const msgs: Message[] = [
      user("[Earlier in this conversation]\nTask: ship it"),
      user("real prompt"),
    ];
    expect(seedPromptHistory(msgs)).toEqual(["real prompt"]);
  });

  it("drops a force-loaded skill body", () => {
    const msgs: Message[] = [
      user("[skill: commit]\nThe following skill was loaded…"),
      user("real prompt"),
    ];
    expect(seedPromptHistory(msgs)).toEqual(["real prompt"]);
  });

  it("drops the error-reflection nudge", () => {
    const msgs: Message[] = [
      user("Your read_file call failed: ENOENT. Try a different approach."),
      user("real prompt"),
    ];
    expect(seedPromptHistory(msgs)).toEqual(["real prompt"]);
  });

  it("collapses immediate duplicates but keeps non-adjacent repeats", () => {
    const msgs = [user("same"), user("same"), user("other"), user("same")];
    expect(seedPromptHistory(msgs)).toEqual(["same", "other", "same"]);
  });

  it("skips blank and whitespace-only turns", () => {
    const msgs = [user("   "), user(""), user("real")];
    expect(seedPromptHistory(msgs)).toEqual(["real"]);
  });

  it("handles an empty or missing conversation", () => {
    expect(seedPromptHistory([])).toEqual([]);
    expect(seedPromptHistory(undefined)).toEqual([]);
  });
});
