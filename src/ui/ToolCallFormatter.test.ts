import { describe, it, expect } from "vitest";
import { formatToolResultPreview, describeToolCall, formatStyledToolHeader, PREVIEW_LINE_MAX } from "./ToolCallFormatter.js";
import { wrapUntrusted } from "../tools/untrusted-content.js";

describe("formatToolResultPreview", () => {
  it("shows the payload first, not the untrusted-content marker", () => {
    const lines = formatToolResultPreview(wrapUntrusted("1: import x\n2: const y = 1"));
    expect(lines[0]).toBe("  ⎿  1: import x");
    expect(lines.join("\n")).not.toContain("BEGIN WEB CONTENT");
    expect(lines.join("\n")).not.toContain("END WEB CONTENT");
  });

  it("counts hidden lines without the marker lines", () => {
    const payload = Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n");
    const lines = formatToolResultPreview(wrapUntrusted(payload));
    // 10 payload lines, 3 shown → 7 hidden (the 2 marker lines are not counted).
    expect(lines.at(-1)).toBe("     … +7 lines");
  });

  it("handles labelled multi-block content (check_job report shape)", () => {
    const content = `stdout:\n${wrapUntrusted("ok")}\nstderr:\n${wrapUntrusted("warn")}`;
    const lines = formatToolResultPreview(content);
    expect(lines[0]).toBe("  ⎿  stdout:");
    expect(lines).toContain("     ok");
    expect(lines).toContain("     stderr:");
    expect(lines.join("\n")).not.toContain("BEGIN WEB CONTENT");
    expect(lines.join("\n")).not.toContain("END WEB CONTENT");
  });

  it("keeps status text placed after the END marker (web_search shape)", () => {
    const content = `${wrapUntrusted("result")}\nstatus: fallback used`;
    const lines = formatToolResultPreview(content, 10);
    expect(lines[0]).toBe("  ⎿  result");
    expect(lines).toContain("     status: fallback used");
  });

  it("passes unwrapped content through unchanged", () => {
    const lines = formatToolResultPreview("alpha\nbeta");
    expect(lines[0]).toBe("  ⎿  alpha");
    expect(lines).toContain("     beta");
  });

  it("caps a single enormous line", () => {
    // A preview renders as pre-styled text, which skips OutputArea's
    // progressive disclosure — so one minified-JSON line would otherwise print
    // thousands of columns.
    const lines = formatToolResultPreview("x".repeat(5000));
    const body = lines[0].replace(/^ {2}⎿ {2}/, "");
    expect(body.length).toBe(PREVIEW_LINE_MAX);
    expect(body.endsWith("…")).toBe(true);
  });

  it("leaves a line at the cap untouched", () => {
    const lines = formatToolResultPreview("y".repeat(PREVIEW_LINE_MAX));
    const body = lines[0].replace(/^ {2}⎿ {2}/, "");
    expect(body).toBe("y".repeat(PREVIEW_LINE_MAX));
    expect(body).not.toContain("…");
  });
});

describe("read_file range in the call description (2026-10-10)", () => {
  it("shows the last line actually read, not one past it", () => {
    expect(describeToolCall("read_file", { path: "/a/b.ts", offset: 4, limit: 3 })).toContain(":4-6");
  });
});

describe("styled tool header (2026-10-11)", () => {
  const theme = {
    colorEnabled: true,
    theme: { text: 231, textDim: 246 },
    fg: (_c: number, s: string) => `[fg:${s}]`,
    bold: (_c: number, s: string) => `[bold:${s}]`,
  };

  it("dims the glyph, bolds the display name, and leaves the args plain", () => {
    const line = formatStyledToolHeader(theme, "run_bash", { command: "ls -la" });
    expect(line).toContain("[fg:⏺]");
    expect(line).toContain("[bold:Bash]");
    expect(line).toContain("(ls -la)");
    // The arguments are NOT styled: they are shell text, shown as typed.
    expect(line).not.toContain("[bold:ls -la]");
  });

  it("shows the display name, not the raw tool id", () => {
    expect(formatStyledToolHeader(theme, "read_file", { path: "a.ts" })).toContain("Read");
    expect(formatStyledToolHeader(theme, "read_file", { path: "a.ts" })).not.toContain("read_file");
  });

  it("keeps a glob argument literal instead of letting markdown eat it", () => {
    // The header is drawn as styled text, so "**/*.ts" survives verbatim — it
    // used to be italicised away as an emphasis span.
    const line = formatStyledToolHeader(theme, "glob", { pattern: "**/*.ts" });
    expect(line).toContain("(**/*.ts)");
    expect(line).toContain("[bold:Glob]");
  });

  it("emits no escapes when colour is disabled", () => {
    const plain = formatStyledToolHeader({ ...theme, colorEnabled: false }, "run_bash", { command: "ls" });
    expect(plain).toBe("⏺ Bash(ls)");
  });
});
