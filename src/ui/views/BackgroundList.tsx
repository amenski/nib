import React, { useState, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import type { TaskRecord } from "../../orchestrator/runner.js";
import type { JobListEntry } from "../../tools/jobs.js";
import { useTheme } from "../contexts.js";
import { ansi256 } from "../theme.js";
import { collectBackgroundItems, formatAge, type BackgroundItem } from "../core/background-items.js";
import { sanitizeControlChars } from "../../tools/untrusted-content.js";

/** Output lines shown for the selected shell. */
const TAIL_LINES = 15;

interface Props {
  /** Live snapshots, polled while the view is open. */
  getJobs: () => JobListEntry[];
  getTasks: () => TaskRecord[];
  /** stdout + stderr of one shell job, or null once it has aged out. */
  getJobOutput: (jobId: string) => string | null;
  killJob: (jobId: string) => void;
  /** Stop one running sub-run (async-subagents.md §3, Q4). */
  abortTask: (taskId: string) => void;
  onClose: () => void;
  width: number;
}

type StatusColor = "secondary" | "success" | "error" | "warning";

function statusColor(item: BackgroundItem): StatusColor {
  if (item.status === "running") return "secondary";
  if (item.status === "done") return "success";
  if (item.status === "aborted" || item.status === "killed") return "warning";
  return "error";
}

function statusText(item: BackgroundItem): string {
  if (item.kind === "shell" && item.status !== "running" && item.status !== "killed") {
    return `exited ${item.exitCode ?? "?"}`;
  }
  return item.status;
}

/**
 * Background shells and sub-agents in one list (`/jobs`, `/tasks`, or ↓ on an
 * empty prompt). The selected shell shows the tail of its output, which no
 * longer streams into the transcript.
 */
export default function BackgroundList({ getJobs, getTasks, getJobOutput, killJob, abortTask, onClose, width }: Props) {
  const theme = useTheme();
  const snapshot = () => collectBackgroundItems(getJobs(), getTasks(), { includeFinishedAgents: true });
  const [items, setItems] = useState<BackgroundItem[]>(snapshot);
  const [selectedIdx, setSelectedIdx] = useState(0);

  function refresh() {
    const next = snapshot();
    setItems(next);
    setSelectedIdx((i) => Math.min(i, Math.max(0, next.length - 1)));
  }

  useEffect(() => {
    // Jobs and tasks finish on their own, so poll rather than trust a snapshot.
    const interval = setInterval(refresh, 1000);
    return () => clearInterval(interval);
  }, []);

  useInput((input, key) => {
    if (key.escape) {
      onClose();
      return;
    }
    if (key.upArrow) {
      setSelectedIdx((i) => Math.max(0, i - 1));
      return;
    }
    if (key.downArrow) {
      setSelectedIdx((i) => Math.min(items.length - 1, i + 1));
      return;
    }
    if (input === "x") {
      const item = items[selectedIdx];
      if (item?.status !== "running") return;
      if (item.kind === "shell") killJob(item.id);
      else abortTask(item.id);
      refresh();
    }
  });

  const now = Date.now();
  const running = items.filter((i) => i.status === "running").length;
  const selected = items[selectedIdx];
  const tail = selected?.kind === "shell"
    // Same T14 boundary as check_job: job output never reaches the terminal raw.
    // A bare \r (progress bars) starts a new line rather than being dropped.
    ? sanitizeControlChars((getJobOutput(selected.id) ?? "").replace(/\r(?!\n)/g, "\n")).split("\n").filter((l) => l.trim() !== "").slice(-TAIL_LINES)
    : [];
  const dim = ansi256(theme.theme.textDim);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={ansi256(theme.theme.secondary)} paddingX={1} marginY={1} width={width}>
      <Box marginBottom={1}>
        <Text color={ansi256(theme.theme.secondary)} bold>Background</Text>
        <Text> — {items.length} total{running > 0 ? `, ${running} running` : ""}</Text>
      </Box>

      {items.length === 0 ? (
        <Text color={dim}>No background shells or agents this session.</Text>
      ) : (
        <Box flexDirection="column">
          {items.map((item, i) => {
            const isSelected = i === selectedIdx;
            const age = formatAge((item.endedAt ?? now) - item.startedAt);
            return (
              <Text key={`${item.kind}:${item.id}`} wrap="truncate" color={isSelected ? ansi256(theme.theme.secondary) : dim}>
                {isSelected ? "> " : "  "}
                {item.kind === "shell" ? "shell" : "agent"} · <Text color={ansi256(theme.theme[statusColor(item)])}>{statusText(item)}</Text> · {age} · {item.label}
              </Text>
            );
          })}
        </Box>
      )}

      {selected?.kind === "shell" && (
        <Box flexDirection="column" marginTop={1}>
          {tail.length === 0 ? (
            <Text color={dim}>(no output yet)</Text>
          ) : (
            tail.map((line, i) => (
              <Text key={i} wrap="truncate" color={dim}>{line}</Text>
            ))
          )}
        </Box>
      )}

      <Box flexDirection="column" marginTop={1}>
        <Text color={dim}>↑↓ select · x stop (running) · Esc close</Text>
      </Box>
    </Box>
  );
}
