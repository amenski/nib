import React, { useState, useEffect, useMemo } from "react";
import { Box, Text, useInput } from "ink";
import type { SessionStore, PermissionAuditRecord, SessionPermissionMetrics } from "../../sessions/store.js";

interface Props {
  sessionStore: SessionStore;
  sessionId: string;
  onClose: () => void;
  width: number;
}

const DECISION_COLOR: Record<string, string> = {
  // Denials — red
  deny: "#ef4444",
  "deny-by-rule": "#ef4444",
  "ask-denied": "#ef4444",
  "headless-deny": "#f87171", // dimmer red — not user-refusable
  // Approvals — green
  once: "#22c55e",
  "allow-by-rule": "#22c55e",
  "ask-approved": "#22c55e",
  // Persistent / elevated — amber
  session: "#f59e0b",
  always: "#f59e0b",
  "unresolved-ask": "#f59e0b",
  // Posture — cyan (distinct from rule-based)
  "allow-by-posture": "#22d3ee",
};

const DECISION_LABEL: Record<string, string> = {
  deny: "deny",
  "deny-by-rule": "deny-by-rule",
  "ask-denied": "deny",
  "headless-deny": "headless-deny",
  once: "once",
  session: "session",
  always: "always",
  "allow-by-rule": "allow-by-rule",
  "allow-by-posture": "allow-by-posture",
  "ask-approved": "approved",
  "unresolved-ask": "unresolved-ask",
};

type HistoryEntry = PermissionAuditRecord & { at: string };

type DisplayEntry = { primary: HistoryEntry; secondary?: HistoryEntry };

// Dedup adjacent agent+UI rows. Interactive prompts produce two records: the
// UI writes a fine-grained legacy decision (once|session|always|deny), then
// the agent writes a canonical value (ask-approved|ask-denied). Merge each
// adjacent pair sharing tool + subject so one decision = one row. Pure so the
// same count drives both the initial selection index and the render.
const LEGACY_DECISIONS = new Set(["deny", "once", "session", "always"]);
const CANONICAL_ASK_DECISIONS = new Set(["ask-approved", "ask-denied", "unresolved-ask"]);

function mergeAdjacentPairs(entries: HistoryEntry[]): DisplayEntry[] {
  const out: DisplayEntry[] = [];
  for (let i = 0; i < entries.length; i++) {
    const cur = entries[i];
    const next = entries[i + 1];
    if (
      next &&
      LEGACY_DECISIONS.has(cur.decision) &&
      CANONICAL_ASK_DECISIONS.has(next.decision) &&
      cur.tool === next.tool &&
      cur.subject === next.subject
    ) {
      out.push({ primary: cur, secondary: next });
      i++; // consume the agent row
    } else {
      out.push({ primary: cur });
    }
  }
  return out;
}

export default function PermissionHistoryList({ sessionStore, sessionId, onClose, width }: Props) {
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [metrics, setMetrics] = useState<SessionPermissionMetrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedIdx, setSelectedIdx] = useState(0);

  useEffect(() => {
    let cancelled = false;
    sessionStore.queryPermissionHistory(sessionId).then((history) => {
      if (cancelled) return;
      setEntries(history);
      setLoading(false);
      // Index into the merged view, not the raw rows — a trailing merged pair
      // would otherwise leave the initial selection one past the end.
      setSelectedIdx(Math.max(0, mergeAdjacentPairs(history).length - 1));
    });
    sessionStore.queryPermissionMetrics(sessionId).then(setMetrics);
    return () => {
      cancelled = true;
    };
  }, [sessionStore, sessionId]);

  const displayEntries = useMemo(() => mergeAdjacentPairs(entries), [entries]);

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
      setSelectedIdx((i) => Math.min(displayEntries.length - 1, i + 1));
      return;
    }
  });

  const selected = displayEntries[selectedIdx];

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} marginY={1} width={width}>
      <Box marginBottom={1}>
        <Text color="cyan" bold>Permission History</Text>
        {displayEntries.length > 0 && <Text dimColor> — {displayEntries.length} decision{displayEntries.length === 1 ? "" : "s"}</Text>}
      </Box>

      {metrics && (
        <Text dimColor>
          Prompts {metrics.permissionPrompts} · approvals {metrics.permissionApprovals} · denials {metrics.permissionDenials}
          {" · classifier read-only/unknown "}{metrics.classifierProvenReadOnly}/{metrics.classifierUnknown}
          {" · false-allow "}{metrics.falseAllowCount}
          {metrics.falseAllowRate === null ? "" : ` (${(metrics.falseAllowRate * 100).toFixed(1)}%)`}
        </Text>
      )}

      {loading ? (
        <Text dimColor>Loading…</Text>
      ) : displayEntries.length === 0 ? (
        <Text dimColor>No permission decisions recorded yet this session.</Text>
      ) : (
        <Box flexDirection="column">
          {displayEntries.map((entry, i) => {
            const isSelected = i === selectedIdx;
            const decision = entry.primary.decision;
            const color = DECISION_COLOR[decision] ?? undefined;
            const time = entry.primary.at.slice(11, 19);
            return (
              <Box key={i}>
                <Text color={isSelected ? "cyanBright" : undefined} dimColor={!isSelected}>
                  {isSelected ? "> " : "  "}
                  {time} · {entry.primary.tool}
                </Text>
                <Text color={color}> [{DECISION_LABEL[decision] ?? decision}]</Text>
              </Box>
            );
          })}
        </Box>
      )}

      {selected && (
        <Box flexDirection="column" marginTop={1} borderStyle="single" borderColor="gray" paddingX={1}>
          <Text dimColor>Subject: </Text>
          <Text>{selected.primary.subject}</Text>
          {selected.primary.winningRule && (
            <Text dimColor>
              Rule: {selected.primary.winningRule.origin} · {selected.primary.winningRule.kind} · "{selected.primary.winningRule.pattern}" → {selected.primary.winningRule.action}
            </Text>
          )}
          {selected.secondary && (
            <Text dimColor>
              Agent outcome: {selected.secondary.decision}
              {selected.secondary.reason ? ` — ${selected.secondary.reason}` : ""}
            </Text>
          )}
        </Box>
      )}

      <Box marginTop={1}>
        <Text dimColor>↑↓ navigate · Esc close</Text>
      </Box>
    </Box>
  );
}
