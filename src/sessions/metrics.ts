import type { PermissionAuditRecord, SessionPermissionMetrics } from "./store.js";

/**
 * Decisions a session's metrics count, exactly once each. Membership is
 * mandatory, not cosmetic: {@link metricRows} drops any decision missing here,
 * so a new canonical row is invisible to every metric until it is listed.
 */
const CANONICAL_DECISIONS = new Set<PermissionAuditRecord["decision"]>([
  "allow-by-rule", "allow-by-posture", "ask-approved", "ask-denied",
  "deny-by-rule", "deny-by-profile", "headless-deny", "unresolved-ask",
  // Session-grant lifecycle (docs/permission-ux-redesign.md).
  "allow-by-envelope-grant", "grant-invalidated", "grant-revoked", "sandbox-failure",
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
  // Consent for the session grant *was* a prompt — the user was asked and
  // answered one. A reuse was not: no question was asked at all, which is the
  // entire point of the grant. The two share a decision string, so they are
  // separated by `envelopeGrant`; counting one row per grant would report a
  // consent as if it had cost the user nothing.
  if (row.decision === "allow-by-envelope-grant") return row.envelopeGrant === "granted";
  if (row.decision === "ask-denied") return row.reason === undefined || /at prompt/i.test(row.reason);
  return LEGACY_DECISIONS.has(row.decision);
}

function isApproval(row: PermissionAuditRecord): boolean {
  // A covered call is an approval that needed no prompt. Counting it keeps the
  // approvals number comparable across a change in prompt policy — the same
  // work was done either way, which is the whole point of the comparison
  // (docs/permission-ux-redesign.md).
  return row.decision === "ask-approved" || row.decision === "unresolved-ask"
    || row.decision === "allow-by-envelope-grant"
    || row.decision === "once" || row.decision === "session" || row.decision === "always";
}

function isDenial(row: PermissionAuditRecord): boolean {
  return row.decision === "ask-denied" || row.decision === "deny-by-rule"
    || row.decision === "deny-by-profile" || row.decision === "headless-deny" || row.decision === "deny";
}

/**
 * Computes local session metrics from persisted audit rows. Missing classifier
 * metadata is not reconstructed: it predates this metric and is not safe to
 * infer from redacted subjects. The command classifier's own counters were
 * removed with the prompt redesign (docs/permission-ux-redesign.md): a
 * `proven-read-only` label no longer removes a prompt, so it must not be
 * presented as if it were load-bearing. The classification is still written to
 * the audit row as advisory metadata.
 *
 * Most of the grant lifecycle is not a prompt: a reuse means no prompt happened
 * at all, and an invalidation or revocation is an event about the approval
 * rather than a question asked — the ask that follows an invalidation writes its
 * own row (see {@link isPrompt}). A *consent* row is the exception, because the
 * user was interrupted for it; the harness in
 * scripts/permission-grant-baseline.ts is what caught that, by comparing this
 * counter against the number of times the prompt bridge was actually called.
 */
export function computeSessionPermissionMetrics(
  rows: readonly PermissionAuditRecord[],
): SessionPermissionMetrics {
  const selected = metricRows(rows);
  let permissionPrompts = 0;
  let permissionApprovals = 0;
  let permissionDenials = 0;
  let envelopeGrantsCreated = 0;
  let envelopeGrantReuses = 0;
  let envelopeGrantInvalidations = 0;
  let envelopeGrantRevocations = 0;
  let sandboxFailures = 0;

  for (const row of selected) {
    if (isPrompt(row)) permissionPrompts++;
    if (isApproval(row)) permissionApprovals++;
    if (isDenial(row)) permissionDenials++;

    if (row.decision === "allow-by-envelope-grant") {
      if (row.envelopeGrant === "reuse") envelopeGrantReuses++;
      else envelopeGrantsCreated++;
    }
    if (row.decision === "grant-invalidated") envelopeGrantInvalidations++;
    if (row.decision === "grant-revoked") envelopeGrantRevocations++;
    if (row.decision === "sandbox-failure") sandboxFailures++;
  }

  return {
    permissionPrompts,
    permissionApprovals,
    permissionDenials,
    envelopeGrantsCreated,
    envelopeGrantReuses,
    envelopeGrantInvalidations,
    envelopeGrantRevocations,
    sandboxFailures,
  };
}
