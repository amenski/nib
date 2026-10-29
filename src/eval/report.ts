import { writeFileSync } from "node:fs";
import type { PermissionAuditRecord } from "../sessions/store.js";
import type { ModelCapabilities } from "../providers/types.js";

/**
 * The eval harness's two ends live here: what a headless run reports about
 * itself (`NIB_EVAL_REPORT`), and how `scripts/eval.ts` aggregates trials.
 * Both are plain data so a case's assertion and its unit test can read the
 * same shape without spawning a model.
 */

/** One permission decision, trimmed to the fields an assertion asks about. */
export interface EvalPermissionRow {
  tool: string;
  subject: string;
  decision: string;
  riskTier?: string;
  riskReasons?: string[];
}

/**
 * What a headless run writes when `NIB_EVAL_REPORT` names a path. Cost is an
 * estimate from the bundled catalog's approximate pricing — `null` when the
 * model has none ("free" and "unknown" are different facts).
 */
export interface HeadlessReport {
  provider: string;
  model: string;
  stopReason: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  costUsd: number | null;
  /** How many times compaction replaced the live history this run. */
  compactions: number;
  permissions: EvalPermissionRow[];
}

export function computeCostUsd(
  pricing: ModelCapabilities["pricing"],
  inputTokens: number,
  outputTokens: number,
): number | null {
  if (!pricing) return null;
  return (inputTokens * pricing.inputPerM + outputTokens * pricing.outputPerM) / 1_000_000;
}

export function toPermissionRows(rows: readonly PermissionAuditRecord[]): EvalPermissionRow[] {
  return rows.map((row) => ({
    tool: row.tool,
    subject: row.subject,
    decision: row.decision,
    ...(row.risk !== undefined ? { riskTier: row.risk.tier, riskReasons: [...row.risk.reasons] } : {}),
  }));
}

export function writeHeadlessReport(path: string, report: HeadlessReport): void {
  writeFileSync(path, JSON.stringify(report, null, 2) + "\n");
}

/** One case's outcome in one trial. */
export interface TrialResult {
  pass: boolean;
  message: string;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
}

export interface CaseReport {
  name: string;
  trials: TrialResult[];
  /** Share of trials that passed, in [0, 1]. */
  passRate: number;
  inputTokens: number;
  outputTokens: number;
  /** Sum over trials; `null` when any trial had no pricing to price against. */
  costUsd: number | null;
}

export interface SuiteReport {
  startedAt: string;
  provider: string;
  model: string;
  trialsPerCase: number;
  cases: CaseReport[];
}

export function summarizeCase(name: string, trials: TrialResult[]): CaseReport {
  const passed = trials.filter((t) => t.pass).length;
  const priced = trials.every((t) => t.costUsd !== null);
  return {
    name,
    trials,
    passRate: trials.length === 0 ? 0 : passed / trials.length,
    inputTokens: trials.reduce((sum, t) => sum + t.inputTokens, 0),
    outputTokens: trials.reduce((sum, t) => sum + t.outputTokens, 0),
    costUsd: priced ? trials.reduce((sum, t) => sum + t.costUsd!, 0) : null,
  };
}

/**
 * The printed summary: one row per case with its pass rate, tokens and cost,
 * because a pass rate alone cannot tell "same score, one tenth the tokens"
 * from "same score, same tokens".
 */
export function formatSuiteTable(report: SuiteReport): string {
  const header = ["Task", "Pass", "Input", "Output", "Cost"];
  const rows = report.cases.map((c) => [
    c.name,
    `${Math.round(c.passRate * c.trials.length)}/${c.trials.length}`,
    String(c.inputTokens),
    String(c.outputTokens),
    c.costUsd === null ? "n/a" : `$${c.costUsd.toFixed(4)}`,
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cells: string[]): string =>
    cells.map((cell, i) => (i === 0 ? cell.padEnd(widths[i]) : cell.padStart(widths[i]))).join("  ");
  return [line(header), ...rows.map(line)].join("\n");
}

/** Mean pass rate across cases — the single number a harness change must move. */
export function overallPassRate(report: SuiteReport): number {
  const trials = report.cases.flatMap((c) => c.trials);
  if (trials.length === 0) return 0;
  return trials.filter((t) => t.pass).length / trials.length;
}
