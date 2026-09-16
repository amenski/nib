import type { CommandClassificationResult } from "../permissions/command-classifier.js";
import type { ClassifierEvidenceRecord, PermissionAuditRecord, SessionPermissionMetrics } from "./store.js";

const CANONICAL_DECISIONS = new Set<PermissionAuditRecord["decision"]>([
  "allow-by-rule", "allow-by-posture", "ask-approved", "ask-denied",
  "deny-by-rule", "deny-by-profile", "headless-deny", "unresolved-ask",
]);
const LEGACY_DECISIONS = new Set<PermissionAuditRecord["decision"]>([
  "deny", "once", "session", "always",
]);

function isDuplicateLegacyRow(row: PermissionAuditRecord, next?: PermissionAuditRecord): boolean {
  return LEGACY_DECISIONS.has(row.decision) && next !== undefined
    && CANONICAL_DECISIONS.has(next.decision)
    && row.tool === next.tool
    && row.subject === next.subject;
}

function metricRows(rows: readonly PermissionAuditRecord[]): PermissionAuditRecord[] {
  const out: PermissionAuditRecord[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (CANONICAL_DECISIONS.has(row.decision)) {
      out.push(row);
    } else if (LEGACY_DECISIONS.has(row.decision) && !isDuplicateLegacyRow(row, rows[i + 1])) {
      out.push(row);
    }
  }
  return out;
}

function isPrompt(row: PermissionAuditRecord): boolean {
  if (row.decision === "ask-approved" || row.decision === "unresolved-ask") return true;
  if (row.decision === "ask-denied") return row.reason === undefined || /at prompt/i.test(row.reason);
  return LEGACY_DECISIONS.has(row.decision);
}

function isApproval(row: PermissionAuditRecord): boolean {
  return row.decision === "ask-approved" || row.decision === "unresolved-ask"
    || row.decision === "once" || row.decision === "session" || row.decision === "always";
}

function isDenial(row: PermissionAuditRecord): boolean {
  return row.decision === "ask-denied" || row.decision === "deny-by-rule"
    || row.decision === "deny-by-profile" || row.decision === "headless-deny" || row.decision === "deny";
}

function classificationOf(row: PermissionAuditRecord): CommandClassificationResult | undefined {
  return row.commandClassification;
}

/**
 * Computes local session metrics from persisted audit rows. Missing classifier
 * metadata is not reconstructed: it predates this metric and is not safe to
 * infer from redacted subjects. False-allow count requires a separate,
 * explicitly supplied policy/handler evidence row matched by toolCallId.
 */
export function computeSessionPermissionMetrics(
  rows: readonly PermissionAuditRecord[],
  evidence: readonly (ClassifierEvidenceRecord & { at?: string })[] = [],
): SessionPermissionMetrics {
  const selected = metricRows(rows);
  let permissionPrompts = 0;
  let permissionApprovals = 0;
  let permissionDenials = 0;
  let classifierProvenReadOnly = 0;
  let classifierUnknown = 0;
  const provenCallIds = new Set<string>();

  for (const row of selected) {
    if (isPrompt(row)) permissionPrompts++;
    if (isApproval(row)) permissionApprovals++;
    if (isDenial(row)) permissionDenials++;

    const classification = classificationOf(row);
    if (!classification) continue;
    if (classification.classification === "proven-read-only") {
      classifierProvenReadOnly++;
      if (row.toolCallId) provenCallIds.add(row.toolCallId);
    } else {
      classifierUnknown++;
    }
  }

  const falseAllowCount = evidence.filter((entry) => {
    if (!provenCallIds.has(entry.toolCallId)) return false;
    if (entry.source !== "policy" && entry.source !== "handler") return false;
    return entry.reason.trim() !== "";
  }).length;

  return {
    permissionPrompts,
    permissionApprovals,
    permissionDenials,
    classifierProvenReadOnly,
    classifierUnknown,
    falseAllowCount,
    falseAllowRate: classifierProvenReadOnly === 0 ? null : falseAllowCount / classifierProvenReadOnly,
  };
}
