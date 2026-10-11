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
 * Resolve a persisted choice without collapsing the origin marker. `false`
 * means the value came from a mode default and must be recomputed on resume;
 * `undefined` is a legacy session with ambiguous origin, so preserve it.
 */
export function resolveRestoredSelection<T>(
  value: T | undefined,
  explicit: boolean | undefined,
): { value: T | undefined; explicit: boolean } {
  if (explicit === false) return { value: undefined, explicit: false };
  if (value === undefined) return { value: undefined, explicit: false };
  return { value, explicit: true };
}
