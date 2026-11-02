import { describe, it, expect } from "vitest";
import { formatToolResultPreview, describeToolCall, formatStyledToolHeader, formatToolCallHeader, toolDisplayName, PREVIEW_LINE_MAX } from "./ToolCallFormatter.js";
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

describe("run_bash header drops the cd into the workspace (2026-11-02)", () => {
  const cwd = process.cwd();
  it("drops a cd into the workspace itself", () => {
    expect(describeToolCall("run_bash", { command: `cd ${cwd} && npm test` })).toBe("run_bash npm test");
    expect(describeToolCall("run_bash", { command: `cd ${cwd}/; npm test` })).toBe("run_bash npm test");
  });
  it("shortens a cd into a subfolder to its relative path", () => {
    expect(describeToolCall("run_bash", { command: `cd ${cwd}/frontend && grep -rn x src` })).toBe(
      "run_bash cd frontend && grep -rn x src",
    );
  });
  it("joins lines with '; ' so two commands never run together", () => {
    expect(describeToolCall("run_bash", { command: `cd ${cwd}/frontend\ngrep -rn x src` })).toBe(
      "run_bash cd frontend; grep -rn x src",
    );
  });
  it("keeps a cd outside the workspace", () => {
    expect(describeToolCall("run_bash", { command: "cd /tmp && ls" })).toBe("run_bash cd /tmp && ls");
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
    theme: { textDim: 246 },
    fg: (_c: number, s: string) => `[fg:${s}]`,
    bold: (_c: number | undefined, s: string) => `[bold:${s}]`,
  };

  it("draws the name in the terminal's own colour, so it reads on a light background", () => {
    // Regression (2026-10-11): the name was bold white (231), invisible on a
    // white terminal.
    const colours: Array<number | undefined> = [];
    formatStyledToolHeader(
      { ...theme, bold: (c: number | undefined, s: string) => (colours.push(c), s) },
      "run_bash",
      { command: "ls" },
    );
    expect(colours).toEqual([undefined]);
  });

  it("bolds the display name and dims the arguments", () => {
    const line = formatStyledToolHeader(theme, "run_bash", { command: "ls -la" });
    expect(line).toContain("[fg:⏺]");
    expect(line).toContain("[bold:Bash]");
    expect(line).toContain("[fg:(ls -la)]");
    expect(line).not.toContain("[bold:ls -la]");
  });

  it("colours the glyph by outcome: success, error, dim while unknown", () => {
    const colours: number[] = [];
    const spy = { ...theme, theme: { textDim: 246, success: 71, error: 204 }, fg: (c: number, s: string) => (colours.push(c), s) };
    formatStyledToolHeader(spy, "run_bash", { command: "ls" }, "ok");
    formatStyledToolHeader(spy, "run_bash", { command: "ls" }, "error");
    formatStyledToolHeader(spy, "run_bash", { command: "ls" });
    // First fg call per header is the glyph; the second dims the arguments.
    expect([colours[0], colours[2], colours[4]]).toEqual([71, 204, 246]);
    expect([colours[1], colours[3], colours[5]]).toEqual([246, 246, 246]);
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

describe("tool display names (2026-10-12)", () => {
  it("maps the newer tools to readable names", () => {
    expect(toolDisplayName("update_todo_list")).toBe("Update Todos");
    expect(toolDisplayName("run_bash_background")).toBe("Background");
    expect(toolDisplayName("check_job")).toBe("JobStatus");
    expect(toolDisplayName("kill_job")).toBe("KillJob");
    expect(toolDisplayName("web_fetch")).toBe("Fetch");
    expect(toolDisplayName("web_search")).toBe("WebSearch");
    expect(toolDisplayName("view_image")).toBe("ViewImage");
    expect(toolDisplayName("switch_mode")).toBe("Mode");
    expect(toolDisplayName("attempt_completion")).toBe("Done");
    expect(toolDisplayName("ask_user_question")).toBe("Ask");
  });

  it("shows an MCP tool as server · tool", () => {
    expect(toolDisplayName("mcp__github__create_issue")).toBe("github · create_issue");
  });

  it("never shows an unknown snake_case name raw", () => {
    expect(toolDisplayName("foo_bar")).toBe("FooBar");
  });

  it("keeps the header free of the raw name", () => {
    expect(formatToolCallHeader("update_todo_list", { todos: [] })).toBe("⏺ Update Todos");
    expect(formatToolCallHeader("run_bash_background", { command: "npm run dev" })).toBe("⏺ Background(npm run dev)");
  });
});
