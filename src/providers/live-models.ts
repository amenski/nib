import { readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { resolveHome } from "../config/loader.js";
import { ensurePrivateDirectory, writePrivateFileSync } from "../config/state-permissions.js";

/**
 * Cache of the model ids each provider's own `/models` endpoint reports, so a
 * server-side rename or removal is visible before it breaks a session. Lives in
 * NIB_HOME next to the other Nib-owned state (see catalog-update.ts for the
 * same temp-file + rename convention).
 */
export const LIVE_MODELS_CACHE_FILENAME = "provider-models.json";
export const LIVE_MODELS_TTL_MS = 24 * 60 * 60 * 1000;
export const LIVE_MODELS_DEFAULT_TIMEOUT_MS = 5000;

export interface LiveModelsEntry {
  fetchedAt: number;
  models: string[];
}

export type LiveModelsCache = Record<string, LiveModelsEntry>;

export interface FetchProviderModelsOptions {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface GetLiveModelsOptions extends FetchProviderModelsOptions {
  provider: string;
  now?: () => number;
  homeDir?: string;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Ask one provider which models it serves. NEVER throws: a missing key, a
 * non-2xx response, a timeout/abort, an unparseable body, or an empty/invalid
 * list all resolve to null. The OpenAI `/models` shape is
 * `{ data: [{ id: string }] }`.
 */
export async function fetchProviderModels(
  options: FetchProviderModelsOptions,
): Promise<string[] | null> {
  const { baseUrl, apiKey, fetchImpl = fetch, timeoutMs = LIVE_MODELS_DEFAULT_TIMEOUT_MS } = options;
  if (!apiKey) return null;

  try {
    const url = `${baseUrl.replace(/\/+$/, "")}/models`;
    const res = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(timeoutMs),
      // Never follow a redirect: this request carries an API key, and a hop to
      // another host would take the header with it. Same posture as every other
      // credential-bearing probe here (probeSearXngHealth, web-search, web-fetch).
      redirect: "manual",
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: unknown };
    if (!Array.isArray(body?.data)) return null;
    const models: string[] = [];
    for (const entry of body.data) {
      if (isObject(entry) && typeof entry.id === "string" && entry.id !== "") models.push(entry.id);
    }
    return models.length > 0 ? models : null;
  } catch {
    return null;
  }
}

/** Read the whole cache file; a missing/corrupt file reads as an empty cache. */
function readCache(home: string): LiveModelsCache {
  try {
    const parsed = JSON.parse(readFileSync(join(home, LIVE_MODELS_CACHE_FILENAME), "utf-8"));
    if (!isObject(parsed)) return {};
    const cache: LiveModelsCache = {};
    for (const [provider, entry] of Object.entries(parsed)) {
      if (!isObject(entry)) continue;
      const models = Array.isArray(entry.models)
        ? entry.models.filter((m): m is string => typeof m === "string")
        : [];
      const fetchedAt = typeof entry.fetchedAt === "number" ? entry.fetchedAt : 0;
      cache[provider] = { fetchedAt, models };
    }
    return cache;
  } catch {
    return {};
  }
}

/**
 * Persist the cache atomically and privately: write a temp file in the same
 * directory, then rename over the target — a crash mid-write leaves an orphan
 * temp file, never a truncated provider-models.json. Best-effort: a failed
 * write must not damage the existing file or throw out of the caller.
 */
function writeCache(cache: LiveModelsCache, home: string): void {
  try {
    ensurePrivateDirectory(home);
    const finalPath = join(home, LIVE_MODELS_CACHE_FILENAME);
    const tmpPath = join(home, `.${LIVE_MODELS_CACHE_FILENAME}.tmp-${process.pid}-${Date.now()}`);
    writePrivateFileSync(tmpPath, `${JSON.stringify(cache, null, 2)}\n`);
    renameSync(tmpPath, finalPath);
  } catch {
    // A read-only HOME (or a racing writer) must not break the turn/doctor.
  }
}

/**
 * The cached model list for one provider, read synchronously with no network —
 * the stream path (aisdk.ts) uses this to append an "Available:" line without
 * awaiting anything. Returns null when there is no entry.
 */
export function readCachedModels(provider: string, homeDir?: string): string[] | null {
  const home = homeDir ?? resolveHome();
  const entry = readCache(home)[provider];
  return entry && entry.models.length > 0 ? entry.models : null;
}

/**
 * The live model list for one provider, cached for 24 h. Within the TTL the
 * cached entry is returned without a fetch; otherwise the provider is queried
 * and a success is written back. On failure the previous cached entry is
 * returned if there is one, else null — NEVER throws.
 */
export async function getLiveModels(options: GetLiveModelsOptions): Promise<string[] | null> {
  const { provider, baseUrl, apiKey, fetchImpl, timeoutMs, now = Date.now, homeDir } = options;
  const home = homeDir ?? resolveHome();
  const cache = readCache(home);
  const previous = cache[provider];

  if (previous && now() - previous.fetchedAt < LIVE_MODELS_TTL_MS) {
    return previous.models.length > 0 ? previous.models : null;
  }

  const fetched = await fetchProviderModels({ baseUrl, apiKey, fetchImpl, timeoutMs });
  if (fetched) {
    writeCache({ ...cache, [provider]: { fetchedAt: now(), models: fetched } }, home);
    return fetched;
  }
  return previous && previous.models.length > 0 ? previous.models : null;
}

/**
 * A model id with any `vendor/` prefix and case stripped, so two forms of the
 * same id compare equal (`deepseek/deepseek-v4-flash` vs `deepseek-v4-flash`).
 */
function bareModelId(id: string): string {
  return id.toLowerCase().split("/").pop() ?? id.toLowerCase();
}

/**
 * Whether a live list contains `model`, compared case-insensitively on the bare
 * (last-segment) id so a full id and a bare id match in EITHER direction.
 *
 *   null list          → "unknown"  (no evidence either way)
 *   a match            → "ok"
 *   no match           → "missing"
 *
 * "unknown" is reserved for "we could not ask"; a definite list that lacks the
 * model is what drives the user-visible warning.
 */
export function checkModelListed(
  models: string[] | null,
  model: string,
): "ok" | "missing" | "unknown" {
  if (models === null) return "unknown";
  const target = bareModelId(model);
  for (const candidate of models) {
    if (bareModelId(candidate) === target) return "ok";
  }
  return "missing";
}
