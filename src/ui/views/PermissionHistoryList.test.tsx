import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "ink-testing-library";
import { __resetInputWireForTests } from "../hooks/useTerminalInput.js";
import { stripAnsi } from "../test-helpers.js";
import { bashEnvelopeGrants } from "../../permissions/session-grant.js";
import PermissionHistoryList from "./PermissionHistoryList.js";

const SESSION = "panel-session";
const mounted: Array<{ unmount: () => void }> = [];
const flush = () => new Promise((resolve) => setTimeout(resolve, 60));
const flatten = (frame: string) => stripAnsi(frame).replace(/[│╭╮╰╯─]/g, " ").replace(/\s+/g, " ").trim();

/** The panel's session store, as far as the panel uses it. */
function fakeStore() {
  const appendPermission = vi.fn(async () => {});
  return {
    appendPermission,
    queryPermissionHistory: vi.fn(async () => []),
    queryPermissionMetrics: vi.fn(async () => null),
  };
}

function grantOnce(): void {
  bashEnvelopeGrants.grant({
    sessionId: SESSION,
    tool: "run_bash",
    profileHash: "a".repeat(64),
    level: "workspace-write",
    trustedRoot: "/work/project",
    writeRoots: ["/work/project", "/tmp/nib-scratch"],
    sessionTempDir: "/tmp/nib-scratch",
  });
}

afterEach(() => {
  while (mounted.length) mounted.pop()!.unmount();
  __resetInputWireForTests();
  bashEnvelopeGrants.revoke(SESSION, "run_bash");
});

const RISK_METRICS = {
  permissionPrompts: 2,
  permissionApprovals: 1,
  permissionDenials: 0,
  envelopeGrantsCreated: 0,
  envelopeGrantReuses: 0,
  envelopeGrantInvalidations: 0,
  envelopeGrantRevocations: 0,
  sandboxFailures: 0,
  riskTierCounts: { safe: 4, benign: 9, confirm: 2, block: 1 },
  classifierCausedAsks: 2,
  classifierCausedAsksApproved: 1,
  blocks: 1,
  stage2Calls: 14,
  stage2Flags: 3,
  stage2FailedOpen: 1,
  stage2P95Ms: 480,
  autoAllows: 0,
  autoBlocks: 0,
  autoFallbacks: 0,
  autoJudgeCalls: 0,
  autoStage2Calls: 0,
  autoP95Ms: 0,
};

/** A classified row, as the audit trail stores one. */
function riskRow(overrides: Record<string, unknown>) {
  return {
    tool: "run_bash",
    subject: "rm -rf /",
    decision: "deny-by-rule",
    at: "2026-10-15T10:00:00.000Z",
    risk: {
      tier: "block",
      engineAction: "deny",
      nativeAction: "deny",
      action: "deny",
      score: 1,
      reasons: ["rm.critical-path", "tmp.wildcard-delete"],
      stage: "rules",
      version: "risk-1",
      parseStatus: "parsed",
      features: {},
    },
    ...overrides,
  };
}

describe("PermissionHistoryList: the risk verdict", () => {
  it("shows the tier counts and the asks the classifier caused on the metrics line", async () => {
    const store = {
      ...fakeStore(),
      queryPermissionMetrics: vi.fn(async () => RISK_METRICS),
    };
    const inst = render(
      <PermissionHistoryList sessionStore={store as never} sessionId={SESSION} onClose={vi.fn()} width={140} />,
    );
    mounted.push(inst);
    await flush();

    const frame = flatten(inst.lastFrame() ?? "");
    expect(frame).toContain("safe 4 · benign 9 · confirm 2 · block 1");
    expect(frame).toContain("classifier-caused asks 2/1 approved");
    expect(frame).toContain("blocks 1");
    expect(frame).toContain("model judge 14 calls, 3 flagged, p95 480ms");
  });

  it("shows the auto segment only when an auto counter is non-zero", async () => {
    const renderWith = async (m: unknown) => {
      const store = { ...fakeStore(), queryPermissionMetrics: vi.fn(async () => m) };
      const inst = render(
        <PermissionHistoryList sessionStore={store as never} sessionId={SESSION} onClose={vi.fn()} width={200} />,
      );
      mounted.push(inst);
      await flush();
      return flatten(inst.lastFrame() ?? "");
    };
    expect(await renderWith(RISK_METRICS)).not.toContain("auto 0");
    expect(await renderWith({ ...RISK_METRICS, autoAllows: 5, autoBlocks: 2, autoFallbacks: 1 }))
      .toContain("auto 5 allowed · 2 blocked · 1 asked");
  });

  it("labels the classifier decisions", async () => {
    const store = {
      ...fakeStore(),
      queryPermissionHistory: vi.fn(async () => [
        { tool: "run_bash", subject: "npm test", decision: "allow-by-classifier", at: "2026-10-15T10:00:00.000Z" },
        { tool: "run_bash", subject: "rm x", decision: "deny-by-classifier", at: "2026-10-15T10:00:01.000Z" },
      ]),
    };
    const inst = render(
      <PermissionHistoryList sessionStore={store as never} sessionId={SESSION} onClose={vi.fn()} width={140} />,
    );
    mounted.push(inst);
    await flush();
    const frame = flatten(inst.lastFrame() ?? "");
    expect(frame).toContain("auto allow");
    expect(frame).toContain("auto block");
  });

  it("leaves the model judge out of the line when the stage never ran", async () => {
    const store = {
      ...fakeStore(),
      queryPermissionMetrics: vi.fn(async () => ({ ...RISK_METRICS, stage2Calls: 0 })),
    };
    const inst = render(
      <PermissionHistoryList sessionStore={store as never} sessionId={SESSION} onClose={vi.fn()} width={140} />,
    );
    mounted.push(inst);
    await flush();

    expect(flatten(inst.lastFrame() ?? "")).not.toContain("model judge");
  });

  it("shows the tier and the first reason tag on the row", async () => {
    const store = {
      ...fakeStore(),
      queryPermissionHistory: vi.fn(async () => [riskRow({})]),
    };
    const inst = render(
      <PermissionHistoryList sessionStore={store as never} sessionId={SESSION} onClose={vi.fn()} width={140} />,
    );
    mounted.push(inst);
    await flush();

    const frame = flatten(inst.lastFrame() ?? "");
    expect(frame).toContain("risk:");
    expect(frame).toContain("block");
    // The first tag, not the whole list: the row is one line, and the primary
    // reason is the one the model and the prompt are shown.
    expect(frame).toContain("(rm.critical-path)");
    expect(frame).not.toContain("(tmp.wildcard-delete)");
  });

  it("leaves a row written before the classifier existed unlabelled", async () => {
    const store = {
      ...fakeStore(),
      queryPermissionHistory: vi.fn(async () => [riskRow({ risk: undefined, subject: "ls" })]),
    };
    const inst = render(
      <PermissionHistoryList sessionStore={store as never} sessionId={SESSION} onClose={vi.fn()} width={140} />,
    );
    mounted.push(inst);
    await flush();

    expect(flatten(inst.lastFrame() ?? "")).not.toContain("risk:");
  });
});

describe("PermissionHistoryList", () => {
  it("shows the active grant with its limits and the revoke hint", async () => {
    grantOnce();
    const inst = render(
      <PermissionHistoryList sessionStore={fakeStore() as never} sessionId={SESSION} onClose={vi.fn()} width={100} />,
    );
    mounted.push(inst);
    await flush();

    const frame = flatten(inst.lastFrame() ?? "");
    expect(frame).toContain("Session grant active: sandboxed Bash in /work/project");
    expect(frame).toContain("Writable: /work/project, /tmp/nib-scratch");
    // The forward-only limit is stated where the revocation happens too.
    expect(frame).toContain("does not undo changes already made");
    expect(frame).toContain("does not stop a command that is already running");
    expect(frame).toContain("r revoke session grant");
  });

  it("revokes the grant on r, records it, and stops offering the revoke", async () => {
    grantOnce();
    const store = fakeStore();
    const inst = render(
      <PermissionHistoryList sessionStore={store as never} sessionId={SESSION} onClose={vi.fn()} width={100} />,
    );
    mounted.push(inst);
    await flush();

    inst.stdin.write("r");
    await flush();

    expect(bashEnvelopeGrants.active(SESSION, "run_bash")).toBeNull();
    expect(store.appendPermission).toHaveBeenCalledWith(
      SESSION,
      expect.objectContaining({ tool: "run_bash", decision: "grant-revoked" }),
    );
    const frame = flatten(inst.lastFrame() ?? "");
    expect(frame).not.toContain("Session grant active");
    expect(frame).not.toContain("r revoke session grant");
  });

  it("offers nothing to revoke when no grant is active", async () => {
    const store = fakeStore();
    const inst = render(
      <PermissionHistoryList sessionStore={store as never} sessionId={SESSION} onClose={vi.fn()} width={100} />,
    );
    mounted.push(inst);
    await flush();

    inst.stdin.write("r");
    await flush();

    expect(store.appendPermission).not.toHaveBeenCalled();
    expect(flatten(inst.lastFrame() ?? "")).not.toContain("Session grant active");
  });
});
