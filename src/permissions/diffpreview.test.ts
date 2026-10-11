import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { previewEdit, DIFF_INDENT, type DiffTheme } from "./diffpreview.js";
import { ansiBg, ANSI_RESET } from "../ui/theme.js";
import { stripAnsi } from "../ui/test-helpers.js";

/**
 * The diff preview shown in the permission prompt before an edit is applied.
 *
 * It used to hard-code SGR 31/32 (bright red/green) regardless of the active
 * theme, and drew the body flush-left. It now paints the theme's diff
 * background slots and indents the body to sit under a tool result's `⎿`.
 */
const theme: DiffTheme = {
  colorEnabled: true,
  theme: { diffAddedBg: 22, diffRemovedBg: 52 },
};

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nib-diff-"));
  file = join(dir, "target.txt");
  writeFileSync(file, "alpha\nbeta\ngamma\n");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("previewEdit diff colouring (2026-10-11)", () => {
  it("paints removed lines with diffRemovedBg and added lines with diffAddedBg", () => {
    const out = previewEdit("edit", { path: file, oldString: "beta", newString: "BETA" }, theme)!;
    expect(out).toContain(`${ansiBg(theme.theme.diffRemovedBg)}${" ".repeat(DIFF_INDENT)}-beta${ANSI_RESET}`);
    expect(out).toContain(`${ansiBg(theme.theme.diffAddedBg)}${" ".repeat(DIFF_INDENT)}+BETA${ANSI_RESET}`);
    // The slots are distinct, so a reader can tell them apart at a glance.
    expect(theme.theme.diffAddedBg).not.toBe(theme.theme.diffRemovedBg);
  });

  it("does not paint the file headers as added/removed content", () => {
    const out = previewEdit("edit", { path: file, oldString: "beta", newString: "BETA" }, theme)!;
    // "--- path" / "+++ path" are headers: indented, but never backgrounded.
    const header = out.split("\n").find((l) => l.includes("+++"))!;
    expect(header.trim().startsWith("+++")).toBe(true);
    expect(header).not.toContain(ansiBg(22));
    expect(header).not.toContain(ansiBg(52));
  });

  it("indents every line to align under the ⎿ preview", () => {
    const out = previewEdit("edit", { path: file, oldString: "beta", newString: "BETA" }, theme)!;
    for (const line of out.split("\n").filter((l) => l !== "")) {
      // A painted line opens with its background escape, so strip first.
      expect(stripAnsi(line).startsWith(" ".repeat(DIFF_INDENT))).toBe(true);
    }
  });

  it("omits all escapes without a theme, keeping the diff readable as plain text", () => {
    const out = previewEdit("edit", { path: file, oldString: "beta", newString: "BETA" })!;
    expect(out).not.toContain("\x1b[");
    expect(out).toContain(`${" ".repeat(DIFF_INDENT)}-beta`);
    expect(out).toContain(`${" ".repeat(DIFF_INDENT)}+BETA`);
  });

  it("emits no escapes when colour is disabled", () => {
    const out = previewEdit(
      "edit",
      { path: file, oldString: "beta", newString: "BETA" },
      { ...theme, colorEnabled: false },
    )!;
    expect(out).not.toContain("\x1b[");
  });

  it("colours a write_to_file preview too", () => {
    const out = previewEdit("write_to_file", { path: file, content: "one\ntwo\n" }, theme)!;
    expect(out).toContain(ansiBg(52));
    expect(out).toContain(ansiBg(22));
    expect(out).toContain("+one");
  });

  it("returns null when the target file does not exist", () => {
    expect(previewEdit("edit", { path: join(dir, "missing.txt"), oldString: "a", newString: "b" }, theme)).toBeNull();
  });
});
