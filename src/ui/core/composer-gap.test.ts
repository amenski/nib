import { describe, it, expect } from "vitest";
import { needsComposerGap } from "./composer-gap.js";

const base = { panelAbove: false, liveTail: false, lastOutputLine: undefined as string | undefined };

describe("needsComposerGap", () => {
  it("adds the margin when the last transcript line is text", () => {
    // A slash-command echo is the reported case: it commits no trailing blank,
    // so the prompt rule sat flush against it.
    expect(needsComposerGap({ ...base, lastOutputLine: "› /model" })).toBe(true);
  });

  it("adds no margin when the transcript already ends blank", () => {
    // A message echo and the turn footer both push a trailing "" — the margin
    // there is what produced two blank rows under "✳ Worked for Ns".
    expect(needsComposerGap({ ...base, lastOutputLine: "" })).toBe(false);
  });

  it("adds the margin on an empty transcript", () => {
    expect(needsComposerGap({ ...base, lastOutputLine: undefined })).toBe(true);
  });

  it("adds the margin when a panel sits above the composer", () => {
    expect(needsComposerGap({ ...base, panelAbove: true, lastOutputLine: "" })).toBe(true);
  });

  it("adds the margin while the live tail owns the last row", () => {
    expect(needsComposerGap({ ...base, liveTail: true, lastOutputLine: "" })).toBe(true);
  });
});
