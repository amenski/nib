import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { updateSettings } from "../ThemeDropdown/index.js";
import { resolveHome } from "../../../config/loader.js";
import { addRecentModel, toggleFavoriteModel, type RecentModel } from "../../core/model-picker.js";

/**
 * Persistence for the /model picker's Favorites and Recent lists. Reuses the
 * same atomic read-modify-write (`updateSettings`) the theme picker uses, so
 * there's a single settings.json writer for the whole picker UI.
 */

interface ModelSettings {
  favoriteModels: string[];
  recentModels: RecentModel[];
}

function readModelSettings(homeDir?: string): ModelSettings {
  const dir = homeDir ?? resolveHome();
  const settingsPath = join(dir, "settings.json");
  if (!existsSync(settingsPath)) return { favoriteModels: [], recentModels: [] };
  try {
    const parsed = JSON.parse(readFileSync(settingsPath, "utf-8"));
    const favoriteModels = Array.isArray(parsed?.favoriteModels)
      ? parsed.favoriteModels.filter((f: unknown): f is string => typeof f === "string")
      : [];
    const recentModels = Array.isArray(parsed?.recentModels)
      ? parsed.recentModels.filter(
          (r: unknown): r is RecentModel =>
            !!r && typeof r === "object" && typeof (r as RecentModel).id === "string" && typeof (r as RecentModel).at === "number",
        )
      : [];
    return { favoriteModels, recentModels };
  } catch {
    // Corrupt file — tolerate, same as updateSettings does for writes.
    return { favoriteModels: [], recentModels: [] };
  }
}

export function loadFavoriteModels(homeDir?: string): string[] {
  return readModelSettings(homeDir).favoriteModels;
}

export function loadRecentModels(homeDir?: string): RecentModel[] {
  return readModelSettings(homeDir).recentModels;
}

/** Toggle `id`'s favorite status and persist. Returns the new favorites list. */
export function persistToggleFavorite(id: string, homeDir?: string): string[] {
  const next = toggleFavoriteModel(readModelSettings(homeDir).favoriteModels, id);
  updateSettings((config) => {
    config.favoriteModels = next;
  }, homeDir);
  return next;
}

/** Record a successful switch to `id` and persist. Returns the new recent list. */
export function persistRecentModel(id: string, at: number, homeDir?: string): RecentModel[] {
  const next = addRecentModel(readModelSettings(homeDir).recentModels, id, at);
  updateSettings((config) => {
    config.recentModels = next;
  }, homeDir);
  return next;
}
