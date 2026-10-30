import React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render } from "ink-testing-library";
import StatusBar from "./StatusBar.js";
import { ThemeProvider, TerminalProvider } from "./contexts.js";
import { stripAnsi as strip } from "./test-helpers.js";
import type { GitStatus } from "./types.js";

const SEGMENTS = [
  { id: "1", text: "● Code", raw: true },
  { id: "2", text: "▸▸ auto", raw: true },
  { id: "3", text: "ctx ━━━━── 1%", raw: true, dimColor: true },
  { id: "4", text: "thinking high", dimColor: true, align: "right" as const },
  { id: "5", text: "deepseek/DeepSeek V4.1 Flash", dimColor: true, align: "right" as const },
];

const GIT: GitStatus = {
  branch: "main", dirty: false, modified: 0, added: 0, deleted: 0, staged: 0, conflicts: 0, ahead: 0, behind: 0,
} as GitStatus;

const originalColumns = process.stdout.columns;

afterEach(() => {
  Object.defineProperty(process.stdout, "columns", { value: originalColumns, configurable: true });
});

function renderBar(columns: number, ui: React.ReactElement) {
  Object.defineProperty(process.stdout, "columns", { value: columns, configurable: true });
  return render(
    <ThemeProvider config={{ colorEnabled: false }}>
      <TerminalProvider>{ui}</TerminalProvider>
    </ThemeProvider>,
  );
}

const frameOf = (r: { lastFrame: () => string | undefined }) => strip(r.lastFrame() ?? "");

describe("StatusBar two-group layout", () => {
  it("puts the right group flush right with a gap of at least 2", () => {
    const frame = frameOf(renderBar(100, <StatusBar segments={SEGMENTS} gitStatus={GIT} />));
    const row = frame.split("\n")[0];
    // Right edge is columns - 1.
    expect(row.length).toBe(99);
    expect(row.endsWith("thinking high · deepseek/DeepSeek V4.1 Flash")).toBe(true);
    const leftEnd = row.indexOf("main") + "main".length;
    const rightStart = row.indexOf("thinking high");
    expect(rightStart - leftEnd).toBeGreaterThanOrEqual(2);
  });

  it("keeps the left group in order: mode, posture, ctx, git, jobs", () => {
    const row = frameOf(renderBar(100, <StatusBar segments={SEGMENTS} gitStatus={GIT} runningJobs={2} />));
    const order = ["Code", "auto", "ctx", "main", "2 jobs", "thinking high"].map((s) => row.indexOf(s));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("drops the right group first on a narrow terminal", () => {
    const row = frameOf(renderBar(50, <StatusBar segments={SEGMENTS} gitStatus={GIT} />));
    expect(row).not.toContain("thinking");
    expect(row).not.toContain("DeepSeek");
    expect(row).toContain("Code");
    expect(row).toContain("auto");
    expect(row).toContain("ctx");
  });

  it("falls back to single-line truncation once the left group does not fit", () => {
    const row = frameOf(renderBar(22, <StatusBar segments={SEGMENTS} gitStatus={GIT} />));
    expect(row).not.toContain("thinking");
    expect(row).toContain("…");
    expect(row).toContain("Code");
  });

  it("shows no job count at 0 running", () => {
    const row = frameOf(renderBar(100, <StatusBar segments={SEGMENTS} gitStatus={GIT} runningJobs={0} />));
    expect(row).not.toMatch(/\bjobs?\b/);
  });

  it("says '1 job' for one and 'N jobs' for more", () => {
    const one = frameOf(renderBar(100, <StatusBar segments={SEGMENTS} gitStatus={GIT} runningJobs={1} />));
    expect(one).toContain("1 job");
    expect(one).not.toContain("1 jobs");
    const two = frameOf(renderBar(100, <StatusBar segments={SEGMENTS} gitStatus={GIT} runningJobs={2} />));
    expect(two).toContain("2 jobs");
  });

  it("updates the job count when a job starts and when it exits", () => {
    Object.defineProperty(process.stdout, "columns", { value: 100, configurable: true });
    const tree = (n: number) => (
      <ThemeProvider config={{ colorEnabled: false }}>
        <TerminalProvider>
          <StatusBar segments={SEGMENTS} gitStatus={GIT} runningJobs={n} />
        </TerminalProvider>
      </ThemeProvider>
    );
    const r = render(tree(0));
    expect(frameOf(r)).not.toMatch(/\bjobs?\b/);
    r.rerender(tree(1));
    expect(frameOf(r)).toContain("1 job");
    r.rerender(tree(0));
    expect(frameOf(r)).not.toMatch(/\bjobs?\b/);
  });

  it("keeps the job count when the right group is dropped", () => {
    const row = frameOf(renderBar(60, <StatusBar segments={SEGMENTS} gitStatus={GIT} runningJobs={2} />));
    expect(row).not.toContain("thinking");
    expect(row).toContain("2 jobs");
  });
});

describe("StatusBar spinner slot", () => {
  const SPINNER_START = /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] /;

  it("is a blank two-column slot at the start when idle", () => {
    const row = frameOf(renderBar(100, <StatusBar segments={SEGMENTS} gitStatus={GIT} />)).split("\n")[0];
    expect(row.startsWith("  ● Code")).toBe(true);
  });

  it("shows a spinner glyph at the very start while working", () => {
    const row = frameOf(renderBar(100, <StatusBar segments={SEGMENTS} gitStatus={GIT} working />)).split("\n")[0];
    expect(row).toMatch(SPINNER_START);
    expect(row.slice(2).startsWith("● Code")).toBe(true);
  });

  it("leaves every other column where it was, idle or working", () => {
    const idle = frameOf(renderBar(100, <StatusBar segments={SEGMENTS} gitStatus={GIT} />)).split("\n")[0];
    const busy = frameOf(renderBar(100, <StatusBar segments={SEGMENTS} gitStatus={GIT} working />)).split("\n")[0];
    expect(busy.length).toBe(idle.length);
    expect(busy.slice(2)).toBe(idle.slice(2));
  });

  it("counts the slot toward the width budget", () => {
    // "● Code" plus its separator and ellipsis needs 11 columns after the slot
    // and " · main"; 21 columns leaves exactly 11, 20 leaves 10.
    expect(frameOf(renderBar(21, <StatusBar segments={SEGMENTS} gitStatus={GIT} />))).toContain("Code");
    expect(frameOf(renderBar(20, <StatusBar segments={SEGMENTS} gitStatus={GIT} />))).not.toContain("Code");
  });

  it("animates only while working", () => {
    const spy = vi.spyOn(globalThis, "setInterval");
    renderBar(100, <StatusBar segments={SEGMENTS} gitStatus={GIT} />);
    expect(spy).not.toHaveBeenCalled();
    renderBar(100, <StatusBar segments={SEGMENTS} gitStatus={GIT} working />);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("still renders the spinner when there is nothing else to show", () => {
    const row = frameOf(renderBar(100, <StatusBar segments={[]} working />)).split("\n")[0];
    expect(row).toMatch(/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
  });
});

describe("posture segment hint", () => {
  it("renders the inline (shift+tab) hint after the posture", () => {
    const segs = [
      { id: "1", text: "▸▸ auto (shift+tab)", raw: true },
      { id: "2", text: "thinking high", dimColor: true, align: "right" as const },
    ];
    const row = frameOf(renderBar(100, <StatusBar segments={segs} />)).split("\n")[0];
    expect(row).toContain("▸▸ auto (shift+tab)");
    expect(row).not.toContain("⇧ Tab");
  });
});
