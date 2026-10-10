import { describe, it, expect } from "vitest";
import { formatToolResultPreview, describeToolCall } from "./ToolCallFormatter.js";
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
});

describe("read_file range in the call description (2026-10-10)", () => {
  it("shows the last line actually read, not one past it", () => {
    expect(describeToolCall("read_file", { path: "/a/b.ts", offset: 4, limit: 3 })).toContain(":4-6");
  });
});
