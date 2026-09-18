import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeSessionPermissionMetrics } from "./metrics.js";
import { SessionStore } from "./store.js";

describe("session permission metrics", () => {
  it("deduplicates legacy UI rows and counts prompts, outcomes, and decisions separately", () => {
    const metrics = computeSessionPermissionMetrics([
      { toolCallId: "read-1", tool: "run_bash", subject: "cat README.md", decision: "once" },
      {
        toolCallId: "read-1", tool: "run_bash", subject: "cat README.md", decision: "ask-approved",
        commandClassification: { classification: "proven-read-only", reason: "allowlisted read-only command" },
      },
      { toolCallId: "deny-1", tool: "run_bash", subject: "rm -rf /", decision: "ask-denied", reason: "denied by user at prompt" },
      { toolCallId: "profile-1", tool: "edit", subject: "../secret", decision: "deny-by-profile" },
      // The classifier's own labels are advisory metadata now: this row counts
      // as an allow-by-rule like any other, and nothing reads the label.
      { toolCallId: "unknown-1", tool: "run_bash", subject: "npm test", decision: "allow-by-rule", commandClassification: { classification: "unknown", reason: "command is not on the allowlist" } },
    ]);

    expect(metrics).toEqual({
      permissionPrompts: 2,
      permissionApprovals: 1,
      permissionDenials: 2,
      envelopeGrantsCreated: 0,
      envelopeGrantReuses: 0,
      envelopeGrantInvalidations: 0,
      envelopeGrantRevocations: 0,
      sandboxFailures: 0,
    });
  });

  it("counts the session-grant lifecycle: consent prompts, reuse does not", () => {
    const rows = [
      // The consent: the user was asked, and answered with the session option.
      { tool: "run_bash", subject: "timeout 60 python3 mcp_probe.py", decision: "allow-by-envelope-grant" as const, envelopeGrant: "granted" as const },
      // Then calls that needed no prompt at all.
      { tool: "run_bash", subject: "npm test", decision: "allow-by-envelope-grant" as const, envelopeGrant: "reuse" as const },
      { tool: "run_bash", subject: "npm run build", decision: "allow-by-envelope-grant" as const, envelopeGrant: "reuse" as const },
      // The envelope changed: dropped, and the call was asked again (its own
      // ask-approved row is that prompt, not this one).
      { tool: "run_bash", subject: "npm run lint", decision: "grant-invalidated" as const },
      { tool: "run_bash", subject: "npm run lint", decision: "ask-approved" as const },
      { tool: "run_bash", subject: "npm run lint", decision: "grant-revoked" as const },
      { tool: "run_bash", subject: "npm run build", decision: "sandbox-failure" as const },
    ];

    const metrics = computeSessionPermissionMetrics(rows);

    expect(metrics).toMatchObject({
      // Two prompts: the consent itself, and the re-ask after the invalidation.
      // The reuses, the invalidation, the revocation and the failure are not
      // prompts — nothing was asked of the user for them.
      permissionPrompts: 2,
      // Three covered calls plus the re-ask: the work that actually ran.
      permissionApprovals: 4,
      envelopeGrantsCreated: 1,
      envelopeGrantReuses: 2,
      envelopeGrantInvalidations: 1,
      envelopeGrantRevocations: 1,
      sandboxFailures: 1,
    });
  });

  it("does not treat hook or headless denials as user prompts", () => {
    const metrics = computeSessionPermissionMetrics([
      { toolCallId: "hook-1", tool: "run_bash", subject: "cat README.md", decision: "ask-denied", reason: "denied by PermissionRequest hook" },
      { toolCallId: "headless-1", tool: "run_bash", subject: "npm test", decision: "headless-deny", reason: "headless" },
    ]);

    expect(metrics.permissionPrompts).toBe(0);
    expect(metrics.permissionApprovals).toBe(0);
    expect(metrics.permissionDenials).toBe(2);
  });

  it("persists classifier evidence in the local session store", async () => {
    // The evidence records are pre-existing store plumbing with no production
    // writer (see the release record): the false-allow metric they fed was
    // removed with the prompt redesign, and this test covers only what the
    // store still does with them.
    const home = mkdtempSync(join(tmpdir(), "nib-metrics-test-"));
    try {
      const store = new SessionStore(home);
      const sessionId = await store.create({ cwd: process.cwd(), provider: "test", model: "test", mode: "code" });
      await store.appendPermission(sessionId, {
        toolCallId: "call-1",
        tool: "run_bash",
        subject: "cat README.md",
        decision: "allow-by-rule",
        commandClassification: { classification: "proven-read-only", reason: "allowlisted read-only command" },
      });
      await store.appendClassifierEvidence(sessionId, {
        toolCallId: "call-1",
        source: "handler",
        reason: "handler reported a write side effect",
      });

      await expect(store.queryClassifierEvidence(sessionId)).resolves.toMatchObject([
        { toolCallId: "call-1", source: "handler", reason: "handler reported a write side effect" },
      ]);
      await expect(store.queryPermissionMetrics(sessionId)).resolves.toMatchObject({
        permissionPrompts: 0,
        permissionApprovals: 0,
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
