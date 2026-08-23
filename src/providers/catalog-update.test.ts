import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CATALOG_CACHE_FILENAME,
  DEFAULT_MODELS_DEV_URL,
  fetchModelsDevFeed,
  diffCatalogs,
  formatDiff,
  isDiffEmpty,
  readActiveSnapshot,
  writeCachedSnapshot,
  type GeneratedSnapshot,
} from "./catalog-update.js";

describe("fetchModelsDevFeed", () => {
  it("uses the default Models.dev URL and returns the parsed JSON body", async () => {
    let requestedUrl: string | undefined;
    const fetchImpl = (async (url: string) => {
      requestedUrl = url;
      return { ok: true, status: 200, statusText: "OK", json: async () => ({ providers: {} }) } as unknown as Response;
    }) as typeof fetch;
    const body = await fetchModelsDevFeed({ fetchImpl });
    expect(requestedUrl).toBe(DEFAULT_MODELS_DEV_URL);
    expect(body).toEqual({ providers: {} });
  });

  it("honors an explicit url override", async () => {
    let requestedUrl: string | undefined;
    const fetchImpl = (async (url: string) => {
      requestedUrl = url;
      return { ok: true, status: 200, statusText: "OK", json: async () => ({}) } as unknown as Response;
    }) as typeof fetch;
    await fetchModelsDevFeed({ url: "https://example.com/feed.json", fetchImpl });
    expect(requestedUrl).toBe("https://example.com/feed.json");
  });

  it("throws on a non-2xx response", async () => {
    const fetchImpl = (async () => ({ ok: false, status: 500, statusText: "Internal Server Error", json: async () => ({}) })) as unknown as typeof fetch;
    await expect(fetchModelsDevFeed({ fetchImpl })).rejects.toThrow(/500/);
  });

  it("throws when the underlying fetch rejects (network error / abort / timeout)", async () => {
    const fetchImpl = (async () => { throw new Error("The operation was aborted"); }) as unknown as typeof fetch;
    await expect(fetchModelsDevFeed({ fetchImpl })).rejects.toThrow(/aborted/);
  });

  it("throws when the response body is not valid JSON", async () => {
    const fetchImpl = (async () => ({ ok: true, status: 200, statusText: "OK", json: async () => { throw new SyntaxError("Unexpected token"); } })) as unknown as typeof fetch;
    await expect(fetchModelsDevFeed({ fetchImpl })).rejects.toThrow(/valid JSON/);
  });
});

describe("diffCatalogs / formatDiff / isDiffEmpty", () => {
  const snapshot = (providers: GeneratedSnapshot["providers"]): GeneratedSnapshot => ({ providers });

  it("reports no differences between identical snapshots as empty", () => {
    const a = snapshot({ openai: { models: { "gpt-x": { contextWindow: 128000, pricing: { inputPerM: 1, outputPerM: 2 } } } } });
    const b = snapshot({ openai: { models: { "gpt-x": { contextWindow: 128000, pricing: { inputPerM: 1, outputPerM: 2 } } } } });
    const diff = diffCatalogs(a, b);
    expect(isDiffEmpty(diff)).toBe(true);
    expect(formatDiff(diff)).toBe("catalog is already up to date");
  });

  it("reports added and removed models by provider/id", () => {
    const a = snapshot({ openai: { models: { "gpt-old": { contextWindow: 128000 } } } });
    const b = snapshot({ openai: { models: { "gpt-new": { contextWindow: 128000 } } } });
    const diff = diffCatalogs(a, b);
    expect(diff.added).toEqual(["openai/gpt-new"]);
    expect(diff.removed).toEqual(["openai/gpt-old"]);
    expect(isDiffEmpty(diff)).toBe(false);
    const text = formatDiff(diff);
    expect(text).toContain("+ openai/gpt-new");
    expect(text).toContain("- openai/gpt-old");
  });

  it("reports field-level changes limited to contextWindow and pricing.inputPerM/outputPerM", () => {
    const a = snapshot({ openai: { models: { "gpt-x": { contextWindow: 128000, pricing: { inputPerM: 1, outputPerM: 2 }, displayName: "old name" } } } });
    const b = snapshot({ openai: { models: { "gpt-x": { contextWindow: 256000, pricing: { inputPerM: 1, outputPerM: 3 }, displayName: "new name" } } } });
    const diff = diffCatalogs(a, b);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0].id).toBe("openai/gpt-x");
    expect(diff.changed[0].changes).toEqual([
      { field: "contextWindow", from: 128000, to: 256000 },
      { field: "pricing.outputPerM", from: 2, to: 3 },
    ]);
    // displayName changed too, but it's not one of the diffed fields.
    const text = formatDiff(diff);
    expect(text).toContain("contextWindow: 128000 -> 256000");
    expect(text).toContain("pricing.outputPerM: 2 -> 3");
    expect(text).not.toContain("displayName");
  });

  it("treats providers only present on one side as entirely added or removed", () => {
    const a = snapshot({ groq: { models: { llama: { contextWindow: 8000 } } } });
    const b = snapshot({ groq: { models: { llama: { contextWindow: 8000 } } }, openai: { models: { "gpt-x": { contextWindow: 128000 } } } });
    const diff = diffCatalogs(a, b);
    expect(diff.added).toEqual(["openai/gpt-x"]);
    expect(diff.removed).toEqual([]);
  });
});

describe("readActiveSnapshot / writeCachedSnapshot", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "heirloom-catalog-update-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("falls back to the bundled snapshot when there is no cached file", () => {
    const { origin, snapshot } = readActiveSnapshot(dir);
    expect(origin).toBe("bundled");
    expect(snapshot.source?.provider).toBe("models.dev");
    expect(snapshot.providers?.deepseek?.models?.["deepseek-v4-pro"]).toBeDefined();
  });

  it("prefers the cached snapshot once one has been written", () => {
    writeCachedSnapshot({ source: { provider: "models.dev", revision: "models.dev:2026-08-23", generatedAt: "2026-08-23" }, providers: { deepseek: { models: {} } } }, dir);
    const { origin, snapshot } = readActiveSnapshot(dir);
    expect(origin).toBe("cached");
    expect(snapshot.source?.revision).toBe("models.dev:2026-08-23");
  });

  it("writes the cache file atomically, leaving no temp file behind", () => {
    writeCachedSnapshot({ providers: { openai: { models: {} } } }, dir);
    const finalPath = join(dir, CATALOG_CACHE_FILENAME);
    expect(existsSync(finalPath)).toBe(true);
    const parsed = JSON.parse(readFileSync(finalPath, "utf-8"));
    expect(parsed).toEqual({ providers: { openai: { models: {} } } });
    const leftoverTempFiles = readdirSync(dir).filter((name) => name.includes(".tmp-"));
    expect(leftoverTempFiles).toEqual([]);
  });

  it("creates HEIRLOOM_HOME if it does not exist yet", () => {
    const missingHome = join(dir, "does-not-exist-yet");
    expect(existsSync(missingHome)).toBe(false);
    writeCachedSnapshot({ providers: {} }, missingHome);
    expect(existsSync(join(missingHome, CATALOG_CACHE_FILENAME))).toBe(true);
  });
});
