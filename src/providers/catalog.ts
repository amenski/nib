import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelCapabilities } from "./types.js";
import { resolveHome } from "../config/loader.js";
import { CATALOG_CACHE_FILENAME } from "./catalog-update.js";
import { ensurePrivateDirectoryAsync, writePrivateFile } from "../config/state-permissions.js";
import { defaultKeyEnv } from "./catalog-generator.js";

export { defaultKeyEnv };

/**
 * The on-disk shape of models.json (generated bundle, `models update` cache
 * and user override): each provider's connection settings plus its models.
 */
export interface CatalogModel extends ModelCapabilities {
  free?: boolean;
}

export interface CatalogProvider {
  label?: string;
  /** Listed first in `nib auth` and always shown in the model picker. */
  featured?: boolean;
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
    ...((override.featured ?? base?.featured) ? { featured: true } : {}),
    api: override.api ?? base?.api ?? "openai-compatible",
    baseUrl: override.baseUrl ?? base?.baseUrl ?? "",
    keyEnv: override.keyEnv ?? base?.keyEnv ?? "",
    defaultModel: override.defaultModel ?? base?.defaultModel ?? Object.keys(models)[0] ?? "",
    models,
  };
}

/**
 * Load the bundled catalog and merge the user override
 * (`~/.nib/models.json`) on top, provider-by-provider then
 * model-by-model, user wins. A missing user file is normal (no warning); a
 * malformed one warns to stderr and is skipped entirely so startup never
 * crashes on bad JSON — matching readCredentialsFile/loadConfig.
 */
export function loadModelCatalog(homeDir?: string): ModelCatalog {
  const bundledRaw = loadJsonFile(BUNDLED_PATH);
  const bundledProviders = isObject(bundledRaw?.providers) ? (bundledRaw!.providers as Record<string, unknown>) : {};

  const providers: Record<string, CatalogProvider> = {};
  for (const [name, entry] of Object.entries(bundledProviders)) {
    if (isObject(entry)) providers[name] = mergeProvider(undefined, entry as Partial<CatalogProvider>);
  }

  const home = homeDir ?? resolveHome();

  // `nib models update` writes a refreshed snapshot here (distinct from
  // the bundled models.json above, which never changes). It sits between the
  // bundled catalog and the user override so a hand-edited
  // ~/.nib/models.json still wins over an updated snapshot (plan §2
  // decision 5). A missing or unreadable cache file is normal (no update has
  // run yet, or `models update` was never confirmed) and silently falls back
  // to the bundled catalog, same as a missing user override.
  const cachedRaw = loadJsonFile(join(home, CATALOG_CACHE_FILENAME));
  const cachedProviders = isObject(cachedRaw?.providers) ? (cachedRaw!.providers as Record<string, unknown>) : {};
  // Only models and the default model come from the cache: connection fields
  // (the host a key is sent to) always come from the bundle, so a cache left
  // by an older nib can never pin an outdated base URL.
  for (const [name, entry] of Object.entries(cachedProviders)) {
    if (!isObject(entry) || !providers[name]) continue;
    const { models, defaultModel } = entry as Partial<CatalogProvider>;
    providers[name] = mergeProvider(providers[name], { models, ...(typeof defaultModel === "string" ? { defaultModel } : {}) });
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

/** Featured provider names (deepseek, openai, …), in catalog order. */
export function featuredProviderNames(catalog: ModelCatalog = loadModelCatalog()): string[] {
  return Object.keys(catalog.providers).filter((name) => catalog.providers[name].featured);
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

/** The provider entry `nib auth` writes to `~/.nib/models.json`. */
export interface UserProviderEntry {
  label: string;
  baseUrl: string;
  keyEnv: string;
  defaultModel: string;
  models: Record<string, CatalogModel>;
}

/** Capabilities for a model nib has no metadata for (registry.ts's fallback). */
export const UNKNOWN_MODEL_CAPS: CatalogModel = { supportsTools: true, contextWindow: 128000 };

/**
 * Read `~/.nib/models.json`, let `mutate` change its providers map, write it
 * back. A missing file starts empty; a present-but-malformed one throws
 * instead of being overwritten: it is the user's hand-edited file. Returns
 * the file path.
 */
async function updateUserCatalog(
  homeDir: string | undefined,
  mutate: (providers: Record<string, unknown>) => void,
): Promise<string> {
  const home = homeDir ?? resolveHome();
  const path = join(home, "models.json");

  let root: Record<string, unknown> = { providers: {} };
  let content: string | null = null;
  try {
    content = readFileSync(path, "utf-8");
  } catch {
    // Missing file: start from an empty catalog.
  }
  if (content !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (err) {
      throw new Error(`${path} is not valid JSON (${(err as Error).message}) — fix or remove it first`);
    }
    if (!isObject(parsed)) throw new Error(`${path} must be a JSON object — fix or remove it first`);
    root = parsed;
  }

  const providers = isObject(root.providers) ? root.providers : {};
  mutate(providers);
  root.providers = providers;

  await ensurePrivateDirectoryAsync(home);
  await writePrivateFile(path, JSON.stringify(root, null, 2) + "\n");
  return path;
}

/**
 * Add (or update) an OpenAI-compatible provider in `~/.nib/models.json` —
 * the `nib auth` "Custom URL" path. Other providers, and models already
 * listed for this one (possibly hand-tuned), are kept. Returns the file path.
 */
export async function saveUserProvider(name: string, entry: UserProviderEntry, homeDir?: string): Promise<string> {
  return updateUserCatalog(homeDir, (providers) => {
    const existing = isObject(providers[name]) ? providers[name] : {};
    const existingModels = isObject(existing.models) ? existing.models : {};
    providers[name] = {
      ...existing,
      label: entry.label,
      api: "openai-compatible",
      baseUrl: entry.baseUrl,
      keyEnv: entry.keyEnv,
      defaultModel: entry.defaultModel,
      models: { ...entry.models, ...existingModels },
    };
  });
}

/**
 * Set (or with `undefined`, clear) only a catalog provider's `defaultModel`
 * in `~/.nib/models.json` — the `nib auth` path for a bundled provider, whose
 * connection and models stay in the bundled catalog. Any other override for
 * it is kept; a provider block left empty is removed. Returns the file path.
 */
export async function saveUserDefaultModel(name: string, defaultModel: string | undefined, homeDir?: string): Promise<string> {
  return updateUserCatalog(homeDir, (providers) => {
    const { defaultModel: _previous, ...rest } = isObject(providers[name]) ? providers[name] : {};
    const next = defaultModel === undefined ? rest : { ...rest, defaultModel };
    if (Object.keys(next).length === 0) delete providers[name];
    else providers[name] = next;
  });
}
