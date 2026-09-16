import { describe, expect, it } from "vitest";
import { extractApplyPatchPlan, unknownCapabilityPlan } from "./capabilities.js";

describe("unknownCapabilityPlan", () => {
  it("cannot create a persistent approval scope", () => {
    expect(unknownCapabilityPlan("apply_patch", "patch targets were not parsed")).toEqual({
      tool: "apply_patch",
      capabilities: [],
      status: "unknown",
      reason: "patch targets were not parsed",
      allowPersistentApproval: false,
    });
  });
});

describe("extractApplyPatchPlan", () => {
  it("extracts immutable read/write capabilities for every patch target", () => {
    const plan = extractApplyPatchPlan({
      patch: "+++ b/src/a.ts\n@@ -1 +1 @@\n-x\n+y\n+++ b/src/b.ts\n@@ -1 +1 @@\n-x\n+y",
    }, "/workspace");

    expect(plan).toMatchObject({
      tool: "apply_patch",
      status: "known",
      allowPersistentApproval: false,
      targets: [
        { rawPath: "src/a.ts", path: "/workspace/src/a.ts" },
        { rawPath: "src/b.ts", path: "/workspace/src/b.ts" },
      ],
    });
    expect(plan.capabilities).toContainEqual({ type: "fs.read", path: "/workspace/src/a.ts" });
    expect(plan.capabilities).toContainEqual({ type: "fs.write", path: "/workspace/src/b.ts" });
  });

  it("fails closed when a target escapes the workspace", () => {
    expect(extractApplyPatchPlan({ patch: "+++ b/../outside.txt\n@@ -1 +1 @@\n-x\n+y" }, "/workspace"))
      .toMatchObject({ status: "unknown", allowPersistentApproval: false });
  });
});
