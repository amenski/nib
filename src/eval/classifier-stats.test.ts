import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * scripts/classifier-stats.ts against a synthetic session, so the definitions
 * it reports (caused ask vs caused block vs override) stay pinned: they were
 * once mislabelled by hand, and the rollout decision reads these numbers.
 */
const SCRIPT = resolve(import.meta.dirname, "..", "..", "scripts", "classifier-stats.ts");
const TSX = resolve(import.meta.dirname, "..", "..", "node_modules", ".bin", "tsx");

function row(over: Record<string, unknown>, risk: Record<string, unknown>) {
  return JSON.stringify({
    type: "permission",
    at: new Date().toISOString(),
    tool: "run_bash",
    subject: "x",
    decision: "allow-by-rule",
    risk: { tier: "benign", engineAction: "allow", nativeAction: "allow", action: "allow", score: 0, reasons: [], parseStatus: "parsed", ...risk },
    ...over,
  });
}

describe("classifier-stats script", () => {
  let home: string;

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), "nib-classifier-stats-"));
    const dir = join(home, "sessions", "proj");
    mkdirSync(dir, { recursive: true });
    const lines = [
      row({}, {}), // plain benign row
      row({ decision: "ask-approved" }, { tier: "confirm", nativeAction: "ask", action: "ask" }), // caused ask, approved
      row({ decision: "deny-by-classifier" }, { tier: "block", nativeAction: "deny", action: "deny" }), // caused block
      row({ decision: "ask-approved" }, { tier: "block", nativeAction: "deny", action: "deny" }), // caused block, overridden
      row({}, { parseStatus: "partial" }), // lowers parse coverage
      row({ tool: "read_file" }, { tier: "block", nativeAction: "deny" }), // not a bash row: ignored
    ];
    writeFileSync(join(dir, "s1.jsonl"), lines.join("\n") + "\n");
  });

  afterAll(() => rmSync(home, { recursive: true, force: true }));

  it("counts caused asks, caused blocks, overrides and parse coverage separately", () => {
    const out = spawnSync(TSX, [SCRIPT, "--home", home, "--days", "30"], { encoding: "utf-8" }).stdout;
    const all = out.split("\n\n")[0] + out.split("\n\n")[1];
    expect(out).toContain("all postures: 5 bash rows");
    expect(all).toMatch(/classifier-caused asks 1 \(20\.0% of rows/);
    expect(all).toMatch(/\.\.\.approved by user\s+1 \(100\.0% of those/);
    expect(all).toMatch(/classifier-caused blocks 2 \(40\.0% of rows/);
    expect(all).toMatch(/\.\.\.overridden by user\s+1 \(50\.0% of those/);
    expect(all).toMatch(/parse coverage\s+80\.0%/);
  });
});
