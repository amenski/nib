import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelCapabilities } from "./types.js";
import { resolveHome } from "../config/loader.js";
import { CATALOG_CACHE_FILENAME } from "./catalog-update.js";

/**
 * The on-disk shape of models.json (generated bundle and user override).
 * Provider integration settings are kept separately in provider-presets.json.
 */
export interface CatalogModel extends ModelCapabilities {
  free?: boolean;
}

export interface CatalogProvider {
  label?: string;
  api: string;
  baseUrl: string;
  keyEnv: string;
  defaultModel: string;
  models: Record<string, CatalogModel>;
}

export interface ModelCatalog {
  providers: Record<string, CatalogProvider>;
}

const BUNDLED_PATH = new URL("./models.json", import.meta.url);
const PRESETS_PATH = new URL("./provider-presets.json", import.meta.url);

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function loadJsonFile(path: string | URL): Record<string, unknown> | null {
  try {
    const content = readFileSync(path, "utf-8");
    const parsed = JSON.parse(content);
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Deep-merge a user provider entry onto a bundled one: scalar fields
 * (label/api/baseUrl/keyEnv/defaultModel) are replaced wholesale when present,
 * and `models` is merged key-by-key so a user can override one model's fields
 * without repeating every other model in that provider.
 */
function mergeProvider(
  base: CatalogProvider | undefined,
  override: Partial<CatalogProvider>,
): CatalogProvider {
  const models: Record<string, CatalogModel> = { ...(base?.models ?? {}) };
  if (isObject(override.models)) {
    for (const [modelId, modelOverride] of Object.entries(override.models as Record<string, unknown>)) {
      if (!isObject(modelOverride)) continue;
      models[modelId] = { ...(models[modelId] ?? {}), ...(modelOverride as Partial<CatalogModel>) } as CatalogModel;
    }
  }
  return {
    label: override.label ?? base?.label,
    api: override.api ?? base?.api ?? "openai-compatible",
    baseUrl: override.baseUrl ?? base?.baseUrl ?? "",
    keyEnv: override.keyEnv ?? base?.keyEnv ?? "",
    defaultModel: override.defaultModel ?? base?.defaultModel ?? Object.keys(models)[0] ?? "",
    models,
  };
}

/**
 * Load the bundled catalog and merge the user override
 * (`~/.heirloom/models.json`) on top, provider-by-provider then
 * model-by-model, user wins. A missing user file is normal (no warning); a
 * malformed one warns to stderr and is skipped entirely so startup never
 * crashes on bad JSON — matching readCredentialsFile/loadConfig.
 */
export function loadModelCatalog(homeDir?: string): ModelCatalog {
  const bundledRaw = loadJsonFile(BUNDLED_PATH);
  const presetsRaw = loadJsonFile(PRESETS_PATH);
  const bundledProviders = isObject(bundledRaw?.providers) ? (bundledRaw!.providers as Record<string, unknown>) : {};
  const presetProviders = isObject(presetsRaw?.providers) ? (presetsRaw!.providers as Record<string, unknown>) : {};

  const providers: Record<string, CatalogProvider> = {};
  const providerNames = new Set([...Object.keys(presetProviders), ...Object.keys(bundledProviders)]);
  for (const name of providerNames) {
    const preset = isObject(presetProviders[name]) ? presetProviders[name] : {};
    const models = isObject(bundledProviders[name]) ? bundledProviders[name] : {};
    providers[name] = mergeProvider(undefined, { ...(preset as Partial<CatalogProvider>), ...(models as Partial<CatalogProvider>) });
  }

  const home = homeDir ?? resolveHome();

  // `heirloom models update` writes a refreshed snapshot here (distinct from
  // the bundled models.json above, which never changes). It sits between the
  // bundled catalog and the user override so a hand-edited
  // ~/.heirloom/models.json still wins over an updated snapshot (plan §2
  // decision 5). A missing or unreadable cache file is normal (no update has
  // run yet, or `models update` was never confirmed) and silently falls back
  // to the bundled catalog, same as a missing user override.
  const cachedRaw = loadJsonFile(join(home, CATALOG_CACHE_FILENAME));
  const cachedProviders = isObject(cachedRaw?.providers) ? (cachedRaw!.providers as Record<string, unknown>) : {};
  for (const [name, entry] of Object.entries(cachedProviders)) {
    if (!isObject(entry)) continue;
    providers[name] = mergeProvider(providers[name], entry as Partial<CatalogProvider>);
  }

  const userPath = join(home, "models.json");
  const userRaw = readUserCatalog(userPath);
  if (userRaw) {
    const userProviders = isObject(userRaw.providers) ? (userRaw.providers as Record<string, unknown>) : {};
    for (const [name, entry] of Object.entries(userProviders)) {
      if (!isObject(entry)) continue;
      providers[name] = mergeProvider(providers[name], entry as Partial<CatalogProvider>);
    }
  }

  return { providers };
}

/**
 * Read provider-presets.json directly (integration facts: base URL, API
 * shape, key env var, default model — plan §2 decision 4). Exported so
 * `models update` can build its `defaultModels` generator input from the
 * exact same file scripts/generate-models.ts uses, without reimplementing
 * PRESETS_PATH's import.meta.url resolution (the reason this works both from
 * src/ and from a built dist/).
 */
export function loadProviderPresets(): Record<string, unknown> {
  return loadJsonFile(PRESETS_PATH) ?? { providers: {} };
}

/**
 * Read+parse the user override file. Missing file -> null (silent, expected).
 * Present-but-malformed (bad JSON, or a non-object root) -> warn to stderr and
 * return null so the caller falls back to the bundled catalog untouched.
 */
function readUserCatalog(path: string): Record<string, unknown> | null {
  let content: string;
  try {
    content = readFileSync(path, "utf-8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(content);
    if (!isObject(parsed)) {
      console.warn(`warning: ${path} must be a JSON object — ignoring and using the bundled model catalog`);
      return null;
    }
    return parsed;
  } catch (err) {
    console.warn(`warning: failed to parse ${path} (${(err as Error).message}) — using the bundled model catalog`);
    return null;
  }
}
