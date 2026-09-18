import { describe, it, expect } from "vitest";
import { buildPermissionRequest, capabilitySummary, grantConsentLines, permissionOptions, riskLevel, type PermissionRequest } from "./PermissionPrompt.js";
import type { PermissionRule } from "../permissions/index.js";
import type { BashEnvelope } from "../permissions/session-grant.js";
import { extractCapabilityPlan, unknownCapabilityPlan } from "../permissions/capabilities.js";

function req(toolName: string, winningRule?: PermissionRule): PermissionRequest {
  return { toolName, command: "", winningRule };
}

/** A containment envelope of the shape the gate hands the prompt. */
function envelope(overrides: Partial<BashEnvelope> = {}): BashEnvelope {
  return {
    profileHash: "0".repeat(64),
    level: "workspace-write",
    trustedRoot: "/work/project",
    writeRoots: ["/work/project", "/tmp/nib-scratch"],
    sessionTempDir: "/tmp/nib-scratch",
    ...overrides,
  };
}

describe("riskLevel", () => {
  it("is high for any destructive-origin winning rule, regardless of tool", () => {
    const destructiveRule: PermissionRule = { tool: "run_bash", kind: "prefix", pattern: "git reset --hard", action: "deny", origin: "builtin-destructive" };
    const risk = riskLevel(req("run_bash", destructiveRule));
    expect(risk.level).toBe("high");
    expect(risk.slot).toBe("error");
  });

  it("is low for read-only tools with no destructive match", () => {
    expect(riskLevel(req("read_file")).level).toBe("low");
    expect(riskLevel(req("read_file")).slot).toBe("success");
    expect(riskLevel(req("list_files")).level).toBe("low");
    expect(riskLevel(req("glob")).level).toBe("low");
  });

  it("is medium for run_bash and write tools with no destructive match", () => {
    expect(riskLevel(req("run_bash")).level).toBe("medium");
    expect(riskLevel(req("run_bash")).slot).toBe("warning");
    expect(riskLevel(req("write_to_file")).level).toBe("medium");
    expect(riskLevel(req("edit")).level).toBe("medium");
  });

  it("a non-destructive winning rule does not force high risk", () => {
    const ordinaryRule: PermissionRule = { tool: "read_file", kind: "glob", pattern: "./**", action: "allow", origin: "config" };
    expect(riskLevel(req("read_file", ordinaryRule)).level).toBe("low");
  });
});

describe("permissionOptions", () => {
  it("offers only once or deny when persistent approval is unavailable", () => {
    const options = permissionOptions({ toolName: "apply_patch", command: "patch", allowPersistentApproval: false });

    expect(options.map((option) => option.decision)).toEqual(["once", "deny"]);
  });

  it("offers exactly three options, with the session grant, on an eligible Bash ask", () => {
    const options = permissionOptions({
      toolName: "run_bash",
      command: "timeout 60 python3 mcp_probe.py --check",
      allowPersistentApproval: true,
      envelope: envelope(),
    });

    expect(options.map((option) => option.decision)).toEqual(["once", "envelope-grant", "deny"]);
    // The grant's label says what it is for and that it is sandbox-scoped —
    // "always" is gone, because an exact-command rule is not what is on offer.
    expect(options[1]!.label).toBe("Yes, sandboxed Bash in this workspace for this session");
  });

  it("offers no grant option without an envelope, however Bash-like the ask", () => {
    const options = permissionOptions({
      toolName: "run_bash",
      command: "npm test",
      allowPersistentApproval: true,
    });

    expect(options.map((option) => option.decision)).toEqual(["once", "session", "always", "deny"]);
  });
});

describe("grantConsentLines", () => {
  it("states the write, read, network, boundary and revocation limits", () => {
    const lines = grantConsentLines(envelope());
    const copy = lines.join("\n");

    // Every limit the redesign doc requires the user to be told.
    expect(copy).toContain("Writable: /work/project, /tmp/nib-scratch");
    expect(copy).toContain("not the machine's shared temporary directories");
    expect(copy).toContain("Direct network connections from those children are denied");
    expect(copy).toContain("macOS name resolution may still occur outside the child");
    expect(copy).toContain("files outside your home directory can still be readable");
    expect(copy).toContain(".env");
    expect(copy).toContain("Denied and guarded commands still ask.");
    expect(copy).toContain("Revoke this in /permissions");
    expect(copy).toContain("does not undo changes already made");
    expect(copy).toContain("does not stop a command that is already running");
  });

  // strict-sandbox grants no writes at all, so the copy must not claim the
  // workspace — or anything else — is writable, and must not fall back to
  // naming the level.
  it("says nothing is writable when the profile grants no writes", () => {
    const copy = grantConsentLines(envelope({ level: "strict-sandbox", writeRoots: [] })).join("\n");

    expect(copy).toContain("Writable: nothing");
    expect(copy).not.toContain("/work/project");
    expect(copy).not.toContain("workspace-write");
    expect(copy).not.toContain("strict-sandbox");
  });

  it("warns when a write root is outside the home directory, and only then", () => {
    const outside = grantConsentLines(envelope({ writeRoots: ["/work/project"] })).join("\n");
    const home = process.env.HOME!;
    const inside = grantConsentLines(envelope({ writeRoots: [home] })).join("\n");

    expect(outside).toContain("Outside your home directory: /work/project");
    expect(inside).not.toContain("Outside your home directory");
  });
});

describe("capabilitySummary", () => {
  it("shows the concrete filesystem effects from a known plan", () => {
    const plan = extractCapabilityPlan("edit", { path: "src/example.ts" }, "/workspace");

    expect(capabilitySummary(plan, "/workspace")).toEqual(["Read ./src/example.ts", "Write ./src/example.ts"]);
  });

  it("renders the supplied canonical plan without rebuilding it from request arguments", () => {
    const plan = unknownCapabilityPlan("edit", "path is missing");
    const request = buildPermissionRequest("edit", { path: "ignored-by-the-plan" }, undefined, undefined, plan, "/workspace");

    expect(request.capabilityPlan).toBe(plan);
    expect(capabilitySummary(request.capabilityPlan, request.workingDir)).toEqual([
      "Unknown effects — full risk; this tool's capabilities could not be determined.",
    ]);
  });

  it("shows process commands and network destinations", () => {
    expect(capabilitySummary(extractCapabilityPlan("run_bash", { command: "git status" }, "/workspace")))
      .toEqual(["Execute git status"]);
    expect(capabilitySummary(extractCapabilityPlan("web_fetch", { url: "https://example.com" }, "/workspace")))
      .toEqual(["Connect to example.com"]);
  });

  it("states full risk when the canonical plan is unknown or absent", () => {
    const expected = "Unknown effects — full risk; this tool's capabilities could not be determined.";
    expect(capabilitySummary(unknownCapabilityPlan("apply_patch", "patch is missing"))).toEqual([expected]);
    expect(capabilitySummary()).toEqual([expected]);
  });
});
