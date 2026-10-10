import React, { useState, useEffect, useRef, useMemo } from "react";
import { Box, Text, useInput } from "ink";
import type { SessionListItem, SessionStore } from "../../sessions/store.js";
import { useTheme } from "../contexts.js";
import { ansi256 } from "../theme.js";

interface Props {
  sessionStore: SessionStore;
  onResume: (sessionId: string) => void;
  onClose: () => void;
  width: number;
  height: number;
}

export default function SessionList({ sessionStore, onResume, onClose, width, height }: Props) {
  const theme = useTheme();
  const [sessions, setSessions] = useState<SessionListItem[]>([]);
  const [searchText, setSearchText] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [renameTarget, setRenameTarget] = useState<string | null>(null);
  const [renameText, setRenameText] = useState("");
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const searchRef = useRef("");

  useEffect(() => {
    sessionStore.list().then((list) => setSessions(list));
  }, [sessionStore]);

  const filtered = useMemo(() => {
    const q = searchText.toLowerCase();
    if (!q) return sessions;
    return sessions.filter(
      (s) =>
        s.title.toLowerCase().includes(q) ||
        s.firstMessage.toLowerCase().includes(q) ||
        s.id.toLowerCase().includes(q)
    );
  }, [sessions, searchText]);

  const pageSize = Math.max(3, height - 8);
  const safeIndex = Math.max(0, Math.min(selectedIndex, filtered.length - 1));

  useEffect(() => {
    if (safeIndex < scrollOffset) setScrollOffset(safeIndex);
    else if (safeIndex >= scrollOffset + pageSize) setScrollOffset(safeIndex - pageSize + 1);
  }, [safeIndex, pageSize, scrollOffset]);

  const visible = filtered.slice(scrollOffset, scrollOffset + pageSize);

  // Small, honest status glyphs: completed / interrupted / failed.
  const STATUS_MARK: Record<string, { glyph: string; color: string }> = {
    completed: { glyph: "✓", color: ansi256(theme.theme.success) },
    interrupted: { glyph: "…", color: ansi256(theme.theme.warning) },
    failed: { glyph: "✗", color: ansi256(theme.theme.error) },
  };

  function formatDate(iso: string): string {
    try {
      const d = new Date(iso);
      const now = new Date();
      const diff = now.getTime() - d.getTime();
      if (diff < 3600000) return `${Math.round(diff / 60000)}m ago`;
      if (diff < 86400000) return `${Math.round(diff / 3600000)}h ago`;
      return d.toISOString().slice(0, 10);
    } catch {
      return iso.slice(0, 10);
    }
  }

  useInput((value, key) => {
    if (deleteConfirm) {
      if (key.return) {
        sessionStore.deleteSession(deleteConfirm).then(() => {
          setSessions((prev) => prev.filter((s) => s.id !== deleteConfirm));
          setDeleteConfirm(null);
        });
        return;
      }
      if (key.escape) {
        setDeleteConfirm(null);
        return;
      }
      return;
    }

    if (renameTarget) {
      if (key.return) {
        const title = renameText.trim();
        const target = renameTarget;
        if (title) {
          sessionStore.renameSession(target, title).then(() => {
            setSessions((prev) =>
              prev.map((s) => (s.id === target ? { ...s, title } : s)),
            );
            setRenameTarget(null);
            setRenameText("");
          });
        } else {
          setRenameTarget(null);
          setRenameText("");
        }
        return;
      }
      if (key.escape) {
        setRenameTarget(null);
        setRenameText("");
        return;
      }
      if (key.backspace) {
        const next = renameText.slice(0, -1);
        setRenameText(next);
        return;
      }
      if (value && value.length === 1 && !key.ctrl && !key.meta && !key.shift) {
        setRenameText((prev) => prev + value);
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

    if (key.ctrl && (value === "r" || value === "R")) {
      const s = filtered[safeIndex];
      if (s) {
        setRenameTarget(s.id);
        setRenameText(s.title ?? "");
      }
      return;
    }

    if (key.delete || (key.backspace && !searchText && !value)) {
      const s = filtered[safeIndex];
      if (s) {
        setDeleteConfirm(s.id);
      }
      return;
    }

    if (key.upArrow) {
      setSelectedIndex((i) => Math.max(0, i - 1));
      return;
    }
    if (key.downArrow) {
      setSelectedIndex((i) => Math.min(filtered.length - 1, i + 1));
      return;
    }

    if (key.return) {
      const s = filtered[safeIndex];
      if (s) onResume(s.id);
      return;
    }

    if (value && value.length === 1 && !key.ctrl && !key.meta && !key.shift) {
      searchRef.current += value;
      setSearchText(searchRef.current);
      setSelectedIndex(0);
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
    <Box flexDirection="column" borderStyle="round" borderColor={ansi256(theme.theme.secondary)} paddingX={1} marginY={1} width={width}>
      {deleteConfirm ? (
        <Box flexDirection="column">
          <Text color={ansi256(theme.theme.error)} bold>Delete session?</Text>
          <Text>Session {deleteConfirm.slice(0, 16)}...</Text>
          <Box marginTop={1}><Text color={ansi256(theme.theme.textDim)}>Enter to confirm · Esc to cancel</Text></Box>
        </Box>
      ) : renameTarget ? (
        <Box flexDirection="column">
          <Text bold>Rename session</Text>
          <Text color={ansi256(theme.theme.secondary)}>{renameText || <Text color={ansi256(theme.theme.textDim)}>type new name</Text>}<Text color={ansi256(theme.theme.secondary)} inverse> </Text></Text>
          <Box marginTop={1}><Text color={ansi256(theme.theme.textDim)}>Enter to save · Esc to cancel</Text></Box>
        </Box>
      ) : (
        <>
          <Box marginBottom={1}>
            <Text color={ansi256(theme.theme.secondary)} bold>Sessions</Text>
            {searchText && <Text color={ansi256(theme.theme.textDim)}> — matching "{searchText}"</Text>}
          </Box>

          {filtered.length === 0 ? (
            <Text color={ansi256(theme.theme.textDim)}>No sessions found.</Text>
          ) : (
            <Box flexDirection="column">
              {scrollOffset > 0 && (
                <Text color={ansi256(theme.theme.textDim)}>{`  ... (${scrollOffset} more above) ...`}</Text>
              )}
              {visible.map((s, i) => {
                const globalIdx = scrollOffset + i;
                const isSelected = globalIdx === safeIndex;
                const mark = STATUS_MARK[s.status] ?? STATUS_MARK.interrupted;
                return (
                  <Box key={s.id}>
                    <Text color={isSelected ? ansi256(theme.theme.secondary) : ansi256(theme.theme.textDim)}>
                      {isSelected ? "> " : "  "}
                    </Text>
                    <Text color={!isSelected ? ansi256(theme.theme.textDim) : mark.color}>{mark.glyph} </Text>
                    <Text color={isSelected ? ansi256(theme.theme.secondary) : ansi256(theme.theme.textDim)}>
                      {formatDate(s.updatedAt).padEnd(10)} {String(s.messageCount).padStart(3)}msgs{"  "}
                      {s.title || s.firstMessage || s.id.slice(0, 12)}
                    </Text>
                  </Box>
                );
              })}
              {scrollOffset + pageSize < filtered.length && (
                <Text color={ansi256(theme.theme.textDim)}>{`  ... (${filtered.length - scrollOffset - pageSize} more below) ...`}</Text>
              )}
            </Box>
          )}

          <Box flexDirection="column" marginTop={1}>
            <Text color={ansi256(theme.theme.textDim)}>↑↓ navigate · Enter resume · Ctrl+R rename · Del delete · Esc close</Text>
            {searchText && <Text color={ansi256(theme.theme.textDim)}>Search: {searchText}</Text>}
          </Box>
        </>
      )}
    </Box>
  );
}
