import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { resolveHome } from "../config/loader.js";

/**
 * Cached, updated catalog snapshot written by `nib models update`. Lives
 * in NIB_HOME, distinct from the bundled src/providers/models.json
 * (ships with the binary, never overwritten — plan §4.C "preserve the bundled
 * snapshot as fallback") and from the user's hand-owned
 * ~/.nib/models.json override, which still wins over both (plan §2
 * decision 5).
 */
export const CATALOG_CACHE_FILENAME = "models-catalog.json";

export const DEFAULT_MODELS_DEV_URL = "https://models.dev/api.json";

// Same directory as catalog.ts, so this resolves to the identical file both
// in src/ and in a built dist/ — see catalog.ts's BUNDLED_PATH for the same
// import.meta.url pattern.
const BUNDLED_SNAPSHOT_PATH = new URL("./models.json", import.meta.url);

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function readJsonFile(path: string | URL): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export interface SnapshotSource {
  provider?: string;
  revision?: string;
  generatedAt?: string;
}

/**
 * The generated-catalog shape written by catalog-generator.ts: a `source`
 * block plus `providers[name].models[id]`. Deliberately loose (`unknown`
 * model bodies) — diffCatalogs only reaches into the couple of fields the
 * plan names (contextWindow, pricing.inputPerM/outputPerM).
 */
export interface GeneratedSnapshot {
  source?: SnapshotSource;
  providers?: Record<string, { models?: Record<string, unknown> }>;
}

export interface ActiveSnapshot {
  origin: "bundled" | "cached";
  snapshot: GeneratedSnapshot;
}

/**
 * The catalog `models update` diffs against, and what a declined/failed
 * update leaves untouched: the cached snapshot if `models update` has ever
 * succeeded, otherwise the bundled one. Reads the raw generated-shape JSON
 * directly (not through loadModelCatalog) because this needs the `source`
 * block that loadModelCatalog discards after merging providers together.
 */
export function readActiveSnapshot(homeDir?: string): ActiveSnapshot {
  const home = homeDir ?? resolveHome();
  const cached = readJsonFile(join(home, CATALOG_CACHE_FILENAME));
  if (cached) return { origin: "cached", snapshot: cached as GeneratedSnapshot };
  const bundled = readJsonFile(BUNDLED_SNAPSHOT_PATH);
  return { origin: "bundled", snapshot: (bundled as GeneratedSnapshot) ?? { providers: {} } };
}

/**
 * Atomically persist a freshly generated and confirmed catalog to
 * NIB_HOME/models-catalog.json: write a temp file in the same
 * directory, then rename over the target. A crash mid-write leaves the temp
 * file orphaned rather than a truncated models-catalog.json that would
 * poison the next startup's loadModelCatalog.
 */
export function writeCachedSnapshot(snapshot: unknown, homeDir?: string): void {
  const home = homeDir ?? resolveHome();
  mkdirSync(home, { recursive: true });
  const finalPath = join(home, CATALOG_CACHE_FILENAME);
  const tmpPath = join(home, `.${CATALOG_CACHE_FILENAME}.tmp-${process.pid}-${Date.now()}`);
  writeFileSync(tmpPath, `${JSON.stringify(snapshot, null, 2)}\n`);
  renameSync(tmpPath, finalPath);
}

export interface FetchFeedOptions {
  url?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Download the Models.dev feed with a hard timeout. `fetchImpl` is
 * injectable so tests never touch the network (plan §6 criterion 5), like
 * cli.tsx's probeSearXngHealth. Non-2xx, abort/timeout, and non-JSON bodies are all
 * surfaced as one error type so the caller can print-and-exit-1 uniformly
 * without inspecting the cause.
 */
export async function fetchModelsDevFeed(options: FetchFeedOptions = {}): Promise<unknown> {
  const { url = DEFAULT_MODELS_DEV_URL, fetchImpl = fetch, timeoutMs = 10_000 } = options;
  let response;
  try {
    response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw new Error(`failed to fetch ${url}: ${(err as Error).message}`);
  }
  if (!response.ok) throw new Error(`failed to fetch ${url}: ${response.status} ${response.statusText}`);
  try {
    return await response.json();
  } catch (err) {
    throw new Error(`${url} did not return valid JSON: ${(err as Error).message}`);
  }
}

export interface CatalogDiffChange {
  field: "contextWindow" | "pricing.inputPerM" | "pricing.outputPerM";
  from: number | undefined;
  to: number | undefined;
}

export interface CatalogDiffEntry {
  id: string;
  changes: CatalogDiffChange[];
}

export interface CatalogDiff {
  added: string[];
  removed: string[];
  changed: CatalogDiffEntry[];
}

interface DiffableModel {
  contextWindow?: number;
  pricing?: { inputPerM?: number; outputPerM?: number };
}

/**
 * Field-level diff limited to the fields plan §4.C names (contextWindow,
 * pricing.inputPerM/outputPerM) — not a full deep-equal, so unrelated
 * normalization noise (e.g. an effort list) never shows up as a spurious
 * "changed" entry.
 */
export function diffCatalogs(active: GeneratedSnapshot, updated: GeneratedSnapshot): CatalogDiff {
  const added: string[] = [];
  const removed: string[] = [];
  const changed: CatalogDiffEntry[] = [];
  const activeProviders = active.providers ?? {};
  const updatedProviders = updated.providers ?? {};
  const providerNames = [...new Set([...Object.keys(activeProviders), ...Object.keys(updatedProviders)])].sort();

  for (const provider of providerNames) {
    const activeModels = activeProviders[provider]?.models ?? {};
    const updatedModels = updatedProviders[provider]?.models ?? {};
    const modelIds = [...new Set([...Object.keys(activeModels), ...Object.keys(updatedModels)])].sort();

    for (const modelId of modelIds) {
      const id = `${provider}/${modelId}`;
      const before = activeModels[modelId] as DiffableModel | undefined;
      const after = updatedModels[modelId] as DiffableModel | undefined;
      if (before === undefined) { added.push(id); continue; }
      if (after === undefined) { removed.push(id); continue; }

      const changes: CatalogDiffChange[] = [];
      if (before.contextWindow !== after.contextWindow) {
        changes.push({ field: "contextWindow", from: before.contextWindow, to: after.contextWindow });
      }
      if (before.pricing?.inputPerM !== after.pricing?.inputPerM) {
        changes.push({ field: "pricing.inputPerM", from: before.pricing?.inputPerM, to: after.pricing?.inputPerM });
      }
      if (before.pricing?.outputPerM !== after.pricing?.outputPerM) {
        changes.push({ field: "pricing.outputPerM", from: before.pricing?.outputPerM, to: after.pricing?.outputPerM });
      }
      if (changes.length) changed.push({ id, changes });
    }
  }

  return { added, removed, changed };
}

export function isDiffEmpty(diff: CatalogDiff): boolean {
  return diff.added.length === 0 && diff.removed.length === 0 && diff.changed.length === 0;
}

/**
 * Render a diff for the confirmation prompt. An empty diff gets the plan's
 * exact "catalog is already up to date" wording (§4.C).
 */
export function formatDiff(diff: CatalogDiff): string {
  if (isDiffEmpty(diff)) return "catalog is already up to date";
  const lines: string[] = [];
  if (diff.added.length) {
    lines.push("Added:");
    for (const id of diff.added) lines.push(`  + ${id}`);
  }
  if (diff.removed.length) {
    lines.push("Removed:");
    for (const id of diff.removed) lines.push(`  - ${id}`);
  }
  if (diff.changed.length) {
    lines.push("Changed:");
    for (const entry of diff.changed) {
      for (const change of entry.changes) lines.push(`  ~ ${entry.id} ${change.field}: ${change.from ?? "(none)"} -> ${change.to ?? "(none)"}`);
    }
  }
  return lines.join("\n");
}
