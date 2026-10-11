import React from "react";
import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import OutputArea from "./OutputArea.js";
import { buildReplayLines } from "./core/replay.js";
import { USER_ECHO_TAG, VERBATIM_TAG, BULLET_TAG, PROMPT_CHEVRON, ANSWER_BULLET } from "./constants.js";
import type { Message } from "../types.js";
import { stripAnsi } from "./test-helpers.js";
import { ThemeContextValue, DARK_THEME } from "./theme.js";

const noColor = new ThemeContextValue(DARK_THEME, false);

function frameOf(lines: string[]): string {
  // See trap #4 in test-helpers.ts: lastFrame() is a full composite of
  // Static content + live tail under ink-testing-library, so a containment
  // assertion against it works unchanged.
  const { lastFrame } = render(
    <OutputArea lines={lines} activeLine="" busy={false} staticEpoch={0} />,
  );
  return stripAnsi(lastFrame() ?? "");
}

/**
 * Regression coverage for the resume bug: a 1421-char message came back
 * truncated to ~300 chars with two contradictory-looking counters ("...
 * (1121 more chars)" and a separate "▼ 1421 chars" footer) and no way to
 * ever read the missing text. Progressive disclosure (needsSummary /
 * summarizeText) is right for a huge tool result streaming by mid-turn — the
 * model already saw the full text — but wrong for a resumed transcript,
 * which is the user's only view of their own prior messages.
 */
describe("OutputArea verbatim (replay) rendering", () => {
  it("renders a >1000-char replayed assistant message in full, with no 'more chars' marker", () => {
    const longText = "A".repeat(1400) + "END_OF_MESSAGE";
    const msgs: Message[] = [{ role: "assistant", content: longText }];
    const lines = buildReplayLines(msgs, noColor);
    const frame = frameOf(lines);
    // Terminal-width wrapping can insert a line break (and whitespace) into a
    // long unbroken run of chars — a rendering artifact, not evidence of
    // truncation — so also check the raw char count as direct proof nothing
    // was dropped.
    const collapsed = frame.replace(/\s/g, "");

    expect(collapsed).toContain("END_OF_MESSAGE");
    expect((frame.match(/A/g) ?? []).length).toBeGreaterThanOrEqual(1400);
    expect(frame).not.toContain("more chars");
  });

  it("renders a >20-line replayed assistant message in full, with no '(N lines)' collapse marker", () => {
    const bigBody = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n");
    const msgs: Message[] = [{ role: "assistant", content: bigBody }];
    const lines = buildReplayLines(msgs, noColor);
    const frame = frameOf(lines);

    expect(frame).toContain("line 29");
    expect(frame).not.toContain("(30 lines)");
  });

  it("renders a >1000-char replayed user message in full, with no 'more chars' marker", () => {
    const longText = "B".repeat(1400) + "END_OF_USER_MESSAGE";
    const msgs: Message[] = [{ role: "user", content: longText }];
    const lines = buildReplayLines(msgs, noColor);
    const rawFrame = frameOf(lines);
    // Terminal-width wrapping can insert a line break (and whitespace) into a
    // long unbroken run of chars, so strip ALL whitespace before checking for
    // the tail marker — the wrap is a rendering artifact, not evidence of
    // truncation. A count of the filler char across the whole frame is the
    // more direct proof that nothing was dropped.
    const collapsed = rawFrame.replace(/\s/g, "");

    expect(collapsed).toContain("END_OF_USER_MESSAGE");
    expect((rawFrame.match(/B/g) ?? []).length).toBeGreaterThanOrEqual(1400);
    expect(rawFrame).not.toContain("more chars");
    expect(rawFrame).not.toContain("more lines");
  });

  it("still draws the prompt glyph on a replayed user-echo line", () => {
    const msgs: Message[] = [{ role: "user", content: "fix the bug" }];
    const lines = buildReplayLines(msgs, noColor);
    expect(frameOf(lines)).toContain(`${PROMPT_CHEVRON} fix the bug`);
  });

  it("still draws the answer bullet on a replayed assistant line", () => {
    const msgs: Message[] = [{ role: "assistant", content: "Done." }];
    const lines = buildReplayLines(msgs, noColor);
    expect(frameOf(lines)).toContain(`${ANSWER_BULLET} Done.`);
  });

  it("draws the gutter AND keeps full text for a long replayed user message", () => {
    const longText = Array.from({ length: 5 }, (_, i) => `paragraph ${i} `.repeat(30)).join(
      "\n",
    );
    const msgs: Message[] = [{ role: "user", content: longText + "\nTAIL_MARKER" }];
    const lines = buildReplayLines(msgs, noColor);
    const rawFrame = frameOf(lines);
    const collapsed = rawFrame.replace(/\s/g, "");

    expect(rawFrame).toContain(PROMPT_CHEVRON);
    expect(collapsed).toContain("TAIL_MARKER");
    expect(rawFrame).not.toContain("more chars");
    expect(rawFrame).not.toContain("more lines");
  });

  it("load-bearing: VERBATIM_TAG is what exempts replay from summarization (sanity check on the tag itself)", () => {
    const longText = "C".repeat(1400);
    // Same content, but WITHOUT the verbatim tag — i.e. as live output would
    // carry it (through the USER_ECHO_TAG path only) — must still summarize.
    const untaggedFrame = frameOf([USER_ECHO_TAG + longText]);
    expect(untaggedFrame).toContain("more chars");

    // With VERBATIM_TAG prefixed ahead of USER_ECHO_TAG (replay's actual
    // composition), the same content must NOT summarize.
    const taggedFrame = frameOf([VERBATIM_TAG + USER_ECHO_TAG + longText]);
    expect(taggedFrame).not.toContain("more chars");
  });
});

/**
 * Guard against over-applying the verbatim exemption: ordinary LIVE output
 * (no VERBATIM_TAG) must keep summarizing exactly as before.
 */
describe("OutputArea live output still summarizes (unchanged behavior)", () => {
  it("still collapses a long non-replay line and reports a coherent size", () => {
    const longText = "D".repeat(1400);
    const frame = frameOf([longText]);

    expect(frame).not.toContain("D".repeat(1400));
    expect(frame).toContain("1400 chars");
  });

  it("still collapses a long non-replay bulleted assistant line", () => {
    const longText = "E".repeat(1400);
    const frame = frameOf([BULLET_TAG + longText]);
    expect(frame).not.toContain("E".repeat(1400));
    expect(frame).toContain("1400 chars");
  });

  it("still collapses a >20-line non-replay block", () => {
    const bigBody = Array.from({ length: 30 }, (_, i) => `row ${i}`).join("\n");
    const frame = frameOf([bigBody]);
    expect(frame).toContain("(30 lines)");
    expect(frame).not.toContain("row 15");
  });
});
