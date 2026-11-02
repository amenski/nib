#!/usr/bin/env tsx
/**
 * Command-risk-classifier rollout numbers from the permission audit rows in
 * ~/.nib/sessions (docs/command-risk-classifier.md §11), to decide when
 * `classifier.mode` can move from `shadow` to `enforce`.
 *
 *   npx tsx scripts/classifier-stats.ts [--days N] [--since YYYY-MM-DD] [--home DIR]
 *
 * Reads `run_bash` rows that carry a risk verdict and reports, for all rows and
 * split by auto / non-auto posture (in auto the classifier already enforces, so
 * the non-auto group is the one an `enforce` default would change): the tier
 * counts, classifier-caused asks (the rules would allow, the classifier wants an
 * ask) and how many of those the user approved, classifier-caused blocks and how
 * many of those the user overrode, and parse coverage. `--since` adds a group for rows on or after that date, e.g.
 * the day a classifier fix landed.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { resolveHome } from "../src/config/loader.js";
import { computeSessionPermissionMetrics } from "../src/sessions/metrics.js";
import type { PermissionAuditRecord } from "../src/sessions/store.js";

type Row = PermissionAuditRecord & { at?: string };

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const days = Number(arg("--days") ?? 14);
const sinceArg = arg("--since");
const since = sinceArg ? Date.parse(`${sinceArg}T00:00:00Z`) : undefined;
if (Number.isNaN(days) || (sinceArg && Number.isNaN(since))) {
  console.error("usage: classifier-stats.ts [--days N] [--since YYYY-MM-DD] [--home DIR]");
  process.exit(2);
}
const sessionsDir = join(arg("--home") ?? resolveHome(), "sessions");
const oldest = Date.now() - days * 86_400_000;

function loadRows(): Row[] {
  const rows: Row[] = [];
  for (const dir of readdirSync(sessionsDir, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    for (const file of readdirSync(join(sessionsDir, dir.name))) {
      if (!file.endsWith(".jsonl")) continue;
      const path = join(sessionsDir, dir.name, file);
      if (statSync(path).mtimeMs < oldest) continue;
      for (const line of readFileSync(path, "utf-8").split("\n")) {
        if (!line.includes('"type":"permission"')) continue;
        try {
          const row = JSON.parse(line) as Row & { type: string };
          if (row.type === "permission" && row.tool === "run_bash" && row.risk !== undefined) rows.push(row);
        } catch {
          // A torn last line of a live session; skip it.
        }
      }
    }
  }
  return rows.filter((r) => r.at === undefined || Date.parse(r.at) >= oldest);
}

const pct = (n: number, d: number): string => (d === 0 ? "n/a" : `${((100 * n) / d).toFixed(1)}%`);

function report(label: string, rows: Row[]): void {
  console.log(`\n${label}: ${rows.length} bash rows`);
  if (rows.length === 0) return;
  const m = computeSessionPermissionMetrics(rows);
  const blocks = rows.filter((r) => r.risk!.nativeAction === "deny" && r.risk!.engineAction !== "deny");
  // A block the user then approved by hand: the proxy for §11's "block FPR".
  const overridden = blocks.filter((r) => ["ask-approved", "once", "session", "always"].includes(r.decision)).length;
  const parsed = rows.filter((r) => r.risk!.parseStatus === "parsed").length;
  const t = m.riskTierCounts;
  console.log(`  tiers                  safe ${t.safe} · benign ${t.benign} · confirm ${t.confirm} · block ${t.block}`);
  console.log(`  classifier-caused asks ${m.classifierCausedAsks} (${pct(m.classifierCausedAsks, rows.length)} of rows; target < 5%)`);
  console.log(`  ...approved by user    ${m.classifierCausedAsksApproved} (${pct(m.classifierCausedAsksApproved, m.classifierCausedAsks)} of those; target < 15%)`);
  console.log(`  classifier-caused blocks ${blocks.length} (${pct(blocks.length, rows.length)} of rows)`);
  console.log(`  ...overridden by user  ${overridden} (${pct(overridden, blocks.length)} of those; target < 10%)`);
  console.log(`  parse coverage         ${pct(parsed, rows.length)} (target > 90%)`);
}

const rows = loadRows();
console.log(`classifier stats: last ${days} days, ${sessionsDir}`);
report("all postures", rows);
report("auto posture (classifier already enforces)", rows.filter((r) => r.auto !== undefined));
report("non-auto posture (what an enforce default would change)", rows.filter((r) => r.auto === undefined));
if (since !== undefined) {
  report(`since ${sinceArg}`, rows.filter((r) => r.at !== undefined && Date.parse(r.at) >= since));
}
