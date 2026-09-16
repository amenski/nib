import { describe, it, expect } from "vitest";
import { buildPermissionRequest, capabilitySummary, permissionOptions, riskLevel, type PermissionRequest } from "./PermissionPrompt.js";
import type { PermissionRule } from "../permissions/index.js";
import { extractCapabilityPlan, unknownCapabilityPlan } from "../permissions/capabilities.js";

function req(toolName: string, winningRule?: PermissionRule): PermissionRequest {
  return { toolName, command: "", winningRule };
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
