import { describe, it, expect } from "vitest";
import { BROWSER_BLOCKED_HINT, BROWSER_NESTED_SANDBOX_HINT, SANDBOX_BLOCKED_HINT, SANDBOX_TOOL_NOTE, sandboxBlockedHint } from "./sandbox-hint.js";
import { configureSandbox } from "../sandbox/seatbelt.js";

describe("sandboxBlockedHint", () => {
  it("notes a refusal from a sandboxed command", () => {
    expect(sandboxBlockedHint("cat: /Users/x/notes.txt: Operation not permitted\n", true)).toBe(SANDBOX_BLOCKED_HINT);
  });

  it("says nothing when the spawn was not sandboxed", () => {
    // The same errno from an ordinary command is not the sandbox's doing, and
    // claiming it was would send the model looking for a containment story.
    expect(sandboxBlockedHint("rm: /x: Operation not permitted", false)).toBe("");
  });

  it("says nothing when a sandboxed command was not refused", () => {
    expect(sandboxBlockedHint("hello\nExit code: 0", true)).toBe("");
  });

  it("notes a refusal on a command that still exited 0", () => {
    // `cat x || true` and `cat x 2>/dev/null` both hide a refusal from the exit
    // code — the second is how the case that motivated this went unnoticed.
    expect(sandboxBlockedHint("Exit code: 0\nok", true)).toBe("");
    expect(sandboxBlockedHint("cat: /Users/x/f: Operation not permitted\nExit code: 0", true)).toBe(
      SANDBOX_BLOCKED_HINT,
    );
  });

  it("keeps the tool note byte-stable and free of interpolation", () => {
    // It rides in the cached prefix of every request, so any per-call variation
    // would invalidate the cache from that message onward.
    expect(SANDBOX_TOOL_NOTE).toContain("unsandboxed: true");
    expect(SANDBOX_TOOL_NOTE).not.toMatch(/\$\{/);
    expect(SANDBOX_TOOL_NOTE.endsWith(".")).toBe(true);
  });
});

describe("sandboxBlockedHint: browser launches", () => {
  // Trimmed from the session that motivated this (2026-10-14T0415-c93a).
  const playwright =
    "✖ renders a one-slide wall of text\n  browserType.launch: Target page, context or browser has been closed\n" +
    "  setxattr ... Crashpad: Operation not permitted (1)\n  exception while trying to kill process: Error: kill EPERM";

  it("names the browser setting, not the path hint, when the user turned the rules off", () => {
    configureSandbox({ allowBrowser: false });
    try {
      expect(sandboxBlockedHint(playwright, true)).toBe(BROWSER_BLOCKED_HINT);
      expect(sandboxBlockedHint("Error: Failed to launch the browser process!", true)).toBe(BROWSER_BLOCKED_HINT);
    } finally {
      configureSandbox({});
    }
  });

  it.skipIf(process.platform !== "darwin")("points at Chrome's own sandbox when the rules are on", () => {
    configureSandbox({});
    try {
      expect(sandboxBlockedHint("Failed to initialize sandbox.", true)).toBe(BROWSER_NESTED_SANDBOX_HINT);
    } finally {
      configureSandbox({});
    }
  });

  it("says nothing for an unsandboxed launch failure", () => {
    expect(sandboxBlockedHint(playwright, false)).toBe("");
  });
});
