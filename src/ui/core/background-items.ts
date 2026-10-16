import type { TaskRecord } from "../../orchestrator/runner.js";
import type { JobListEntry } from "../../tools/jobs.js";

/**
 * One background shell job or sub-agent task, as the live row and the
 * background panel show it. Pure data: callers feed `jobManager.list()` and
 * the task registry snapshot.
 */
export interface BackgroundItem {
  kind: "shell" | "agent";
  id: string;
  label: string;
  status: JobListEntry["status"] | TaskRecord["status"];
  startedAt: number;
  endedAt: number | null;
  exitCode: number | null;
}

export function formatAge(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${Math.round(s / 3600)}h`;
}

/** A command's first line, whitespace collapsed; `…` marks dropped lines. */
export function shellLabel(command: string): string {
  const lines = command.trim().split("\n");
  const first = lines[0].replace(/\s+/g, " ").trim();
  return lines.length > 1 ? `${first} …` : first;
}

const isRunning = (item: BackgroundItem) => item.status === "running";

/**
 * Running items first (shells before agents, newest first), then finished
 * shells, most recently ended first. Finished agents are dropped unless the
 * caller asks for them — the task registry keeps every task for the session,
 * while finished shells age out of `jobManager.list()` on their own.
 */
export function collectBackgroundItems(
  jobs: JobListEntry[],
  tasks: TaskRecord[],
  opts: { includeFinishedAgents?: boolean } = {},
): BackgroundItem[] {
  const shells: BackgroundItem[] = jobs.map((j) => ({
    kind: "shell",
    id: j.id,
    label: shellLabel(j.command),
    status: j.status,
    startedAt: j.startTime,
    endedAt: j.endTime,
    exitCode: j.exitCode,
  }));
  const agents: BackgroundItem[] = tasks
    .filter((t) => t.status === "running" || opts.includeFinishedAgents)
    .map((t) => ({
      kind: "agent",
      id: t.id,
      label: t.description ? `${t.agentName ?? "sub"}: ${t.description}` : (t.agentName ?? "sub"),
      status: t.status,
      startedAt: t.spawnedAt,
      endedAt: null,
      exitCode: null,
    }));
  const newestFirst = (a: BackgroundItem, b: BackgroundItem) => b.startedAt - a.startedAt;
  return [
    ...shells.filter(isRunning).sort(newestFirst),
    ...agents.filter(isRunning).sort(newestFirst),
    ...shells.filter((i) => !isRunning(i)).sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0)),
    ...agents.filter((i) => !isRunning(i)).sort(newestFirst),
  ];
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const ROW_SUFFIX = " · ↓ to view";

/**
 * The one-line summary under the status bar, or null when there is nothing to
 * show. Names the newest running item and cuts that name — never the counts
 * or the hint — to fit `width`.
 */
export function backgroundRowText(items: BackgroundItem[], now: number, width: number): string | null {
  if (items.length === 0) return null;
  const running = items.filter(isRunning);
  if (running.length === 0) {
    const shells = items.filter((i) => i.kind === "shell");
    if (shells.length === 0) return null;
    const bad = shells.filter((i) => i.status !== "done").length;
    const head = `● ${plural(shells.length, "shell")} finished${bad > 0 ? ` (${bad} failed)` : ""}`;
    return `${head}${ROW_SUFFIX}`.slice(0, width);
  }
  const shellCount = running.filter((i) => i.kind === "shell").length;
  const agentCount = running.length - shellCount;
  const counts = [
    ...(shellCount > 0 ? [plural(shellCount, "shell")] : []),
    ...(agentCount > 0 ? [plural(agentCount, "agent")] : []),
  ];
  const head = `⏵ ${counts.join(" · ")}`;
  const newest = running[0];
  const age = formatAge(now - newest.startedAt);
  const room = width - head.length - " · ".length - ROW_SUFFIX.length - age.length - 1;
  if (room < 4) return `${head}${ROW_SUFFIX}`.slice(0, width);
  const label = newest.label.length > room ? `${newest.label.slice(0, room - 1)}…` : newest.label;
  return `${head} · ${label} ${age}${ROW_SUFFIX}`;
}

/** The single transcript row a finished job leaves behind. */
export function completionLine(report: {
  command: string;
  status: JobListEntry["status"];
  exitCode: number | null;
  runningMs: number;
}): { text: string; failed: boolean } {
  const outcome = report.status === "killed" ? "killed" : `exited ${report.exitCode ?? "?"}`;
  return {
    text: `● ${shellLabel(report.command)} · ${outcome} · ${formatAge(report.runningMs)}`,
    failed: report.status !== "done",
  };
}
