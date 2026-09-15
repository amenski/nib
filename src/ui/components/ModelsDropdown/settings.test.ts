import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadFavoriteModels,
  loadRecentModels,
  persistToggleFavorite,
  persistRecentModel,
} from "./settings.js";

describe("ModelsDropdown settings persistence (favorites/recent)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nib-models-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("loadFavoriteModels/loadRecentModels return empty arrays when settings.json doesn't exist", () => {
    expect(loadFavoriteModels(dir)).toEqual([]);
    expect(loadRecentModels(dir)).toEqual([]);
  });

  it("persistToggleFavorite writes a real file that round-trips through disk", () => {
    const result = persistToggleFavorite("deepseek/deepseek-v4-pro", dir);
    expect(result).toEqual(["deepseek/deepseek-v4-pro"]);

    const settingsPath = join(dir, "settings.json");
    expect(existsSync(settingsPath)).toBe(true);
    const onDisk = JSON.parse(readFileSync(settingsPath, "utf-8"));
    expect(onDisk.favoriteModels).toEqual(["deepseek/deepseek-v4-pro"]);

    // A fresh read (not the in-memory result) sees the same thing.
    expect(loadFavoriteModels(dir)).toEqual(["deepseek/deepseek-v4-pro"]);
  });

  it("persistToggleFavorite twice adds then removes — a real toggle, not just an append", () => {
    persistToggleFavorite("deepseek/deepseek-v4-pro", dir);
    const second = persistToggleFavorite("deepseek/deepseek-v4-pro", dir);
    expect(second).toEqual([]);
    expect(loadFavoriteModels(dir)).toEqual([]);
  });

  it("persistRecentModel writes and caps at 5, newest first", () => {
    for (let i = 0; i < 6; i++) {
      persistRecentModel(`provider/model-${i}`, i, dir);
    }
    const recent = loadRecentModels(dir);
    expect(recent).toHaveLength(5);
    expect(recent[0]).toEqual({ id: "provider/model-5", at: 5 });
    expect(recent.find((r) => r.id === "provider/model-0")).toBeUndefined();
  });

  it("favoriteModels and recentModels coexist with an unrelated settings.json without clobbering other keys", () => {
    const settingsPath = join(dir, "settings.json");
    writeFileSync(settingsPath, JSON.stringify({ model: "gpt-x", theme: { mode: "dark" } }, null, 2), "utf-8");

    persistToggleFavorite("groq/llama", dir);
    persistRecentModel("openai/gpt-5.6-sol", 42, dir);

    const onDisk = JSON.parse(readFileSync(settingsPath, "utf-8"));
    expect(onDisk.model).toBe("gpt-x");
    expect(onDisk.theme).toEqual({ mode: "dark" });
    expect(onDisk.favoriteModels).toEqual(["groq/llama"]);
    expect(onDisk.recentModels).toEqual([{ id: "openai/gpt-5.6-sol", at: 42 }]);
  });

  it("a corrupt settings.json does not throw — reads recover to empty, writes still succeed", () => {
    const settingsPath = join(dir, "settings.json");
    writeFileSync(settingsPath, "{ not valid json", "utf-8");

    expect(() => loadFavoriteModels(dir)).not.toThrow();
    expect(loadFavoriteModels(dir)).toEqual([]);

    expect(() => persistToggleFavorite("deepseek/deepseek-v4-pro", dir)).not.toThrow();
    const onDisk = JSON.parse(readFileSync(settingsPath, "utf-8"));
    expect(onDisk.favoriteModels).toEqual(["deepseek/deepseek-v4-pro"]);
  });

  it("tolerates non-string/malformed entries already on disk instead of crashing", () => {
    const settingsPath = join(dir, "settings.json");
    writeFileSync(
      settingsPath,
      JSON.stringify({ favoriteModels: ["ok/one", 42, null], recentModels: [{ id: "ok/two", at: 1 }, { id: 5 }] }),
      "utf-8",
    );
    expect(loadFavoriteModels(dir)).toEqual(["ok/one"]);
    expect(loadRecentModels(dir)).toEqual([{ id: "ok/two", at: 1 }]);
  });
});
