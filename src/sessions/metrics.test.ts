import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeSessionPermissionMetrics } from "./metrics.js";
import { SessionStore } from "./store.js";

describe("session permission metrics", () => {
  it("deduplicates legacy UI rows and counts prompts, outcomes, and classifier results separately", () => {
    const metrics = computeSessionPermissionMetrics([
      { toolCallId: "read-1", tool: "run_bash", subject: "cat README.md", decision: "once" },
      {
        toolCallId: "read-1", tool: "run_bash", subject: "cat README.md", decision: "ask-approved",
        commandClassification: { classification: "proven-read-only", reason: "allowlisted read-only command" },
      },
      { toolCallId: "deny-1", tool: "run_bash", subject: "rm -rf /", decision: "ask-denied", reason: "denied by user at prompt" },
      { toolCallId: "profile-1", tool: "edit", subject: "../secret", decision: "deny-by-profile" },
      { toolCallId: "unknown-1", tool: "run_bash", subject: "npm test", decision: "allow-by-rule", commandClassification: { classification: "unknown", reason: "command is not on the allowlist" } },
    ]);

    expect(metrics).toEqual({
      permissionPrompts: 2,
      permissionApprovals: 1,
      permissionDenials: 2,
      classifierProvenReadOnly: 1,
      classifierUnknown: 1,
      falseAllowCount: 0,
      falseAllowRate: 0,
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

  it("counts false-allow only for explicit, matched policy or handler evidence", () => {
    const rows = [{
      toolCallId: "read-1", tool: "run_bash", subject: "cat README.md", decision: "allow-by-rule" as const,
      commandClassification: { classification: "proven-read-only" as const, reason: "allowlisted read-only command" },
    }];

    expect(computeSessionPermissionMetrics(rows, [
      { toolCallId: "other", source: "handler", reason: "side effect" },
      { toolCallId: "read-1", source: "policy", reason: "policy parser found a write" },
      { toolCallId: "read-1", source: "handler", reason: "" },
    ])).toMatchObject({ falseAllowCount: 1, falseAllowRate: 1 });
  });

  it("leaves the false-allow rate null when no positive classification exists", () => {
    expect(computeSessionPermissionMetrics([])).toMatchObject({
      classifierProvenReadOnly: 0,
      falseAllowCount: 0,
      falseAllowRate: null,
    });
  });

  it("persists classifier metadata and explicit evidence in the local session store", async () => {
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

      await expect(store.queryPermissionMetrics(sessionId)).resolves.toMatchObject({
        classifierProvenReadOnly: 1,
        classifierUnknown: 0,
        falseAllowCount: 1,
        falseAllowRate: 1,
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
