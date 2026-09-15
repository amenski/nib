import { describe, it, expect } from "vitest";
import { permissionOptions, riskLevel, type PermissionRequest } from "./PermissionPrompt.js";
import type { PermissionRule } from "../permissions/index.js";

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
