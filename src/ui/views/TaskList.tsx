import React, { useState, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import type { TaskRecord } from "../../orchestrator/runner.js";
import { useTheme } from "../contexts.js";
import { ansi256 } from "../theme.js";

interface Props {
  /** Live registry snapshot, polled while the view is open. */
  getTasks: () => TaskRecord[];
  /** Stop the selected running task (async-subagents.md §3, Q4). */
  abortTask: (taskId: string) => void;
  onClose: () => void;
  width: number;
}

const STATUS_COLOR: Record<TaskRecord["status"], "secondary" | "success" | "error" | "warning"> = {
  running: "secondary",
  done: "success",
  failed: "error",
  aborted: "warning",
};

function ageOf(spawnedAt: number): string {
  const s = Math.max(0, Math.round((Date.now() - spawnedAt) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${Math.round(s / 3600)}h`;
}

export default function TaskList({ getTasks, abortTask, onClose, width }: Props) {
  const theme = useTheme();
  const [tasks, setTasks] = useState<TaskRecord[]>(() => getTasks());
  const [selectedIdx, setSelectedIdx] = useState(0);

  function refresh() {
    const next = getTasks();
    setTasks(next);
    setSelectedIdx((i) => Math.min(i, Math.max(0, next.length - 1)));
  }

  useEffect(() => {
    refresh();
    // Tasks complete in the background (the parent turn has ended), so poll
    // like the MCP status list rather than trusting a one-shot snapshot.
    const interval = setInterval(refresh, 1000);
    return () => clearInterval(interval);
  }, []);

  useInput((_value, key) => {
    if (key.escape) {
      onClose();
      return;
    }
    if (key.upArrow) {
      setSelectedIdx((i) => Math.max(0, i - 1));
      return;
    }
    if (key.downArrow) {
      setSelectedIdx((i) => Math.min(tasks.length - 1, i + 1));
      return;
    }
    if (key.return) {
      const t = tasks[selectedIdx];
      if (t && t.status === "running") {
        abortTask(t.id);
        refresh();
      }
      return;
    }
  });

  const running = tasks.filter((t) => t.status === "running").length;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={ansi256(theme.theme.secondary)} paddingX={1} marginY={1} width={width}>
      <Box marginBottom={1}>
        <Text color={ansi256(theme.theme.secondary)} bold>Tasks</Text>
        <Text> — {tasks.length} total{running > 0 ? `, ${running} running` : ""}</Text>
      </Box>

      {tasks.length === 0 ? (
        <Text color={ansi256(theme.theme.textDim)}>No tasks this session.</Text>
      ) : (
        <Box flexDirection="column">
          {tasks.map((t, i) => {
            const isSelected = i === selectedIdx;
            const who = t.agentName ?? "sub";
            const depth = t.depth > 0 ? ` · depth ${t.depth}` : "";
            return (
              <Box key={t.id}>
                <Text color={isSelected ? ansi256(theme.theme.secondary) : ansi256(theme.theme.textDim)}>
                  {isSelected ? "> " : "  "}
                  {t.id} · {who}{depth} · <Text color={ansi256(theme.theme[STATUS_COLOR[t.status]])}>{t.status}</Text> · {ageOf(t.spawnedAt)}
                  {t.description ? ` — ${t.description.slice(0, 60)}` : ""}
                  {t.status === "running" && isSelected ? (
                    <Text color={ansi256(theme.theme.warning)}> — press Enter to stop</Text>
                  ) : null}
                </Text>
              </Box>
            );
          })}
        </Box>
      )}

      <Box flexDirection="column" marginTop={1}>
        <Text color={ansi256(theme.theme.textDim)}>↑↓ navigate · Enter stop (running) · Esc close</Text>
      </Box>
    </Box>
  );
}
