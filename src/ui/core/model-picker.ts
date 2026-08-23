import type { ModelEntry } from "../types.js";
import { fuzzyScore } from "./fuzzy.js";

/**
 * Pure logic for the /model picker: fuzzy matching, provider grouping, and the
 * flat navigable row list the view renders.
 *
 * Kept out of the component so the matching and grouping rules are unit
 * testable without rendering Ink (the view itself only maps rows to <Text>).
 */

/** A rendered row: a group heading, a non-selectable hint, or a selectable model. */
export type PickerRow =
  | { kind: "header"; provider: string; label: string }
  | { kind: "hint"; provider: string; label: string }
  | {
      kind: "model";
      /** Which group this row renders in: a real provider name, or "favorites"/"recent". */
      group: string;
      provider: string;
      model: string;
      label: string;
      displayName?: string;
      providerLabel?: string;
      free?: boolean;
      contextWindow?: number;
      current: boolean;
      configured: boolean;
      favorite: boolean;
    };

export { fuzzyScore };

/** A model's identity as persisted in settings.json: "provider/model". */
export function toModelId(provider: string, model: string): string {
  return `${provider}/${model}`;
}

/** A recently-used model, newest at index 0. */
export interface RecentModel {
  id: string;
  at: number;
}

/** Number of Recent entries kept in settings and shown in the picker. */
export const MAX_RECENT_MODELS = 5;

/**
 * Cap on models shown per provider group in the no-query default view.
 * A catalog update can take a provider from a handful of models to hundreds
 * (e.g. OpenRouter after `heirloom models update`); with no query to filter
 * by, the unqueried view must stay a browsable list rather than dumping the
 * whole provider. Typing any query lifts the cap entirely — see buildRows.
 */
export const NO_QUERY_PROVIDER_CAP = 8;

/**
 * Fold a successful model switch into the recent list: move-or-insert `id` at
 * the front, cap at MAX_RECENT_MODELS, drop older duplicates. Pure — the
 * caller persists the result.
 */
export function addRecentModel(recents: RecentModel[], id: string, at: number): RecentModel[] {
  const rest = recents.filter((r) => r.id !== id);
  return [{ id, at }, ...rest].slice(0, MAX_RECENT_MODELS);
}

/** Toggle `id` in a favorites list — pure, order-preserving, no duplicates. */
export function toggleFavoriteModel(favorites: string[], id: string): string[] {
  return favorites.includes(id)
    ? favorites.filter((f) => f !== id)
    : [...favorites, id];
}

/**
 * Match against "provider/model", the raw model id alone, the display name
 * alone, and the provider name alone — a query can hit any of them. A
 * display-name-less entry just repeats the raw id, so this still works when
 * displayName is absent.
 */
export function matchEntry(entry: ModelEntry, query: string): number | null {
  if (!query) return 0;
  const candidates = [
    fuzzyScore(`${entry.provider}/${entry.model}`, query),
    fuzzyScore(entry.model, query),
    entry.displayName ? fuzzyScore(entry.displayName, query) : null,
    fuzzyScore(entry.provider, query),
  ];
  const best = candidates.reduce<number | null>((min, score) => {
    if (score === null) return min;
    return min === null ? score : Math.min(min, score);
  }, null);
  if (best === null) return null;
  // A hit on the model name or display name is more relevant than one that
  // only lines up by borrowing characters from the provider prefix; the -1
  // nudge keeps ties (e.g. an exact provider/model match) from losing to it.
  const modelOnly = Math.min(
    candidates[1] ?? Infinity,
    candidates[2] ?? Infinity,
  );
  return modelOnly !== Infinity ? Math.min(best, modelOnly - 1) : best;
}

export interface BuildRowsOptions {
  entries: ModelEntry[];
  query: string;
  currentProvider: string;
  currentModel?: string;
  /** Provider name -> whether an API key is resolvable for it. */
  configured?: Record<string, boolean>;
  /** Display names for providers (deepseek -> DeepSeek). */
  labels?: Record<string, string>;
  /** "provider/model" ids currently favorited — rendered in a pinned Favorites group. */
  favoriteModels?: string[];
  /** Recently-switched-to models, newest first — rendered in a pinned Recent group. */
  recentModels?: RecentModel[];
}

function toRow(
  entry: ModelEntry,
  group: string,
  currentProvider: string,
  currentModel: string | undefined,
  configured: Record<string, boolean> | undefined,
  favoriteIds: Set<string>,
): PickerRow {
  const provider = entry.provider;
  return {
    kind: "model",
    group,
    provider,
    model: entry.model,
    label: entry.displayName ?? entry.model,
    displayName: entry.displayName,
    providerLabel: entry.providerLabel,
    free: entry.free,
    contextWindow: entry.contextWindow,
    current: provider === currentProvider && entry.model === currentModel,
    // Absent map = don't claim anything is unconfigured.
    configured: configured ? configured[provider] !== false : true,
    favorite: favoriteIds.has(toModelId(provider, entry.model)),
  };
}

/**
 * Filter by `query`, group surviving entries under provider headings, and
 * flatten to rows. Providers keep first-seen order from `entries`; within a
 * provider, models are ordered by match quality then name.
 *
 * A pinned Favorites group renders first (favorited models also stay in their
 * own provider group below — matching the mockup, so a model is reachable
 * both by "the models I starred" and by "the provider I'm browsing"), then a
 * pinned Recent group (models excluded once they're favorited, to keep Recent
 * from duplicating Favorites), then the regular provider groups.
 */
export function buildRows({
  entries,
  query,
  currentProvider,
  currentModel,
  configured,
  labels,
  favoriteModels,
  recentModels,
}: BuildRowsOptions): PickerRow[] {
  const scored: Array<{ entry: ModelEntry; score: number }> = [];
  for (const entry of entries) {
    const score = matchEntry(entry, query);
    if (score !== null) scored.push({ entry, score });
  }

  const favoriteIds = new Set(favoriteModels ?? []);
  const byId = new Map<string, ModelEntry>();
  for (const { entry } of scored) byId.set(toModelId(entry.provider, entry.model), entry);

  const rows: PickerRow[] = [];

  // ── Favorites (pinned first) ──
  const favoriteEntries = (favoriteModels ?? [])
    .map((id) => byId.get(id))
    .filter((e): e is ModelEntry => e !== undefined);
  if (favoriteEntries.length > 0) {
    rows.push({ kind: "header", provider: "favorites", label: "Favorites" });
    for (const entry of favoriteEntries) {
      rows.push(toRow(entry, "favorites", currentProvider, currentModel, configured, favoriteIds));
    }
  }

  // ── Recent (pinned second, favorited models excluded) ──
  const recentEntries = (recentModels ?? [])
    .filter((r) => !favoriteIds.has(r.id))
    .map((r) => byId.get(r.id))
    .filter((e): e is ModelEntry => e !== undefined);
  if (recentEntries.length > 0) {
    rows.push({ kind: "header", provider: "recent", label: "Recent" });
    for (const entry of recentEntries) {
      rows.push(toRow(entry, "recent", currentProvider, currentModel, configured, favoriteIds));
    }
  }

  // ── Provider groups ──
  const order: string[] = [];
  const byProvider = new Map<string, Array<{ entry: ModelEntry; score: number }>>();
  for (const item of scored) {
    const p = item.entry.provider;
    if (!byProvider.has(p)) {
      byProvider.set(p, []);
      order.push(p);
    }
    byProvider.get(p)!.push(item);
  }

  for (const provider of order) {
    const items = byProvider.get(provider)!;
    items.sort((a, b) => a.score - b.score || a.entry.model.localeCompare(b.entry.model));
    rows.push({
      kind: "header",
      provider,
      label: labels?.[provider] ?? provider,
    });
    // Cap only applies to the unqueried view — a query is already the filter,
    // and truncating filtered results would hide the very thing being
    // searched for.
    const capped = !query && items.length > NO_QUERY_PROVIDER_CAP;
    const visibleItems = capped ? items.slice(0, NO_QUERY_PROVIDER_CAP) : items;
    for (const { entry } of visibleItems) {
      rows.push(toRow(entry, provider, currentProvider, currentModel, configured, favoriteIds));
    }
    if (capped) {
      const remaining = items.length - NO_QUERY_PROVIDER_CAP;
      rows.push({ kind: "hint", provider, label: `… ${remaining} more — type to filter` });
    }
  }
  return rows;
}

/** Indices of selectable rows — headers are display-only and skipped by nav. */
export function selectableIndices(rows: PickerRow[]): number[] {
  const out: number[] = [];
  rows.forEach((r, i) => {
    if (r.kind === "model") out.push(i);
  });
  return out;
}

/**
 * Move the cursor by `delta` selectable rows, wrapping at both ends and
 * stepping over headers. Returns the new row index (or -1 when nothing is
 * selectable).
 */
export function moveSelection(rows: PickerRow[], current: number, delta: number): number {
  const idx = selectableIndices(rows);
  if (idx.length === 0) return -1;
  const pos = idx.indexOf(current);
  if (pos === -1) return idx[0];
  const next = (pos + delta + idx.length) % idx.length;
  return idx[next];
}

/** Format a context window for display: 1000000 -> "1000k ctx". */
export function formatContext(contextWindow?: number): string {
  if (!contextWindow) return "";
  return `${Math.round(contextWindow / 1000)}k ctx`;
}
