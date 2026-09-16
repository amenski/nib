import React, { useState, useEffect, useRef } from "react";
import { Box, Text, useInput } from "ink";
import type { CheckpointEntry } from "../../checkpoints/index.js";

type Phase = "message" | "mode";

interface Props {
  checkpoints: CheckpointEntry[];
  onRestore: (hash: string, restoreCode: boolean) => Promise<{ restored: boolean; promptDraft: string }>;
  onClose: () => void;
  width: number;
  height: number;
}

function formatMessage(msg: string): string {
  const cleaned = msg.replace(/\[convLen:\d+\]\s*/, "").trim();
  return cleaned.length > 56 ? cleaned.slice(0, 53) + "..." : cleaned;
}

function formatDate(ts: string): string {
  try {
    const d = new Date(ts);
    const now = new Date();
    const diff = now.getTime() - d.getTime();
    if (diff < 3600000) return `${Math.round(diff / 60000)}m ago`;
    return d.toISOString().slice(0, 10);
  } catch {
    return ts.slice(0, 10);
  }
}

export default function UndoSelector({ checkpoints, onRestore, onClose, width, height }: Props) {
  const [phase, setPhase] = useState<Phase>("message");
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [modeCursor, setModeCursor] = useState(0);
  const [restoring, setRestoring] = useState(false);
  const [searchText, setSearchText] = useState("");
  const searchRef = useRef("");

  const entries = checkpoints.length > 0 ? checkpoints : [];
  const pageSize = Math.max(3, height - 8);

  useEffect(() => {
    if (selectedIdx < scrollOffset) setScrollOffset(selectedIdx);
    else if (selectedIdx >= scrollOffset + pageSize) setScrollOffset(selectedIdx - pageSize + 1);
  }, [selectedIdx, pageSize, scrollOffset]);

  const filtered = searchText
    ? entries.filter((e) => formatMessage(e.message).toLowerCase().includes(searchText.toLowerCase()))
    : entries;

  const visible = filtered.slice(scrollOffset, scrollOffset + pageSize);
  const safeIndex = Math.max(0, Math.min(selectedIdx, filtered.length - 1));

  const modeOptions = ["Restore code and conversation", "Restore conversation only"];

  useInput((value, key) => {
    if (restoring) return;

    if (phase === "mode") {
      if (key.escape) {
        setPhase("message");
        setModeCursor(0);
        return;
      }
      if (key.upArrow) { setModeCursor((i) => Math.max(0, i - 1)); return; }
      if (key.downArrow) { setModeCursor((i) => Math.min(1, i + 1)); return; }
      if (key.return) {
        setRestoring(true);
        const entry = filtered[safeIndex];
        if (!entry) { setRestoring(false); return; }
        onRestore(entry.hash, modeCursor === 0).then(() => {
          setRestoring(false);
        });
        return;
      }
      return;
    }

    if (key.escape) {
      if (searchText) {
        setSearchText("");
        searchRef.current = "";
        return;
      }
      onClose();
      return;
    }

    if (key.upArrow) { setSelectedIdx((i) => Math.max(0, i - 1)); return; }
    if (key.downArrow) { setSelectedIdx((i) => Math.min(filtered.length - 1, i + 1)); return; }
    if (key.return) {
      if (filtered.length > 0) setPhase("mode");
      return;
    }

    if (value && value.length === 1 && !key.ctrl && !key.meta && !key.shift) {
      searchRef.current += value;
      setSearchText(searchRef.current);
      setSelectedIdx(0);
      setScrollOffset(0);
      return;
    }
    if (key.backspace && searchText && !value) {
      searchRef.current = searchRef.current.slice(0, -1);
      setSearchText(searchRef.current);
      return;
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1} marginY={1} width={width}>
      {phase === "mode" ? (
        <Box flexDirection="column">
          <Box marginBottom={1}>
            <Text color="yellow" bold>Restore mode</Text>
          </Box>
          <Text dimColor>Restoring to: {formatMessage(filtered[safeIndex]?.message ?? "")}</Text>
          <Box flexDirection="column" marginTop={1}>
            {modeOptions.map((opt, i) => (
              <Text key={i} color={i === modeCursor ? "cyanBright" : undefined}>
                {i === modeCursor ? "> " : "  "}
                {i + 1}. {opt}
              </Text>
            ))}
          </Box>
          <Box marginTop={1}>
            <Text color="yellow">
              Undo only affects this checkpoint: it may restore checkpointed workspace files and/or conversation.
              It cannot undo running processes, network calls, remote mutations, or files excluded from or not
              captured in the checkpoint (including later untracked data).
            </Text>
          </Box>
          <Box marginTop={1}>
            <Text dimColor>↑↓ navigate · Enter select · Esc back</Text>
          </Box>
        </Box>
      ) : restoring ? (
        <Box><Text dimColor>Restoring...</Text></Box>
      ) : (
        <Box flexDirection="column">
          <Box marginBottom={1}>
            <Text color="yellow" bold>Undo — select a checkpoint</Text>
          </Box>

          {filtered.length === 0 ? (
            <Text dimColor>No checkpoints found.</Text>
          ) : (
            <Box flexDirection="column">
              {scrollOffset > 0 && (
                <Text dimColor>  ... ({scrollOffset} above) ...</Text>
              )}
              {visible.map((entry, i) => {
                const globalIdx = scrollOffset + i;
                const isSelected = globalIdx === safeIndex;
                return (
                  <Box key={entry.hash}>
                    <Text color={isSelected ? "cyanBright" : undefined} dimColor={!isSelected}>
                      {isSelected ? "> " : "  "}
                      {formatDate(entry.timestamp).padEnd(12)} {formatMessage(entry.message)}
                    </Text>
                  </Box>
                );
              })}
              {scrollOffset + pageSize < filtered.length && (
                <Text dimColor>  ... ({filtered.length - scrollOffset - pageSize} more) ...</Text>
              )}
            </Box>
          )}

          <Box flexDirection="column" marginTop={1}>
            <Text dimColor>↑↓ navigate · Enter select · Esc close · Type to search</Text>
            {searchText && <Text dimColor>Search: {searchText}</Text>}
          </Box>
        </Box>
      )}
    </Box>
  );
}
