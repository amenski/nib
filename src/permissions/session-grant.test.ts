import { describe, expect, it } from "vitest";
import { SessionGrantStore, bashEnvelopeGrants, type GrantInput } from "./session-grant.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function input(overrides: Partial<GrantInput> = {}): GrantInput {
  return {
    sessionId: "s1",
    tool: "run_bash",
    profileHash: HASH_A,
    level: "workspace-write",
    trustedRoot: "/work",
    writeRoots: [],
    ...overrides,
  };
}

describe("SessionGrantStore", () => {
  it("stores a grant and returns it for the same session, tool and envelope", () => {
    const store = new SessionGrantStore();
    expect(store.lookup("s1", "run_bash", HASH_A)).toBeNull();

    store.grant(input());

    const grant = store.lookup("s1", "run_bash", HASH_A);
    expect(grant?.profileHash).toBe(HASH_A);
    expect(grant?.level).toBe("workspace-write");
    expect(grant?.trustedRoot).toBe("/work");
    expect(typeof grant?.grantedAt).toBe("number");
  });

  // The envelope binding: a grant is consent for one profile's bytes. A launch
  // whose profile differs must not reuse it, or a write root the user never
  // approved would run under an old approval.
  it("does not reuse a grant approved against a different envelope", () => {
    const store = new SessionGrantStore();
    store.grant(input());

    expect(store.lookup("s1", "run_bash", HASH_B)).toBeNull();
    // The stale grant is still there until it is explicitly invalidated, so the
    // gate can report *why* the user is being asked again.
    expect(store.active("s1", "run_bash")?.profileHash).toBe(HASH_A);
  });

  it("does not leak a grant across sessions or tools", () => {
    const store = new SessionGrantStore();
    store.grant(input());

    expect(store.lookup("s2", "run_bash", HASH_A)).toBeNull();
    expect(store.lookup("s1", "run_bash", HASH_A)).not.toBeNull();
  });

  it("invalidates a grant approved against a different envelope, once", () => {
    const store = new SessionGrantStore();
    store.grant(input());

    expect(store.invalidateOther("s1", "run_bash", HASH_B)).toBe(true);
    expect(store.active("s1", "run_bash")).toBeNull();
    // Nothing left to invalidate, and a matching envelope is never touched.
    expect(store.invalidateOther("s1", "run_bash", HASH_B)).toBe(false);
    store.grant(input());
    expect(store.invalidateOther("s1", "run_bash", HASH_A)).toBe(false);
    expect(store.active("s1", "run_bash")).not.toBeNull();
  });

  it("replaces a grant for the same session and tool", () => {
    const store = new SessionGrantStore();
    store.grant(input());
    const first = store.active("s1", "run_bash")?.grantedAt;

    // A refresh: the same envelope, re-approved.
    store.grant(input());

    const refreshed = store.active("s1", "run_bash");
    expect(refreshed?.profileHash).toBe(HASH_A);
    expect(refreshed?.grantedAt).toBeGreaterThanOrEqual(first!);
  });

  it("revokes the active grant, reporting whether there was one", () => {
    const store = new SessionGrantStore();
    store.grant(input());

    expect(store.revoke("s1", "run_bash")).toBe(true);
    expect(store.active("s1", "run_bash")).toBeNull();
    expect(store.lookup("s1", "run_bash", HASH_A)).toBeNull();
    expect(store.revoke("s1", "run_bash")).toBe(false);
  });

  it("exposes the module singleton the gate and the panel share", () => {
    expect(bashEnvelopeGrants).toBeInstanceOf(SessionGrantStore);
  });
});
