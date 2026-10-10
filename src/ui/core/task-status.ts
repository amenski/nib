import type { TaskRecord } from "../../orchestrator/runner.js";
import type { StatusSegment } from "../types.js";

/**
 * Status-line segments for async sub-runs (async-subagents.md §4): while any
 * task runs, the row shows `⧗ N background task(s) · /tasks` so a delegation
 * that outlives the turn is visible and the way to inspect it is named; with
 * none running, no segment. Pure — the caller (cli.tsx buildStatusBar) feeds
 * the live registry snapshot, so the segment appears and clears with registry
 * state.
 */
export function buildTaskSegments(tasks: TaskRecord[]): StatusSegment[] {
  const running = tasks.filter((t) => t.status === "running");
  if (running.length === 0) return [];
  const label = running.length === 1 ? "1 background task" : `${running.length} background tasks`;
  return [{ id: "tasks", text: `⧗ ${label} · /tasks`, dimColor: true }];
}
