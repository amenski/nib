import { describe, expect, it } from "vitest";
import { unknownCapabilityPlan } from "./capabilities.js";

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
