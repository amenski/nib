import { describe, it, expect } from "vitest";
import {
  matchEntry,
  buildRows,
  selectableIndices,
  moveSelection,
  formatContext,
  toModelId,
  addRecentModel,
  toggleFavoriteModel,
  MAX_RECENT_MODELS,
  NO_QUERY_PROVIDER_CAP,
  type RecentModel,
} from "./model-picker.js";
import type { ModelEntry } from "../types.js";

const entries: ModelEntry[] = [
  { provider: "deepseek", model: "deepseek-v4-pro", contextWindow: 1000000 },
  { provider: "deepseek", model: "deepseek-v4-flash", contextWindow: 1000000 },
  { provider: "openai", model: "gpt-5.6-sol", contextWindow: 256000 },
  { provider: "groq", model: "llama-3.3-70b-versatile", contextWindow: 128000 },
];

describe("matchEntry", () => {
  it("matches against the provider half of provider/model", () => {
    const e = entries[2]; // openai/gpt-5.6-sol
    expect(matchEntry(e, "openai")).not.toBeNull();
  });

  it("matches against the model name", () => {
    expect(matchEntry(entries[3], "llama")).not.toBeNull();
  });

  it("rejects a query that matches neither", () => {
    expect(matchEntry(entries[3], "anthropic")).toBeNull();
  });

  it("matches against the display name", () => {
    const e: ModelEntry = { provider: "deepseek", model: "deepseek-v4-pro", displayName: "DeepSeek V4 Pro" };
    expect(matchEntry(e, "V4 Pro")).not.toBeNull();
  });

  it("still matches the raw model id when a display name is present", () => {
    const e: ModelEntry = { provider: "deepseek", model: "deepseek-v4-pro", displayName: "DeepSeek V4 Pro" };
    expect(matchEntry(e, "v4-pro")).not.toBeNull();
  });

  it("still matches by provider name when a display name is present", () => {
    const e: ModelEntry = { provider: "groq", model: "openai/gpt-oss-120b", displayName: "GPT-OSS 120B" };
    expect(matchEntry(e, "groq")).not.toBeNull();
  });

  it("matches a raw id fragment even though it doesn't appear in the display name", () => {
    const e: ModelEntry = { provider: "groq", model: "openai/gpt-oss-120b", displayName: "GPT-OSS 120B" };
    expect(matchEntry(e, "gpt-oss")).not.toBeNull();
  });
});

describe("buildRows", () => {
  it("groups models under one header per provider", () => {
    const rows = buildRows({ entries, query: "", currentProvider: "deepseek", currentModel: "deepseek-v4-pro" });
    const headers = rows.filter((r) => r.kind === "header");
    expect(headers.map((h) => h.provider)).toEqual(["deepseek", "openai", "groq"]);
  });

  it("drops a provider's header when none of its models match", () => {
    const rows = buildRows({ entries, query: "llama", currentProvider: "deepseek", currentModel: "deepseek-v4-pro" });
    expect(rows.filter((r) => r.kind === "header").map((h) => h.provider)).toEqual(["groq"]);
    expect(rows.filter((r) => r.kind === "model")).toHaveLength(1);
  });

  it("flags exactly the row matching BOTH provider and model as current", () => {
    const rows = buildRows({ entries, query: "", currentProvider: "openai", currentModel: "gpt-5.6-sol" });
    const current = rows.filter((r) => r.kind === "model" && r.current);
    expect(current).toHaveLength(1);
    expect(current[0]).toMatchObject({ provider: "openai", model: "gpt-5.6-sol" });
  });

  it("marks models whose provider has no key as unconfigured", () => {
    const rows = buildRows({
      entries, query: "", currentProvider: "deepseek", currentModel: "deepseek-v4-pro",
      configured: { deepseek: true, openai: false, groq: false },
    });
    const sol = rows.find((r) => r.kind === "model" && r.model === "gpt-5.6-sol");
    const pro = rows.find((r) => r.kind === "model" && r.model === "deepseek-v4-pro");
    expect(sol).toMatchObject({ configured: false });
    expect(pro).toMatchObject({ configured: true });
  });

  it("treats every provider as configured when no map is supplied", () => {
    const rows = buildRows({ entries, query: "", currentProvider: "deepseek", currentModel: "deepseek-v4-pro" });
    expect(rows.filter((r) => r.kind === "model" && !r.configured)).toHaveLength(0);
  });

  it("uses display labels for headers when provided", () => {
    const rows = buildRows({
      entries, query: "", currentProvider: "deepseek", currentModel: "deepseek-v4-pro",
      labels: { deepseek: "DeepSeek" },
    });
    expect(rows.find((r) => r.kind === "header" && r.provider === "deepseek")).toMatchObject({ label: "DeepSeek" });
    // Falls back to the raw name when unlabeled.
    expect(rows.find((r) => r.kind === "header" && r.provider === "groq")).toMatchObject({ label: "groq" });
  });

  it("returns no rows when nothing matches", () => {
    expect(buildRows({ entries, query: "zzzz", currentProvider: "deepseek" })).toEqual([]);
  });

  it("uses displayName as the row label, falling back to the raw id when absent", () => {
    const withNames: ModelEntry[] = [
      { provider: "deepseek", model: "deepseek-v4-pro", displayName: "DeepSeek V4 Pro" },
      { provider: "groq", model: "llama-3.3-70b-versatile" },
    ];
    const rows = buildRows({ entries: withNames, query: "", currentProvider: "deepseek" });
    const pro = rows.find((r) => r.kind === "model" && r.model === "deepseek-v4-pro");
    expect(pro).toMatchObject({ label: "DeepSeek V4 Pro", displayName: "DeepSeek V4 Pro" });
    const llama = rows.find((r) => r.kind === "model" && r.model === "llama-3.3-70b-versatile");
    expect(llama).toMatchObject({ label: "llama-3.3-70b-versatile" });
  });

  it("searching by display name surfaces the entry and can be found via buildRows", () => {
    const withNames: ModelEntry[] = [
      { provider: "deepseek", model: "deepseek-v4-pro", displayName: "DeepSeek V4 Pro" },
      { provider: "openai", model: "gpt-5.6-sol", displayName: "GPT-5.6 Sol" },
    ];
    const rows = buildRows({ entries: withNames, query: "GPT-5.6", currentProvider: "deepseek" });
    expect(rows.filter((r) => r.kind === "model")).toHaveLength(1);
    expect(rows.find((r) => r.kind === "model")).toMatchObject({ model: "gpt-5.6-sol" });
  });

  it("searching by the raw model id still works when a display name is set", () => {
    const withNames: ModelEntry[] = [
      { provider: "deepseek", model: "deepseek-v4-pro", displayName: "DeepSeek V4 Pro" },
      { provider: "openai", model: "gpt-5.6-sol", displayName: "GPT-5.6 Sol" },
    ];
    const rows = buildRows({ entries: withNames, query: "v4-pro", currentProvider: "deepseek" });
    expect(rows.filter((r) => r.kind === "model")).toHaveLength(1);
    expect(rows.find((r) => r.kind === "model")).toMatchObject({ model: "deepseek-v4-pro" });
  });

  it("carries the free flag onto the model row", () => {
    const withFree: ModelEntry[] = [
      { provider: "deepseek", model: "deepseek-v4-flash", free: true },
      { provider: "deepseek", model: "deepseek-v4-pro" },
    ];
    const rows = buildRows({ entries: withFree, query: "", currentProvider: "deepseek" });
    expect(rows.find((r) => r.kind === "model" && r.model === "deepseek-v4-flash")).toMatchObject({ free: true });
    expect(rows.find((r) => r.kind === "model" && r.model === "deepseek-v4-pro")).toMatchObject({ free: undefined });
  });
});

describe("navigation skips headers", () => {
  const rows = buildRows({ entries, query: "", currentProvider: "deepseek", currentModel: "deepseek-v4-pro" });

  it("only model rows are selectable", () => {
    const idx = selectableIndices(rows);
    expect(idx).toHaveLength(4);
    for (const i of idx) expect(rows[i].kind).toBe("model");
  });

  it("moving down never lands on a header", () => {
    let cur = selectableIndices(rows)[0];
    for (let n = 0; n < 8; n++) {
      cur = moveSelection(rows, cur, 1);
      expect(rows[cur].kind).toBe("model");
    }
  });

  it("wraps around at both ends", () => {
    const idx = selectableIndices(rows);
    expect(moveSelection(rows, idx[idx.length - 1], 1)).toBe(idx[0]);
    expect(moveSelection(rows, idx[0], -1)).toBe(idx[idx.length - 1]);
  });

  it("returns -1 when there is nothing to select", () => {
    expect(moveSelection([], 0, 1)).toBe(-1);
  });
});

describe("formatContext", () => {
  it("renders a context window in thousands", () => {
    expect(formatContext(1000000)).toBe("1000k ctx");
    expect(formatContext(128000)).toBe("128k ctx");
  });

  it("renders nothing when unknown", () => {
    expect(formatContext(undefined)).toBe("");
  });
});

describe("toModelId", () => {
  it("joins provider and model with a slash", () => {
    expect(toModelId("deepseek", "deepseek-v4-pro")).toBe("deepseek/deepseek-v4-pro");
  });
});

describe("toggleFavoriteModel", () => {
  it("adds an id that isn't favorited yet", () => {
    expect(toggleFavoriteModel([], "deepseek/deepseek-v4-pro")).toEqual(["deepseek/deepseek-v4-pro"]);
  });

  it("removes an id that is already favorited", () => {
    expect(toggleFavoriteModel(["a", "b"], "a")).toEqual(["b"]);
  });

  it("preserves existing order when adding", () => {
    expect(toggleFavoriteModel(["a", "b"], "c")).toEqual(["a", "b", "c"]);
  });
});

describe("addRecentModel", () => {
  it("inserts a new id at the front", () => {
    const result = addRecentModel([], "deepseek/deepseek-v4-pro", 100);
    expect(result).toEqual([{ id: "deepseek/deepseek-v4-pro", at: 100 }]);
  });

  it("moves an existing id to the front instead of duplicating it", () => {
    const start: RecentModel[] = [
      { id: "a", at: 1 },
      { id: "b", at: 2 },
    ];
    const result = addRecentModel(start, "a", 3);
    expect(result).toEqual([{ id: "a", at: 3 }, { id: "b", at: 2 }]);
  });

  it("caps the list at MAX_RECENT_MODELS, dropping the oldest", () => {
    // m0 is newest (index 0, front of the list), m(N-1) is oldest (back).
    const start: RecentModel[] = Array.from({ length: MAX_RECENT_MODELS }, (_, i) => ({ id: `m${i}`, at: i }));
    const result = addRecentModel(start, "new", MAX_RECENT_MODELS);
    expect(result).toHaveLength(MAX_RECENT_MODELS);
    expect(result[0]).toEqual({ id: "new", at: MAX_RECENT_MODELS });
    // The last (oldest, pushed past the cap by the new front insert) falls off.
    expect(result.find((r) => r.id === `m${MAX_RECENT_MODELS - 1}`)).toBeUndefined();
  });
});

describe("buildRows — Favorites and Recent groups", () => {
  it("pins a Favorites group first when favoriteModels is set", () => {
    const rows = buildRows({
      entries, query: "", currentProvider: "deepseek", currentModel: "deepseek-v4-pro",
      favoriteModels: ["deepseek/deepseek-v4-flash"],
    });
    expect(rows[0]).toMatchObject({ kind: "header", label: "Favorites" });
    expect(rows[1]).toMatchObject({ kind: "model", group: "favorites", model: "deepseek-v4-flash", favorite: true });
  });

  it("keeps a favorited model in its own provider group too", () => {
    const rows = buildRows({
      entries, query: "", currentProvider: "deepseek", currentModel: "deepseek-v4-pro",
      favoriteModels: ["deepseek/deepseek-v4-flash"],
    });
    const providerGroupRow = rows.find((r) => r.kind === "model" && r.group === "deepseek" && r.model === "deepseek-v4-flash");
    expect(providerGroupRow).toMatchObject({ favorite: true });
    // Present in both groups: once under favorites, once under deepseek.
    const allFlash = rows.filter((r) => r.kind === "model" && r.model === "deepseek-v4-flash");
    expect(allFlash).toHaveLength(2);
  });

  it("marks favorite:false on rows that are not favorited", () => {
    const rows = buildRows({
      entries, query: "", currentProvider: "deepseek", currentModel: "deepseek-v4-pro",
      favoriteModels: ["deepseek/deepseek-v4-flash"],
    });
    const pro = rows.find((r) => r.kind === "model" && r.model === "deepseek-v4-pro");
    expect(pro).toMatchObject({ favorite: false });
  });

  it("omits the Favorites header entirely when there are none", () => {
    const rows = buildRows({ entries, query: "", currentProvider: "deepseek" });
    expect(rows.find((r) => r.kind === "header" && r.label === "Favorites")).toBeUndefined();
  });

  it("renders a Recent group after Favorites, in newest-first order", () => {
    const recentModels: RecentModel[] = [
      { id: "openai/gpt-5.6-sol", at: 200 },
      { id: "groq/llama-3.3-70b-versatile", at: 100 },
    ];
    const rows = buildRows({
      entries, query: "", currentProvider: "deepseek", currentModel: "deepseek-v4-pro",
      favoriteModels: ["deepseek/deepseek-v4-flash"],
      recentModels,
    });
    const favIdx = rows.findIndex((r) => r.kind === "header" && r.label === "Favorites");
    const recentIdx = rows.findIndex((r) => r.kind === "header" && r.label === "Recent");
    expect(favIdx).toBeGreaterThanOrEqual(0);
    expect(recentIdx).toBeGreaterThan(favIdx);
    // Newest (gpt-5.6-sol, at:200) comes before llama (at:100).
    const recentRows = rows.filter((r) => r.kind === "model" && r.group === "recent");
    expect(recentRows.map((r: any) => r.model)).toEqual(["gpt-5.6-sol", "llama-3.3-70b-versatile"]);
  });

  it("excludes a favorited model from Recent so the two groups stay disjoint", () => {
    const recentModels: RecentModel[] = [{ id: "deepseek/deepseek-v4-flash", at: 100 }];
    const rows = buildRows({
      entries, query: "", currentProvider: "deepseek", currentModel: "deepseek-v4-pro",
      favoriteModels: ["deepseek/deepseek-v4-flash"],
      recentModels,
    });
    expect(rows.find((r) => r.kind === "header" && r.label === "Recent")).toBeUndefined();
    expect(rows.filter((r) => r.kind === "model" && r.group === "recent")).toHaveLength(0);
  });

  it("omits the Recent header entirely when there are none", () => {
    const rows = buildRows({ entries, query: "", currentProvider: "deepseek" });
    expect(rows.find((r) => r.kind === "header" && r.label === "Recent")).toBeUndefined();
  });

  it("drops a favorite/recent id that no longer matches a known entry", () => {
    const rows = buildRows({
      entries, query: "", currentProvider: "deepseek",
      favoriteModels: ["ghost/does-not-exist"],
      recentModels: [{ id: "ghost/also-missing", at: 1 }],
    });
    expect(rows.find((r) => r.kind === "header" && r.label === "Favorites")).toBeUndefined();
    expect(rows.find((r) => r.kind === "header" && r.label === "Recent")).toBeUndefined();
  });

  it("Favorites and Recent rows stay navigable alongside provider rows", () => {
    const rows = buildRows({
      entries, query: "", currentProvider: "deepseek", currentModel: "deepseek-v4-pro",
      favoriteModels: ["deepseek/deepseek-v4-flash"],
      recentModels: [{ id: "groq/llama-3.3-70b-versatile", at: 1 }],
    });
    const idx = selectableIndices(rows);
    // 2 favorites-group rows aren't added (only 1 favorite) — count models: favorites(1) + recent(1) + provider groups(4) = 6
    expect(idx).toHaveLength(6);
    for (const i of idx) expect(rows[i].kind).toBe("model");
  });

  it("Favorites/Recent groups also filter with the search query", () => {
    const rows = buildRows({
      entries, query: "llama", currentProvider: "deepseek",
      favoriteModels: ["deepseek/deepseek-v4-flash"],
      recentModels: [{ id: "groq/llama-3.3-70b-versatile", at: 1 }],
    });
    // The favorite doesn't match "llama", so its group is dropped entirely.
    expect(rows.find((r) => r.kind === "header" && r.label === "Favorites")).toBeUndefined();
    // The recent entry matches, so Recent survives with just that one row.
    expect(rows.find((r) => r.kind === "header" && r.label === "Recent")).toBeDefined();
    expect(rows.filter((r) => r.kind === "model" && r.group === "recent")).toHaveLength(1);
  });
});

// A catalog update can take one provider from a handful of models to
// hundreds (e.g. OpenRouter). The no-query default view must stay a
// browsable list, not dump the whole provider — see NO_QUERY_PROVIDER_CAP.
describe("buildRows — no-query provider cap", () => {
  const manyEntries: ModelEntry[] = Array.from({ length: 20 }, (_, i) => ({
    provider: "openrouter",
    model: `model-${String(i).padStart(2, "0")}`,
    contextWindow: 100000,
  }));

  it("caps a large provider group to NO_QUERY_PROVIDER_CAP models and appends a hint row", () => {
    const rows = buildRows({ entries: manyEntries, query: "", currentProvider: "openrouter" });
    expect(rows.filter((r) => r.kind === "model")).toHaveLength(NO_QUERY_PROVIDER_CAP);
    const hint = rows.find((r) => r.kind === "hint");
    expect(hint).toBeDefined();
    expect((hint as { label: string }).label).toContain("12 more");
    expect((hint as { label: string }).label).toContain("type to filter");
  });

  it("lifts the cap entirely once there is a query, even for a large provider group", () => {
    const rows = buildRows({ entries: manyEntries, query: "model", currentProvider: "openrouter" });
    expect(rows.filter((r) => r.kind === "model")).toHaveLength(20);
    expect(rows.find((r) => r.kind === "hint")).toBeUndefined();
  });

  it("does not add a hint row for a provider group at or under the cap", () => {
    const rows = buildRows({ entries, query: "", currentProvider: "deepseek" }); // 4 total entries, well under the cap
    expect(rows.find((r) => r.kind === "hint")).toBeUndefined();
  });

  it("the hint row is not selectable — navigation steps over it like a header", () => {
    const rows = buildRows({ entries: manyEntries, query: "", currentProvider: "openrouter" });
    const idx = selectableIndices(rows);
    expect(idx).toHaveLength(NO_QUERY_PROVIDER_CAP);
    for (const i of idx) expect(rows[i].kind).toBe("model");
    let cur = idx[0];
    for (let n = 0; n < idx.length + 2; n++) {
      cur = moveSelection(rows, cur, 1);
      expect(rows[cur].kind).toBe("model");
    }
  });

  it("never caps the pinned Favorites group", () => {
    const manyFavorites = manyEntries.map((e) => toModelId(e.provider, e.model));
    const rows = buildRows({ entries: manyEntries, query: "", currentProvider: "openrouter", favoriteModels: manyFavorites });
    expect(rows.filter((r) => r.kind === "model" && r.group === "favorites")).toHaveLength(20);
  });

  it("never caps the pinned Recent group", () => {
    const manyRecents = manyEntries.map((e, i) => ({ id: toModelId(e.provider, e.model), at: i }));
    const rows = buildRows({ entries: manyEntries, query: "", currentProvider: "openrouter", recentModels: manyRecents });
    expect(rows.filter((r) => r.kind === "model" && r.group === "recent")).toHaveLength(20);
  });
});
