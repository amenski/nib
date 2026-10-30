import { describe, it, expect } from "vitest";
import {
  backgroundRowText,
  collectBackgroundItems,
  completionLine,
  formatAge,
  runningShellCount,
  type BackgroundItem,
} from "./background-items.js";
import type { TaskRecord } from "../../orchestrator/runner.js";

const NOW = 1_000_000;

function job(over: Partial<{ id: string; command: string; status: "running" | "done" | "failed" | "killed"; exitCode: number | null; startTime: number; endTime: number | null }> = {}) {
  return {
    id: "aaaa1111",
    command: "npm run dev",
    status: "running" as const,
    exitCode: null,
    startTime: NOW - 180_000,
    endTime: null,
    runningMs: 180_000,
    ...over,
  };
}

function task(over: Partial<TaskRecord> = {}): TaskRecord {
  return { id: "task-1", description: "review the diff", status: "running", spawnedAt: NOW - 30_000, depth: 0, agentName: "reviewer", ...over };
}

describe("formatAge", () => {
  it("uses seconds, minutes, then hours", () => {
    expect(formatAge(12_000)).toBe("12s");
    expect(formatAge(180_000)).toBe("3m");
    expect(formatAge(2 * 3_600_000)).toBe("2h");
  });
});

describe("runningShellCount", () => {
  it("counts running shells only, not agents or finished jobs", () => {
    const items = collectBackgroundItems(
      [job({ id: "a" }), job({ id: "b", status: "done", exitCode: 0, endTime: NOW }), job({ id: "c" })],
      [task()],
    );
    expect(runningShellCount(items)).toBe(2);
    expect(runningShellCount([])).toBe(0);
  });
});

describe("collectBackgroundItems", () => {
  it("puts running items first, shells before agents, newest first", () => {
    const items = collectBackgroundItems(
      [
        job({ id: "old", status: "done", exitCode: 0, endTime: NOW - 1_000 }),
        job({ id: "older-run", startTime: NOW - 500_000 }),
        job({ id: "newer-run", startTime: NOW - 10_000 }),
      ],
      [task()],
    );
    expect(items.map((i) => i.id)).toEqual(["newer-run", "older-run", "task-1", "old"]);
    expect(items[2]).toMatchObject({ kind: "agent", label: "reviewer: review the diff" });
  });

  it("drops finished agents — the panel shows them, the row does not need them", () => {
    const items = collectBackgroundItems([], [task({ status: "done" })]);
    expect(items).toEqual([]);
  });
});

describe("backgroundRowText", () => {
  const items = (list: BackgroundItem[]) => list;

  it("is null with nothing to show", () => {
    expect(backgroundRowText([], NOW, 80)).toBeNull();
  });

  it("counts running shells and agents and names the newest running shell", () => {
    const list = collectBackgroundItems([job(), job({ id: "b", command: "tsc --watch", startTime: NOW - 5_000 })], [task()]);
    expect(backgroundRowText(list, NOW, 120)).toBe("⏵ 2 shells · 1 agent · tsc --watch 5s · ↓ to view");
  });

  it("summarizes finished shells when nothing runs", () => {
    const list = collectBackgroundItems(
      [job({ status: "done", exitCode: 0, endTime: NOW }), job({ id: "b", status: "failed", exitCode: 1, endTime: NOW })],
      [],
    );
    expect(backgroundRowText(items(list), NOW, 120)).toBe("● 2 shells finished (1 failed) · ↓ to view");
  });

  it("cuts the text to the width", () => {
    const list = collectBackgroundItems([job({ command: "x".repeat(200) })], []);
    const text = backgroundRowText(list, NOW, 40)!;
    expect(text.length).toBeLessThanOrEqual(40);
    expect(text.endsWith("↓ to view")).toBe(true);
  });
});

describe("completionLine", () => {
  it("reads as success for exit 0 and as failure otherwise", () => {
    expect(completionLine({ command: "npm test", status: "done", exitCode: 0, runningMs: 65_000 })).toEqual({
      text: "● npm test · exited 0 · 1m",
      failed: false,
    });
    expect(completionLine({ command: "npm test", status: "failed", exitCode: 2, runningMs: 3_000 })).toEqual({
      text: "● npm test · exited 2 · 3s",
      failed: true,
    });
    expect(completionLine({ command: "npm run dev", status: "killed", exitCode: null, runningMs: 3_000 })).toEqual({
      text: "● npm run dev · killed · 3s",
      failed: true,
    });
  });

  it("keeps a multi-line command to its first line", () => {
    expect(completionLine({ command: "cd x\nnpm test", status: "done", exitCode: 0, runningMs: 1_000 }).text).toBe(
      "● cd x … · exited 0 · 1s",
    );
  });
});
