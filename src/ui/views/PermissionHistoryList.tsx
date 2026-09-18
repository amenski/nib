import React, { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { Box, Text, useInput } from "ink";
import type { SessionStore, PermissionAuditRecord, SessionPermissionMetrics } from "../../sessions/store.js";
import { bashEnvelopeGrants } from "../../permissions/session-grant.js";

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
  "grant-invalidated": "#f87171",
  // Approvals — green
  once: "#22c55e",
  "allow-by-rule": "#22c55e",
  "ask-approved": "#22c55e",
  // Persistent / elevated — amber
  session: "#f59e0b",
  always: "#f59e0b",
  "unresolved-ask": "#f59e0b",
  "allow-by-envelope-grant": "#f59e0b",
  // Posture — cyan (distinct from rule-based)
  "allow-by-posture": "#22d3ee",
  // Containment failures and revocations — red, they take authority away
  "sandbox-failure": "#ef4444",
  "grant-revoked": "#ef4444",
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
  "allow-by-envelope-grant": "session grant",
  "grant-invalidated": "grant invalidated",
  "grant-revoked": "grant revoked",
  "sandbox-failure": "sandbox failure",
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
  // The session grant is in-memory state this panel is also the revocation
  // surface for, so it is read live rather than snapshotted with the history.
  const [grant, setGrant] = useState(() => bashEnvelopeGrants.active(sessionId, "run_bash"));

  const loadHistory = useCallback(() => {
    sessionStore.queryPermissionHistory(sessionId).then((history) => {
      if (!aliveRef.current) return;
      setEntries(history);
      setLoading(false);
      // Index into the merged view, not the raw rows — a trailing merged pair
      // would otherwise leave the initial selection one past the end.
      setSelectedIdx(Math.max(0, mergeAdjacentPairs(history).length - 1));
    });
  }, [sessionStore, sessionId]);

  // The history is re-queried after a revocation, so it needs the same
  // "component may be gone by the time the query resolves" guard the initial
  // load has always had.
  const aliveRef = useRef(true);
  useEffect(() => () => {
    aliveRef.current = false;
  }, []);

  useEffect(() => {
    loadHistory();
    sessionStore.queryPermissionMetrics(sessionId).then((m) => {
      if (aliveRef.current) setMetrics(m);
    });
  }, [loadHistory, sessionStore, sessionId]);

  const displayEntries = useMemo(() => mergeAdjacentPairs(entries), [entries]);

  /**
   * Revoke the session grant (docs/permission-ux-redesign.md). Forward-only: it
   * drops the in-memory approval and records that it happened, so eligible
   * foreground Bash asks prompt again. It cannot undo changes the granted
   * commands already made, and does not stop a command that is already running
   * — that child keeps the OS profile it was launched with.
   */
  function revokeGrant(): void {
    if (!bashEnvelopeGrants.revoke(sessionId, "run_bash")) return;
    setGrant(null);
    void sessionStore
      .appendPermission(sessionId, {
        tool: "run_bash",
        subject: grant?.trustedRoot ?? "",
        decision: "grant-revoked",
        reason: "revoked by the user in /permissions; eligible foreground Bash asks prompt again",
      })
      .then(loadHistory);
  }

  useInput((value, key) => {
    if (key.escape) {
      onClose();
      return;
    }
    if (value.toLowerCase() === "r" && grant) {
      revokeGrant();
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
          {" · grants "}{metrics.envelopeGrantsCreated}
          {" (reused "}{metrics.envelopeGrantReuses}
          {", invalidated "}{metrics.envelopeGrantInvalidations}
          {", revoked "}{metrics.envelopeGrantRevocations}{")"}
          {" · sandbox failures "}{metrics.sandboxFailures}
        </Text>
      )}

      {grant && (
        <Box flexDirection="column" marginBottom={1}>
          <Text color="#f59e0b">
            Session grant active: sandboxed Bash in {grant.trustedRoot} will run without asking.
          </Text>
          <Text dimColor>
            Writable: {grant.writeRoots.length > 0 ? grant.writeRoots.join(", ") : "nothing"}
            {" · "}denied and guarded commands still ask
          </Text>
          <Text dimColor>
            Revoking does not undo changes already made, and does not stop a command that is already running.
          </Text>
        </Box>
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
        <Text dimColor>↑↓ navigate · Esc close{grant ? " · r revoke session grant" : ""}</Text>
      </Box>
    </Box>
  );
}
