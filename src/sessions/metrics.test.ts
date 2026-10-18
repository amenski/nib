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
      riskTierCounts: { safe: 0, benign: 0, confirm: 0, block: 0 },
      classifierCausedAsks: 0,
      classifierCausedAsksApproved: 0,
      blocks: 0,
      stage2Calls: 0,
      stage2Flags: 0,
      stage2FailedOpen: 0,
      stage2P95Ms: 0,
      autoAllows: 0,
      autoBlocks: 0,
      autoFallbacks: 0,
      autoJudgeCalls: 0,
      autoStage2Calls: 0,
      autoP95Ms: 0,
    });
  });

  it("counts the auto posture: allows, blocks, fallbacks, judge calls, stage 2, and a p95", () => {
    const auto = (stage: string, outcome: string, latencyMs: number) => ({ stage, outcome, latencyMs });
    const metrics = computeSessionPermissionMetrics([
      { tool: "read_file", subject: "a.ts", decision: "allow-by-classifier", auto: auto("readonly", "allow", 0) },
      { tool: "run_bash", subject: "npm test", decision: "allow-by-classifier", auto: auto("stage1", "allow", 100) },
      { tool: "run_bash", subject: "curl x", decision: "allow-by-classifier", auto: auto("stage2", "allow", 900) },
      { tool: "run_bash", subject: "rm -rf x", decision: "deny-by-classifier", auto: auto("stage1", "block", 200) },
      { tool: "run_bash", subject: "ls", decision: "ask-approved", auto: auto("stage1", "timeout", 3000) },
      { tool: "run_bash", subject: "ls", decision: "ask-approved", auto: auto("fallback", "allow", 0) },
      { tool: "run_bash", subject: "ls", decision: "ask-approved", auto: auto("rules", "hard-stop", 0) },
    ] as never);

    expect(metrics.autoAllows).toBe(3);
    expect(metrics.autoBlocks).toBe(1);
    expect(metrics.autoFallbacks).toBe(3);
    expect(metrics.autoJudgeCalls).toBe(4);
    expect(metrics.autoStage2Calls).toBe(1);
    expect(metrics.autoP95Ms).toBe(3000);
    // Auto allows are approvals, auto blocks are denials, neither is a prompt.
    expect(metrics.permissionApprovals).toBe(6);
    expect(metrics.permissionDenials).toBe(1);
    expect(metrics.permissionPrompts).toBe(3);
  });

  it("counts the risk tiers, the asks it caused, and the blocks", () => {
    const riskOf = (engineAction: string, nativeAction: string, tier: string, reasons: string[] = []) => ({
      tier, engineAction, nativeAction, action: nativeAction,
      score: 0.7, reasons, stage: "rules", version: "risk-1", parseStatus: "parsed",
      features: {},
    });
    const metrics = computeSessionPermissionMetrics([
      { tool: "run_bash", subject: "ls", decision: "allow-by-rule", risk: riskOf("allow", "allow", "safe") } as never,
      // The classifier's own product: the engine would have allowed, the
      // verdict asks, and the user then approved it.
      { tool: "run_bash", subject: "cat .env", decision: "ask-approved", risk: riskOf("allow", "ask", "confirm", ["fs.secret-ref"]) } as never,
      { tool: "run_bash", subject: "npm publish", decision: "ask-denied", reason: "denied by user at prompt", risk: riskOf("allow", "ask", "confirm", ["pkg.publish"]) } as never,
      { tool: "run_bash", subject: "rm -rf /", decision: "deny-by-rule", risk: riskOf("deny", "deny", "block", ["rm.critical-path"]) } as never,
      // The engine already asked: the classifier is not what made this a prompt.
      { tool: "run_bash", subject: "curl https://x.example", decision: "ask-approved", risk: riskOf("ask", "ask", "confirm", ["net.egress"]) } as never,
    ]);

    expect(metrics.riskTierCounts).toEqual({ safe: 1, benign: 0, confirm: 3, block: 1 });
    expect(metrics.classifierCausedAsks).toBe(2);
    expect(metrics.classifierCausedAsksApproved).toBe(1);
    expect(metrics.blocks).toBe(1);
  });

  it("counts the model stage: attempts, flags, failure modes, and a latency p95", () => {
    const withModel = (outcome: string, latencyMs: number) => ({
      tier: "benign", engineAction: "allow", nativeAction: "allow", action: "allow",
      score: 0.2, reasons: [], stage: "rules+model", version: "risk-1", parseStatus: "parsed",
      features: {}, model: { outcome, latencyMs },
    });
    const metrics = computeSessionPermissionMetrics([
      // Five ok calls and one flag, with latencies chosen so the nearest-rank
      // p95 is unambiguous (index ceil(6*0.95)-1 = 5, the last one).
      { tool: "run_bash", subject: "npm test", decision: "allow-by-rule", risk: withModel("ok", 100) } as never,
      { tool: "run_bash", subject: "npm test", decision: "allow-by-rule", risk: withModel("ok", 200) } as never,
      { tool: "run_bash", subject: "npm test", decision: "allow-by-rule", risk: withModel("ok", 300) } as never,
      { tool: "run_bash", subject: "npm test", decision: "allow-by-rule", risk: withModel("ok", 400) } as never,
      { tool: "run_bash", subject: "npm test", decision: "allow-by-rule", risk: withModel("timeout", 3000) } as never,
      { tool: "run_bash", subject: "npm test", decision: "allow-by-rule", risk: withModel("flag", 500) } as never,
      // A row with a rules-only verdict has no model record and is not a call.
      { tool: "run_bash", subject: "ls", decision: "allow-by-rule" } as never,
    ]);

    expect(metrics.stage2Calls).toBe(6);
    expect(metrics.stage2Flags).toBe(1);
    // A timeout fails open: no change made, and worth counting separately from
    // a flag, because a judge that keeps timing out is a different problem.
    expect(metrics.stage2FailedOpen).toBe(1);
    expect(metrics.stage2P95Ms).toBe(3000);
  });

  it("reports a zero p95 rather than NaN when the stage never ran", () => {
    const metrics = computeSessionPermissionMetrics([
      { tool: "run_bash", subject: "ls", decision: "allow-by-rule" },
    ]);
    expect(metrics.stage2P95Ms).toBe(0);
    expect(metrics.stage2Calls).toBe(0);
  });

  it("counts rows written before the classifier existed nowhere, not as a tier", () => {
    const metrics = computeSessionPermissionMetrics([
      { tool: "run_bash", subject: "ls", decision: "allow-by-rule" },
    ]);
    expect(metrics.riskTierCounts).toEqual({ safe: 0, benign: 0, confirm: 0, block: 0 });
    expect(metrics.classifierCausedAsks).toBe(0);
    expect(metrics.blocks).toBe(0);
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
