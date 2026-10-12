import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render } from "ink-testing-library";
import FolderTrustPrompt from "./FolderTrustPrompt.js";
import { stripAnsi } from "../test-helpers.js";

const summary = { skills: [{}, {}], settingsKeys: [], hooks: [] } as any;
const flush = () => new Promise((r) => setTimeout(r, 30));

describe("FolderTrustPrompt (2026-10-12)", () => {
  it("offers exit, not per-item prompts, as the No choice", () => {
    const { lastFrame, unmount } = render(
      <FolderTrustPrompt projectDir="/Users/me" summary={summary} status="new" resolve={() => {}} />,
    );
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("No — exit");
    expect(frame).toContain("Esc exit");
    expect(frame).not.toContain("per item");
    unmount();
  });

  it.each([["Esc", "\x1b"], ["n", "n"]])("%s declines", async (_label, key) => {
    const resolve = vi.fn();
    const { stdin, unmount } = render(
      <FolderTrustPrompt projectDir="/Users/me" summary={summary} status="new" resolve={resolve} />,
    );
    await flush();
    stdin.write(key);
    await flush();
    expect(resolve).toHaveBeenCalledWith(false);
    unmount();
  });
});
