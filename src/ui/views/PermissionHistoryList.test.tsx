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
