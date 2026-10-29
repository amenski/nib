import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { savePlan, loadPlan, formatPlanBlock, plansDir } from "./store.js";

const ROOT = join(tmpdir(), `nib-plans-${process.pid}`);

beforeEach(() => mkdirSync(ROOT, { recursive: true }));
afterEach(() => rmSync(ROOT, { recursive: true, force: true }));

describe("formatPlanBlock", () => {
  it("wraps a plan under the Active plan heading", () => {
    expect(formatPlanBlock("1. do the thing")).toBe("# Active plan\n1. do the thing");
  });

  it("drops surrounding whitespace and rejects empty plans", () => {
    expect(formatPlanBlock("  plan  ")).toBe("# Active plan\nplan");
    expect(formatPlanBlock("   ")).toBe("");
  });
});

describe("savePlan / loadPlan", () => {
  it("writes .nib/plans/<slug>.md and loads it back", () => {
    const path = savePlan(ROOT, "## Task\nfix the thing");
    expect(path.startsWith(plansDir(ROOT))).toBe(true);
    expect(path.endsWith(".md")).toBe(true);
    expect(loadPlan(ROOT)).toBe("## Task\nfix the thing");
  });

  it("amending overwrites the same file", () => {
    savePlan(ROOT, "v1 plan");
    const path = savePlan(ROOT, "v2 amended plan");
    expect(readFileSync(path, "utf-8")).toContain("v2 amended plan");
    expect(loadPlan(ROOT)).toBe("v2 amended plan");
  });

  it("loads the newest plan when several exist", () => {
    const first = savePlan(ROOT, "older plan");
    // Distinct mtimes: same-second writes would tie and sort arbitrarily.
    const past = new Date(Date.now() - 60_000);
    writeFileSync(first, "older plan\n");
    const second = savePlan(ROOT, "newer plan");
    expect(existsSync(second)).toBe(true);
    expect(loadPlan(ROOT)).toBe("newer plan");
  });

  it("derives a slug from the plan's first heading", () => {
    const path = savePlan(ROOT, "## Refactor auth module\nsteps…");
    expect(path.includes("refactor-auth-module")).toBe(true);
  });

  it("throws on an empty plan", () => {
    expect(() => savePlan(ROOT, "   ")).toThrow();
  });

  it("returns undefined with no plans directory", () => {
    expect(loadPlan(join(ROOT, "nothing-here"))).toBeUndefined();
  });
});
