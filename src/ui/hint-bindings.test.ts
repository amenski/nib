import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseTerminalInput } from "./hooks/useTerminalInput.js";

const src = (p: string) => readFileSync(join(process.cwd(), "src", p), "utf-8");

/**
 * The prompt placeholder and the posture segment advertise keyboard chords. A hint for a chord nothing handles
 * is worse than no hint — the user presses it, nothing happens, and they
 * distrust the rest of the bar.
 *
 * This caught two dead hints:
 *
 * - "^⇧P commands": a terminal sends byte 0x10 for BOTH ctrl+p and
 *   ctrl+shift+p — shift is not encoded in the legacy scheme — so the
 *   shift-qualified binding could never match. PromptInput also claims ctrl+p
 *   for history navigation before App's useInput would see it.
 * - "^M model" NEVER worked at all (an earlier version of this comment
 *   claimed it did): Ctrl+M is byte 0x0D — identical to Enter — consumed by
 *   the parser as `return` before ctrl detection. Pressing it SUBMITTED the
 *   prompt. The hint, the handler, and the default binding are all removed;
 *   the aliasing tests below keep the whole class out.
 */
describe("advertised chords are reachable", () => {
  it("cannot distinguish ctrl+p from ctrl+shift+p", () => {
    // The root cause, asserted directly: if this ever changes (e.g. the Kitty
    // keyboard protocol is adopted), a shift-qualified ctrl binding becomes
    // viable and the note in keybindings.ts should be revisited.
    const key = parseTerminalInput("\x10").keys[0];
    expect(key.ctrl).toBe(true);
    expect(key.value).toBe("p");
    expect(key.shift).toBe(false);
  });

  /** The empty-prompt placeholder, which is where the chords are advertised. */
  const placeholder = () => /placeholder="([^"]+)"/.exec(src("ui/App.tsx"))?.[1] ?? "";

  it("advertises ctrl+o and the slash menu in the prompt placeholder", () => {
    expect(placeholder()).toBe("Type your message… (/ commands · ⌃O mode)");
  });

  it("does not advertise the unreachable command palette chord", () => {
    // ctrl+p and ctrl+shift+p are the same byte; PromptInput owns ctrl+p.
    expect(placeholder()).not.toMatch(/(?:\^|⌃)⇧P/);
  });

  it("every posture segment in the status bar carries the (shift+tab) hint", () => {
    // buildStatusBar is a closure in main(), so assert on the source: auto, plan
    // and normal each append the shared postureHint.
    const cli = src("cli.tsx");
    expect(cli).toContain('" (shift+tab)"');
    expect(cli).toMatch(/\(colorEnabled \? `\\x1b\[1m[^`]*autoText[^`]*` : autoText\) \+ postureHint/);
    expect(cli).toContain("plan${postureHint}");
    expect(cli).toContain("normal${postureHint}");
  });

  it("byte-aliased chords can never arrive as ctrl combinations", () => {
    // Ctrl+M === Enter (0x0D) and Ctrl+I === Tab (0x09) at the byte level.
    // The parser rightly consumes them as return/tab, so any handler or hint
    // for ctrl+m / ctrl+i is dead on arrival.
    const cr = parseTerminalInput("\x0d").keys[0];
    expect(cr.return).toBe(true);
    expect(cr.ctrl).toBe(false);
    const tab = parseTerminalInput("\x09").keys[0];
    expect(tab.tab).toBe(true);
    expect(tab.ctrl).toBe(false);
  });

  it("advertises no byte-aliased chord in the placeholder", () => {
    // Covers both glyph conventions ("^X" and "⌃X").
    expect(placeholder()).not.toMatch(/(?:\^|⌃)(?:⇧)?[MI]\b/);
  });

  it("the mode-picker hint chord (ctrl+o) is encodable and routed to a handler", () => {
    // 0x0F is the classic terminal byte for ctrl+o — not aliased to Enter or
    // Tab. PromptInput owns the idle input wire, so it must be the one that
    // handles it (like the ⇧Tab posture cycle).
    const key = parseTerminalInput("\x0f").keys[0];
    expect(key.ctrl).toBe(true);
    expect(key.value).toBe("o");
    const prompt = src("ui/views/PromptInput.tsx");
    expect(/key\.ctrl && key\.value === "o"\s*\)\s*\{\s*onOpenModePicker\?\.\(\)/.test(prompt)).toBe(true);
  });
});
