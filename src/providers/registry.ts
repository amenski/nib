import type { ModelCapabilities } from "./types.js";
import { getPreset } from "./presets.js";

export function getProviderCapabilities(name: string, modelId?: string): ModelCapabilities {
  const preset = getPreset(name);
  if (!preset) return { supportsTools: true, contextWindow: 128000 };
  return preset.models[modelId ?? preset.defaultModel] ?? preset.models[preset.defaultModel];
}

/**
 * A one-line caution to surface when `imageCount` images are about to be sent to
 * a model that is not declared as accepting image input, or undefined when there
 * is nothing worth saying.
 *
 * It warns on "not declared capable", not only on a known text-only model. The
 * shipped catalog carries no modality data (see ModelCapabilities.vision), and an
 * undeclared model is precisely the case that fails quietly: the provider either
 * ignores the image or rejects the request, and nothing on our side says so. The
 * message names the escape hatch so the warning is actionable, not noise.
 */
export function imageSupportWarning(
  providerName: string,
  activeModel: string | undefined,
  imageCount: number,
): string | undefined {
  if (imageCount <= 0) return undefined;
  const caps = getProviderCapabilities(providerName, activeModel);
  if (caps.vision === true) return undefined;

  const label = caps.displayName ?? activeModel ?? "the active model";
  const plural = imageCount === 1 ? "image" : "images";

  if (caps.vision === false) {
    return `${label} does not accept image input — the attached ${plural} will be ignored or rejected.`;
  }
  return `${label} is not declared as accepting image input — the attached ${plural} may be ignored. Set "vision": true for this model to record that it can see images.`;
}
