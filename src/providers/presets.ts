import { createAISDKProvider } from "./aisdk.js";
import type { Provider, ModelCapabilities } from "./types.js";
import { getCredential } from "../config/credentials.js";
import { loadModelCatalog, type CatalogModel } from "./catalog.js";

export interface ProviderPreset {
  label?: string;
  api: string;
  baseUrl: string;
  keyEnv: string;
  defaultModel: string;
  models: Record<string, CatalogModel & ModelCapabilities>;
}

/**
 * Built-in provider/model catalog, loaded from models.json (bundled) merged
 * with an optional `~/.nib/models.json` user override — see
 * ./catalog.ts. Kept as a plain object (not a function) so every existing
 * consumer that reads BUILTIN_PRESETS directly keeps working; it is populated
 * synchronously at module load, same as the previous hardcoded literal.
 *
 * NOTE: OpenAI models carry no `effort` cap — OpenAI's chat-completions API
 * rejects reasoning_effort when function tools are also present, and
 * Nib always sends tools.
 */
export const BUILTIN_PRESETS: Record<string, ProviderPreset> = Object.fromEntries(
  Object.entries(loadModelCatalog().providers).map(([name, p]) => [
    name,
    { label: p.label, api: p.api, baseUrl: p.baseUrl, keyEnv: p.keyEnv, defaultModel: p.defaultModel, models: p.models },
  ]),
);

export interface ProviderOptions {
  modelOverride?: string;
  baseUrl?: string;
  apiKey?: string;
}

let configProviders: Record<string, { api: string; baseUrl?: string; apiKeyEnv?: string; models?: Record<string, { contextWindow: number }> }> = {};

export function setConfigProviders(entries: Record<string, { api: string; baseUrl?: string; apiKeyEnv?: string; models?: Record<string, { contextWindow: number }> }>): void {
  configProviders = entries;
}

export function getKnownProviderNames(): string[] {
  const names = new Set([
    ...Object.keys(BUILTIN_PRESETS),
    ...Object.keys(configProviders),
  ]);
  return [...names];
}

/**
 * Whether an API key can be resolved for each known provider, using the same
 * precedence createProvider does (env var, then credentials.yaml). Returns
 * BOOLEANS ONLY — the UI needs to show "no key" without ever handling a secret.
 * Providers with no keyEnv (e.g. a local ollama) always count as configured.
 */
export function getConfiguredProviders(): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const name of getKnownProviderNames()) {
    const preset = BUILTIN_PRESETS[name];
    if (!preset || !preset.keyEnv) {
      out[name] = true;
      continue;
    }
    out[name] = !!(process.env[preset.keyEnv] || getCredential(name));
  }
  return out;
}

export function getPreset(name: string): ProviderPreset | undefined {
  return BUILTIN_PRESETS[name];
}

export function getProviderModels(name: string): Record<string, { contextWindow: number }> | undefined {
  const cp = configProviders[name];
  if (cp?.models) return cp.models;
  return undefined;
}

export function getContextWindowForModel(
  providerName: string,
  modelId: string,
  fallback: number,
): number {
  const models = getProviderModels(providerName);
  if (models) {
    const match = models[modelId];
    if (match?.contextWindow) return match.contextWindow;
  }
  const preset = BUILTIN_PRESETS[providerName];
  if (preset) {
    const match = preset.models[modelId] ?? preset.models[preset.defaultModel];
    if (match?.contextWindow) return match.contextWindow;
  }
  return fallback;
}

export function initPresets(): void {
}

export function createProvider(name: string, options?: ProviderOptions): Provider {
  const configEntry = configProviders[name];

  if (configEntry) {
    const apiKey = options?.apiKey
      || (configEntry.apiKeyEnv ? process.env[configEntry.apiKeyEnv] : undefined)
      || "";
    const model = options?.modelOverride ??
      (configEntry.models ? Object.keys(configEntry.models)[0] : "default");
    const preset: ProviderPreset = {
      api: configEntry.api,
      baseUrl: options?.baseUrl ?? configEntry.baseUrl ?? "",
      keyEnv: configEntry.apiKeyEnv ?? "",
      defaultModel: model,
      models: {},
    };
    return createAISDKProvider(preset, model, apiKey);
  }

  const preset = BUILTIN_PRESETS[name];
  if (!preset) {
    throw new Error(
      `Unknown provider: "${name}". Known: ${getKnownProviderNames().join(", ")}`,
    );
  }

  const apiKey = options?.apiKey
    || (preset.keyEnv ? process.env[preset.keyEnv] : undefined)
    || getCredential(name)
    || "";
  if (!apiKey && preset.keyEnv) {
    throw new Error(
      `Provider "${name}" requires ${preset.keyEnv} to be set, or run \`nib auth\` to store a key in credentials.yaml`,
    );
  }

  // Honor a config-supplied base URL (settings.json env.BASE_URL) for built-in
  // presets — otherwise the hardcoded preset baseUrl always wins and there is no
  // way to point a provider at a proxy/gateway (QA B2).
  const effectivePreset: ProviderPreset = options?.baseUrl
    ? { ...preset, baseUrl: options.baseUrl }
    : preset;

  return createAISDKProvider(
    effectivePreset,
    options?.modelOverride ?? preset.defaultModel,
    apiKey,
  );
}
