import { describe, it, expect } from "vitest";
import { buildReplayLines } from "./replay.js";
import { USER_ECHO_TAG, VERBATIM_TAG, BULLET_TAG, ANSWER_CONT_TAG, TOOL_HEADER_TAG, TOOL_RESULT_TAG } from "../constants.js";
import type { Message } from "../../types.js";
import { stripAnsi } from "../test-helpers.js";
import { ThemeContextValue, DARK_THEME, ansiFg } from "../theme.js";

const noColor = new ThemeContextValue(DARK_THEME, false);
const withColor = new ThemeContextValue(DARK_THEME, true);

describe("buildReplayLines", () => {
  it("renders a user turn with the echo gutter tag", () => {
    const msgs: Message[] = [{ role: "user", content: "fix the bug" }];
    const lines = buildReplayLines(msgs, noColor);
    expect(lines).toContain(VERBATIM_TAG + USER_ECHO_TAG + "fix the bug");
  });

  it("tags assistant text as an answer block instead of a literal bullet glyph", () => {
    // A literal "● " prefix read as no answer block at all (OutputArea keys the
    // gutter off the tags) and defeated block-level markdown at the line start.
    const msgs: Message[] = [{ role: "assistant", content: "Done." }];
    const lines = buildReplayLines(msgs, noColor);
    expect(lines).toContain(VERBATIM_TAG + BULLET_TAG + "Done.");
    expect(lines.some((l) => l.includes("● "))).toBe(false);
  });

  it("tags every later line of a multi-line assistant message as a continuation", () => {
    const msgs: Message[] = [{ role: "assistant", content: "## Heading\n\nbody text" }];
    const lines = buildReplayLines(msgs, noColor);
    // The heading keeps its own markdown: a "● " prefix would break the anchor.
    expect(lines).toContain(VERBATIM_TAG + BULLET_TAG + "## Heading");
    expect(lines).toContain(VERBATIM_TAG + ANSWER_CONT_TAG + "body text");
  });

  it("renders a visible tool call and its result", () => {
    const msgs: Message[] = [
      {
        role: "assistant",
        content: null,
        toolCalls: [{ id: "c1", name: "run_bash", arguments: { command: "ls" } }],
      },
      { role: "tool", toolCallId: "c1", content: "file-a\nfile-b" },
    ];
    const lines = buildReplayLines(msgs, noColor).map(stripAnsi);
    expect(lines.some((l) => l.startsWith(VERBATIM_TAG + TOOL_HEADER_TAG + "⏺ Bash"))).toBe(true);
    expect(lines.some((l) => l.includes("file-a"))).toBe(true);
  });

  it("tags every non-blank line as verbatim so OutputArea never summarizes replay", () => {
    const msgs: Message[] = [
      { role: "user", content: "fix the bug" },
      { role: "assistant", content: "Done." },
    ];
    const lines = buildReplayLines(msgs, noColor);
    const nonBlank = lines.filter((l) => l !== "");
    expect(nonBlank.length).toBeGreaterThan(0);
    expect(nonBlank.every((l) => l.startsWith(VERBATIM_TAG))).toBe(true);
  });

  it("suppresses silent (read-only) tool calls AND their results", () => {
    const msgs: Message[] = [
      {
        role: "assistant",
        content: null,
        toolCalls: [{ id: "r1", name: "read_file", arguments: { path: "/x" } }],
      },
      { role: "tool", toolCallId: "r1", content: "secret file body" },
    ];
    const lines = buildReplayLines(msgs, noColor).map(stripAnsi);
    expect(lines.some((l) => l.includes("secret file body"))).toBe(false);
    expect(lines.some((l) => l.includes("Read"))).toBe(false);
  });

  it("shows a compaction summary dimmed and skips the per-turn system prompt", () => {
    const msgs: Message[] = [
      { role: "system", content: "You are a helpful agent. (per-turn prompt)" },
      { role: "user", content: "[Previous conversation summary]\nDid X and Y." },
      { role: "user", content: "now do Z" },
    ];
    const lines = buildReplayLines(msgs, noColor);
    // per-turn system prompt is not surfaced
    expect(lines.some((l) => l.includes("per-turn prompt"))).toBe(false);
    // summary is surfaced
    expect(lines.some((l) => l.includes("Did X and Y."))).toBe(true);
    // real user turn keeps its gutter
    expect(lines).toContain(VERBATIM_TAG + USER_ECHO_TAG + "now do Z");
  });

  it("shows a persisted compaction overlay dimmed, not as a highlighted user echo", () => {
    // sessions/store.ts stores the resume overlay as a user message headed
    // "[Earlier in this conversation]". Unrecognised, it was drawn as the
    // user's own prompt: a screenful of highlighted text on every resume.
    const msgs: Message[] = [
      { role: "user", content: "[Earlier in this conversation]\nTask: ship it\n\nDecisions:\n- use X" },
      { role: "user", content: "now do Z" },
    ];
    const lines = buildReplayLines(msgs, withColor);
    const summary = lines.find((l) => l.includes("Task: ship it"));
    expect(summary).toBeDefined();
    expect(summary!.includes(USER_ECHO_TAG)).toBe(false);
    expect(summary).toContain(ansiFg(DARK_THEME.textDim));
    expect(lines).toContain(VERBATIM_TAG + USER_ECHO_TAG + "now do Z");
  });

  it("tags tool headers and previews so a resumed transcript keeps its indentation", () => {
    // The whole point of replay is that a resumed transcript is
    // indistinguishable from one that just streamed. Untagged, a preview line
    // went through the markdown renderer, which drops a run of spaces at the
    // start of a row — so the "     " gutter and the payload's own indent
    // vanished here while the same output streamed live kept them.
    const msgs: Message[] = [
      {
        role: "assistant",
        content: null,
        toolCalls: [{ id: "c1", name: "run_bash", arguments: { command: "ls" } }],
      },
      { role: "tool", toolCallId: "c1", content: "head\n      const x = 1;" },
    ];
    const lines = buildReplayLines(msgs, noColor);

    // The header carries the tag (behind VERBATIM_TAG, which is outermost).
    expect(lines).toContain(VERBATIM_TAG + TOOL_HEADER_TAG + "⏺ Bash(ls)");
    // So does every preview line — the opener, the indented payload, the rest.
    const preview = lines.find((l) => l.includes("head"));
    expect(preview).toBe(VERBATIM_TAG + TOOL_RESULT_TAG + "  ⎿  head");
    expect(lines).toContain(VERBATIM_TAG + TOOL_RESULT_TAG + "           const x = 1;");
  });

  it("keeps an error preview's colour under the tag", () => {
    // The tag is prepended, not substituted: an error result must stay red.
    const msgs: Message[] = [
      {
        role: "assistant",
        content: null,
        toolCalls: [{ id: "c1", name: "run_bash", arguments: { command: "boom" } }],
      },
      { role: "tool", toolCallId: "c1", content: "COMMAND_FAILED: nope" },
    ];
    const lines = buildReplayLines(msgs, withColor);
    const line = lines.find((l) => l.includes("nope"));
    expect(line?.startsWith(VERBATIM_TAG + TOOL_RESULT_TAG)).toBe(true);
    expect(line).toContain(ansiFg(DARK_THEME.error));
  });

  it("marks permission-denied tool results as errors (theme error colour) when color is on", () => {
    const msgs: Message[] = [
      {
        role: "assistant",
        content: null,
        toolCalls: [{ id: "c1", name: "run_bash", arguments: { command: "rm -rf /" } }],
      },
      { role: "tool", toolCallId: "c1", content: "PERMISSION_DENIED: nope" },
    ];
    const lines = buildReplayLines(msgs, withColor);
    expect(lines.some((l) => l.includes(ansiFg(DARK_THEME.error)) && l.includes("nope"))).toBe(true);
  });

  describe("header dot colour follows the call's outcome", () => {
    const call = (id: string, command: string): Message => ({
      role: "assistant",
      content: null,
      toolCalls: [{ id, name: "run_bash", arguments: { command } }],
    });
    const dotOf = (lines: string[], command: string): string => {
      const header = lines.find((l) => stripAnsi(l).includes(`Bash(${command})`));
      expect(header).toBeDefined();
      // The escape in front of the first glyph is the dot's colour.
      return header!.match(/(\x1b\[[0-9;]*m)⏺/)![1]!;
    };

    it("is success-coloured when the result succeeded, error-coloured when it failed", () => {
      const lines = buildReplayLines(
        [
          call("a", "good"),
          { role: "tool", toolCallId: "a", content: "fine" },
          call("b", "bad"),
          { role: "tool", toolCallId: "b", content: "COMMAND_FAILED: no" },
          call("c", "denied"),
          { role: "tool", toolCallId: "c", content: "PERMISSION_DENIED: no" },
        ],
        withColor,
      );
      expect(dotOf(lines, "good")).toBe(ansiFg(DARK_THEME.success));
      expect(dotOf(lines, "bad")).toBe(ansiFg(DARK_THEME.error));
      expect(dotOf(lines, "denied")).toBe(ansiFg(DARK_THEME.error));
    });

    it("stays dim for a call that never got a result (killed mid-turn)", () => {
      const lines = buildReplayLines([call("a", "orphan")], withColor);
      expect(dotOf(lines, "orphan")).toBe(ansiFg(DARK_THEME.textDim));
    });

    it("pairs each header with its own result when several calls share one reply", () => {
      const lines = buildReplayLines(
        [
          {
            role: "assistant",
            content: null,
            toolCalls: [
              { id: "x", name: "run_bash", arguments: { command: "first" } },
              { id: "y", name: "run_bash", arguments: { command: "second" } },
            ],
          },
          { role: "tool", toolCallId: "x", content: "COMMAND_FAILED: no" },
          { role: "tool", toolCallId: "y", content: "fine" },
        ],
        withColor,
      );
      expect(dotOf(lines, "first")).toBe(ansiFg(DARK_THEME.error));
      expect(dotOf(lines, "second")).toBe(ansiFg(DARK_THEME.success));
    });

    it("keeps the dot plain when colour is off", () => {
      const lines = buildReplayLines([call("a", "ls"), { role: "tool", toolCallId: "a", content: "fine" }], noColor);
      expect(lines).toContain(VERBATIM_TAG + TOOL_HEADER_TAG + "⏺ Bash(ls)");
    });
  });

  it("puts exactly one blank row between blocks, as the live view does", () => {
    // Live (App.tsx blockGap/commitText): one blank between an answer and the
    // next tool call, and between a tool's output and the answer after it.
    const msgs: Message[] = [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "Removing it.",
        toolCalls: [{ id: "c1", name: "run_bash", arguments: { command: "echo hi" } }],
      },
      { role: "tool", toolCallId: "c1", content: "tool-out" },
      { role: "assistant", content: "Design is built." },
    ];
    const rows = buildReplayLines(msgs, noColor).map(stripAnsi);
    const at = (needle: string) => rows.findIndex((r) => r.includes(needle));
    expect(rows.slice(at("Removing it.") + 1, at("Bash(echo hi)"))).toEqual([""]);
    expect(rows.slice(at("tool-out") + 1, at("Design is built."))).toEqual([""]);
    // Never two blank rows in a row anywhere.
    expect(rows.some((r, i) => r === "" && rows[i + 1] === "")).toBe(false);
  });
});

