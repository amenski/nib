import type { ModelCapabilities } from "../providers/types.js";

/** A model reference as used by mode/config/CLI settings: provider/model. */
export interface ParsedModelId {
  provider: string;
  model: string;
}

/**
 * Split a provider/model reference while keeping bare model names compatible
 * with the existing provider-relative configuration behavior.
 */
export function parseModelId(modelId: string | undefined, fallbackProvider: string): ParsedModelId | undefined {
  if (!modelId) return undefined;
  const slash = modelId.indexOf("/");
  if (slash <= 0 || slash === modelId.length - 1) {
    return { provider: fallbackProvider, model: modelId };
  }
  return { provider: modelId.slice(0, slash), model: modelId.slice(slash + 1) };
}

export const GENERAL_MODEL_ID = "deepseek/deepseek-flash";
export const GENERAL_REASONING_EFFORT = "low";

/**
 * Resolve a resumed session's persisted choice. Whatever the session last
 * used is kept as-is — a mode default included — so it counts as explicit and
 * startup never re-seeds it from the mode.
 */
export function resolveRestoredSelection<T>(value: T | undefined): { value: T | undefined; explicit: boolean } {
  return { value, explicit: value !== undefined };
}

/**
 * The reasoning effort a `new_task` sub-run streams with. The user's explicit
 * choice (`/effort`, settings.json, a resumed session) wins when the sub-run's
 * model accepts it; otherwise the sub-mode's own `reasoningEffort`; a value the
 * model rejects, or nothing declared, falls back to the model's default (the
 * General mode's low default aside — the parent applies the same rule).
 * `undefined` when the model has no effort capability.
 */
export function resolveSubagentEffort(
  caps: ModelCapabilities | undefined,
  choice: { explicitEffort?: string; mode: { slug?: string; reasoningEffort?: string } },
): string | undefined {
  const effort = caps?.effort;
  if (!effort) return undefined;
  const valid = (value: string | undefined): value is string => value !== undefined && effort.values.includes(value);
  if (choice.explicitEffort !== undefined) return valid(choice.explicitEffort) ? choice.explicitEffort : effort.default;
  const modeEffort = choice.mode.reasoningEffort || (choice.mode.slug === "general" ? GENERAL_REASONING_EFFORT : undefined);
  return valid(modeEffort) ? modeEffort : effort.default;
}
