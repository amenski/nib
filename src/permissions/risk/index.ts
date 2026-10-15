import type { PermissionAction } from "../rules.js";
import { extractRiskFeatures, type RiskFeatures, type RiskInput } from "./features.js";
import { evaluateRiskRules, RISK_RULESET_VERSION, type RiskTier } from "./rules.js";
import { formatRiskReason } from "./reasons.js";

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
  stage: "rules";
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
  verdict: RiskVerdict,
  mode: RiskMode,
): PermissionAction {
  if (mode !== "enforce") return engineAction;
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
