import { describe, it, expect } from "vitest";
import { resolveSubagentEffort } from "./model-policy.js";
import type { ModelCapabilities } from "../providers/types.js";

const withEffort: ModelCapabilities = {
  supportsTools: true,
  contextWindow: 100000,
  effort: { values: ["low", "medium", "high"], default: "medium" },
};
const noEffort: ModelCapabilities = { supportsTools: true, contextWindow: 100000 };

describe("resolveSubagentEffort", () => {
  it("is undefined when the model has no effort capability", () => {
    expect(resolveSubagentEffort(undefined, { mode: { reasoningEffort: "low" } })).toBeUndefined();
    expect(resolveSubagentEffort(noEffort, { explicitEffort: "high", mode: { reasoningEffort: "low" } })).toBeUndefined();
  });

  it("uses a valid explicit effort over the mode's", () => {
    expect(resolveSubagentEffort(withEffort, { explicitEffort: "high", mode: { reasoningEffort: "low" } })).toBe("high");
  });

  it("falls back to the model default when the explicit effort is invalid for the model", () => {
    expect(resolveSubagentEffort(withEffort, { explicitEffort: "max", mode: { reasoningEffort: "low" } })).toBe("medium");
  });

  it("uses the mode's reasoningEffort when valid", () => {
    expect(resolveSubagentEffort(withEffort, { mode: { reasoningEffort: "low" } })).toBe("low");
  });

  it("falls back to the model default when the mode's effort is invalid", () => {
    expect(resolveSubagentEffort(withEffort, { mode: { reasoningEffort: "max" } })).toBe("medium");
  });

  it("uses the model default when the mode declares nothing, low for general", () => {
    expect(resolveSubagentEffort(withEffort, { mode: { slug: "code" } })).toBe("medium");
    expect(resolveSubagentEffort(withEffort, { mode: { slug: "general" } })).toBe("low");
  });
});
