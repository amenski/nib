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
