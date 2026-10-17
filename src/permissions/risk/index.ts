import type { PermissionAction } from "../rules.js";
import { extractRiskFeatures, type RiskFeatures, type RiskInput } from "./features.js";
import { evaluateRiskRules, RISK_RULESET_VERSION, type RiskTier } from "./rules.js";
import { formatRiskReason } from "./reasons.js";
import { runStage2, type Stage2Options, type Stage2Outcome } from "./model.js";

export type { RiskFeatures, RiskInput } from "./features.js";
export type { RiskTier } from "./rules.js";
export { RISK_RULESET_VERSION } from "./rules.js";
export {
  AUTO_STAGE1_TIMEOUT_MS,
  AUTO_STAGE2_TIMEOUT_MS,
  AUTO_TAGS,
  AutoModeState,
  autoBlockMessage,
  autoHardStop,
  buildAutoPrompt,
  parseAutoStage1,
  parseAutoStage2,
  priorToolCalls,
  runAutoJudge,
  type AutoJudgeResult,
  type AutoModeOptions,
} from "./auto.js";
export {
  runStage2,
  buildStage2Prompt,
  buildStage2SystemPrompt,
  parseStage2Answer,
  parseStage2Reason,
  STAGE2_TIMEOUT_MS,
  type RiskJudge,
  type Stage2Options,
  type Stage2Outcome,
  type Stage2Result,
} from "./model.js";

/**
 * The classifier's public surface (docs/command-risk-classifier.md §3):
 * `classifyRisk` labels a call, `applyRiskVerdict` turns that label into an
 * action.
 *
 * The clamp is the whole safety argument, and it lives in nine lines below.
 * A tier maps to a *native* action, and the result is the more restrictive of
 * that and what the engine already decided — never the less restrictive. So
 * `safe` and `benign` cannot quiet a prompt the engine wanted, `confirm` can
 * only turn an allow into an ask, and `block` is the only thing that denies.
 * This is locked Decision 5 (docs/security-architecture-plan.md:121): the
 * classifier has no authority to widen access.
 */

/** Where the classifier is switched off, watching, or deciding. */
export type RiskMode = "off" | "shadow" | "enforce";

export const RISK_MODES: readonly RiskMode[] = ["off", "shadow", "enforce"];

export interface RiskVerdict {
  tier: RiskTier;
  /**
   * What the rule engine resolved to on its own, before the clamp. Persisted
   * so a shadow-mode row is readable without reconstructing the engine's
   * answer from the decision vocabulary (proposal §8, and the baseline
   * script's (features, tier, engineAction, userDecision) dump).
   */
  engineAction: PermissionAction;
  /** The action this tier would apply in enforce mode, before the clamp. */
  nativeAction: PermissionAction;
  /** §3.3's clamped action: `max(engine, native)`, what enforce mode returns. */
  action: PermissionAction;
  score: number;
  /** Short tags, primary first. Empty for safe/benign. */
  reasons: string[];
  /** Persisted for replay. §8 routes `features.targets` through the redactor. */
  features: RiskFeatures;
  /** Rules-only for now; phase 3 (§6) would add "rules+model". */
  stage: "rules" | "rules+model";
  /**
   * Present whenever the model stage ran, including when it failed. Absent
   * means the stage was off, skipped, or not configured — which is why the
   * outcome is spelled out rather than the field being named after its verdict
   * (proposal §3.2 calls it `modelVerdict`; a timeout has no verdict, and the
   * metrics need the attempt recorded either way).
   */
  model?: {
    outcome: Stage2Outcome;
    latencyMs: number;
    reason?: string;
    tag?: string;
  };
  version: string;
  parseStatus: RiskFeatures["parse"];
  /**
   * The model-facing sentence (§3.4), present only when the tier is stricter
   * than the engine's own action — i.e. only when the classifier is the reason
   * a prompt or a denial exists. Absent means the engine's reason stands.
   */
  message?: string;
}

const NATIVE_ACTION: Record<RiskTier, PermissionAction> = {
  safe: "allow",
  benign: "allow",
  confirm: "ask",
  block: "deny",
};

/** allow < ask < deny. */
const ACTION_RANK: Record<PermissionAction, number> = { allow: 0, ask: 1, deny: 2 };

function mostRestrictive(a: PermissionAction, b: PermissionAction): PermissionAction {
  return ACTION_RANK[a] >= ACTION_RANK[b] ? a : b;
}

/**
 * §3.3's table as a function. Total and monotonic by construction: the result
 * is always at least as restrictive as `engineAction`.
 */
export function riskNativeAction(tier: RiskTier): PermissionAction {
  return NATIVE_ACTION[tier];
}

export function applyRiskVerdict(
  engineAction: PermissionAction,
  verdict: RiskVerdict | undefined,
  mode: RiskMode,
): PermissionAction {
  if (mode !== "enforce" || verdict === undefined) return engineAction;
  return mostRestrictive(engineAction, verdict.nativeAction);
}

/** Whether this verdict is what made the call stricter than the engine's own action. */
export function riskNarrowed(engineAction: PermissionAction, verdict: RiskVerdict): boolean {
  return ACTION_RANK[verdict.nativeAction] > ACTION_RANK[engineAction];
}

/**
 * Classifies one tool call. Deterministic and synchronous — no model call, no
 * filesystem access, no clock — so it can run on every call inside the gate.
 */
export function classifyRisk(input: RiskInput): RiskVerdict {
  const features = extractRiskFeatures(input);
  const { tier, reasons, score } = evaluateRiskRules(features, input);
  const nativeAction = NATIVE_ACTION[tier];
  const action = mostRestrictive(input.engine.action, nativeAction);
  const narrowed = ACTION_RANK[nativeAction] > ACTION_RANK[input.engine.action];

  return {
    tier,
    engineAction: input.engine.action,
    nativeAction,
    action,
    score,
    reasons,
    features,
    stage: "rules",
    version: RISK_RULESET_VERSION,
    parseStatus: features.parse,
    ...(narrowed && reasons.length > 0
      ? { message: formatRiskReason(tier === "block" ? "block" : "confirm", reasons) }
      : {}),
  };
}

/**
 * §6.1's gate for the model stage. It runs only where it can add something and
 * cannot waste a call:
 *
 *   - the rules reached `safe` or `benign`, so there is nothing a judge could
 *     sharpen — a rules `confirm` or `block` already asks or denies;
 *   - the call is shell or MCP, which is where the opaque long tail lives (and
 *     the only place whose arguments carry no file contents, §3.1);
 *   - no explicit user allow rule produced it. A user's own rule answers the
 *     question; a judge does not get to second-guess it.
 *
 * On that last point: for shell and MCP calls, an allow whose `origin` is
 * `config` or `session` can only be user-authored. The engine's builtin allows
 * (`builtin-allow.ts`) and its dynamic write-boundary allow carry the same
 * `origin: "config"`, but both apply to read and write tools respectively —
 * neither can reach here. A `defaultMode: allowAll` fallthrough has no
 * `winningRule` at all, so it is judged like any other call.
 */
export function shouldRunStage2(input: RiskInput, verdict: RiskVerdict): boolean {
  if (verdict.tier !== "safe" && verdict.tier !== "benign") return false;
  const shellOrMcp =
    input.tool === "run_bash" || input.tool === "run_bash_background" || input.tool.startsWith("mcp__");
  if (!shellOrMcp) return false;

  const rule = input.engine.winningRule;
  if (
    input.engine.action === "allow" &&
    rule?.action === "allow" &&
    (rule.origin === "config" || rule.origin === "session")
  ) {
    return false;
  }
  return true;
}

/**
 * Rules first, then the optional model stage (§6.1). Async because the judge is
 * a network call; `classifyRisk` above stays synchronous and deterministic so
 * the spawn-time check and every existing caller are unaffected.
 *
 * The judge is *additive*: it can move `safe|benign` to `confirm` and nothing
 * else. `block` is unreachable from here, so a flagged call is a prompt, never
 * a denial.
 */
export async function classifyRiskWithModel(
  input: RiskInput,
  options: Stage2Options | undefined,
): Promise<RiskVerdict> {
  const verdict = classifyRisk(input);
  if (options === undefined || !shouldRunStage2(input, verdict)) return verdict;

  const result = await runStage2(input, verdict.features, options);
  const model: NonNullable<RiskVerdict["model"]> = {
    outcome: result.outcome,
    latencyMs: result.latencyMs,
    ...(result.reason !== undefined ? { reason: result.reason } : {}),
    ...(result.tag !== undefined ? { tag: result.tag } : {}),
  };

  // §7: every outcome but `flag` leaves the rules' verdict standing. A flaky or
  // unparseable model must never create a prompt.
  if (result.outcome !== "flag") return { ...verdict, stage: "rules+model", model };

  const tier: RiskTier = "confirm";
  const nativeAction = NATIVE_ACTION[tier];
  const action = mostRestrictive(input.engine.action, nativeAction);
  const reasons = result.tag !== undefined ? [result.tag] : [];
  const reason = result.reason ?? "a review of this call flagged it";

  return {
    ...verdict,
    tier,
    nativeAction,
    action,
    score: 0.7,
    reasons,
    stage: "rules+model",
    model,
    ...(ACTION_RANK[nativeAction] > ACTION_RANK[input.engine.action]
      ? // The model's own sentence is what a human should read: it says what it
        // saw, and the tag it chose is already on the row (proposal §7).
        { message: `A review of this call flagged it: ${reason}` }
      : {}),
  };
}
