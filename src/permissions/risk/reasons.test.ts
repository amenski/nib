import { describe, it, expect } from "vitest";
import { BLOCK_RULES, CONFIRM_RULES } from "./rules.js";
import { formatRiskReason, knownReasonTags, riskReasonText } from "./reasons.js";

describe("the reason table covers the ruleset", () => {
  it("every block and confirm rule has a sentence", () => {
    const tags = [...BLOCK_RULES, ...CONFIRM_RULES].map((r) => r.tag);
    const missing = tags.filter((tag) => !knownReasonTags().includes(tag));
    expect(missing, `no reason text for: ${missing.join(", ")}`).toEqual([]);
  });

  it("has no sentence that no rule can produce", () => {
    const tags = new Set([...BLOCK_RULES, ...CONFIRM_RULES].map((r) => r.tag));
    // `auto.*` tags are chosen by the auto-mode judge (auto.ts), not emitted by a rule.
    const orphans = knownReasonTags().filter((tag) => !tags.has(tag) && !tag.startsWith("auto."));
    expect(orphans, `reason text for tags no rule emits: ${orphans.join(", ")}`).toEqual([]);
  });

  it("declares each tag once", () => {
    expect(new Set(knownReasonTags()).size).toBe(knownReasonTags().length);
  });
});

describe("sentences are usable by the model", () => {
  it("tells the model what to do, not only what was seen", () => {
    // The audit and the prompt both show these; a sentence with no rewrite
    // hint leaves the model to guess and retry the same call.
    for (const tag of knownReasonTags()) {
      const text = riskReasonText(tag);
      expect(text.length, tag).toBeGreaterThan(40);
      expect(text, tag).toMatch(/\.$/);
    }
  });

  it("falls back rather than throwing for an unknown tag", () => {
    expect(riskReasonText("not.a.tag")).toContain("not.a.tag");
  });
});

describe("formatRiskReason", () => {
  it("leads with the primary tag and the reason", () => {
    expect(formatRiskReason("block", ["rm.critical-path"])).toMatch(
      /^Blocked by nib policy \[rm.critical-path\]: this is a recursive force/,
    );
  });

  it("names secondary tags without burying the primary", () => {
    const text = formatRiskReason("block", ["tmp.wildcard-delete", "rm.critical-path"]);
    expect(text).toContain("[tmp.wildcard-delete]");
    expect(text).toContain("Also matched: rm.critical-path.");
  });

  it("phrases a confirm as a question rather than a refusal", () => {
    expect(formatRiskReason("confirm", ["fs.secret-ref"])).toMatch(/^Asking first \[fs\.secret-ref\]:/);
  });
});
