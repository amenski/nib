import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LIVE_MODELS_CACHE_FILENAME,
  LIVE_MODELS_TTL_MS,
  checkModelListed,
  fetchProviderModels,
  getLiveModels,
  readCachedModels,
} from "./live-models.js";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "nib-live-models-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

/** A fetch stub that records calls and returns a canned OpenAI /models body. */
function okFetch(ids: string[], record?: { urls: string[]; headers: Array<Record<string, string>> }) {
  return (async (url: string, init?: RequestInit) => {
    record?.urls.push(url);
    record?.headers.push((init?.headers ?? {}) as Record<string, string>);
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: ids.map((id) => ({ id })) }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

describe("fetchProviderModels", () => {
  it("GETs {baseUrl}/models with a Bearer header and parses the data[].id shape", async () => {
    const record = { urls: [] as string[], headers: [] as Array<Record<string, string>> };
    const models = await fetchProviderModels({
      baseUrl: "https://api.deepseek.com/",
      apiKey: "sk-test",
      fetchImpl: okFetch(["deepseek-flash", "deepseek-v4-pro"], record),
    });
    expect(models).toEqual(["deepseek-flash", "deepseek-v4-pro"]);
    expect(record.urls).toEqual(["https://api.deepseek.com/models"]);
    expect(record.headers[0].Authorization).toBe("Bearer sk-test");
  });

  it("returns null without fetching when the API key is missing", async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return { ok: true, status: 200, json: async () => ({ data: [] }) } as unknown as Response;
    }) as unknown as typeof fetch;
    expect(await fetchProviderModels({ baseUrl: "https://api.deepseek.com", apiKey: "", fetchImpl })).toBeNull();
    expect(called).toBe(false);
  });

  it("returns null on a non-2xx response, bad JSON, or an empty/invalid list", async () => {
    expect(await fetchProviderModels({
      baseUrl: "u",
      apiKey: "k",
      fetchImpl: (async () => ({ ok: false, status: 500, json: async () => ({}) })) as unknown as typeof fetch,
    })).toBeNull();
    expect(await fetchProviderModels({
      baseUrl: "u",
      apiKey: "k",
      fetchImpl: (async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError("nope"); } })) as unknown as typeof fetch,
    })).toBeNull();
    expect(await fetchProviderModels({ baseUrl: "u", apiKey: "k", fetchImpl: okFetch([]) })).toBeNull();
    expect(await fetchProviderModels({
      baseUrl: "u",
      apiKey: "k",
      fetchImpl: (async () => ({ ok: true, status: 200, json: async () => ({ data: [{ nope: 1 }] }) })) as unknown as typeof fetch,
    })).toBeNull();
  });
});

describe("getLiveModels", () => {
  it("honours the TTL: a second call inside 24 h performs no second fetch", async () => {
    let fetches = 0;
    const fetchImpl = (async () => {
      fetches++;
      return { ok: true, status: 200, json: async () => ({ data: [{ id: "deepseek-flash" }] }) } as unknown as Response;
    }) as unknown as typeof fetch;

    const t0 = 1_000_000_000_000;
    const first = await getLiveModels({ provider: "deepseek", baseUrl: "u", apiKey: "k", fetchImpl, now: () => t0, homeDir: home });
    expect(first).toEqual(["deepseek-flash"]);
    expect(fetches).toBe(1);

    const second = await getLiveModels({ provider: "deepseek", baseUrl: "u", apiKey: "k", fetchImpl, now: () => t0 + LIVE_MODELS_TTL_MS - 1, homeDir: home });
    expect(second).toEqual(["deepseek-flash"]);
    expect(fetches).toBe(1);

    // Past the TTL it fetches again.
    await getLiveModels({ provider: "deepseek", baseUrl: "u", apiKey: "k", fetchImpl, now: () => t0 + LIVE_MODELS_TTL_MS, homeDir: home });
    expect(fetches).toBe(2);
  });

  it("writes the cache atomically so readCachedModels sees it with no network", async () => {
    await getLiveModels({
      provider: "deepseek",
      baseUrl: "u",
      apiKey: "k",
      fetchImpl: okFetch(["deepseek-flash", "deepseek-v4-pro"]),
      now: () => 123,
      homeDir: home,
    });
    expect(existsSync(join(home, LIVE_MODELS_CACHE_FILENAME))).toBe(true);
    expect(readCachedModels("deepseek", home)).toEqual(["deepseek-flash", "deepseek-v4-pro"]);
    expect(readCachedModels("openai", home)).toBeNull();
  });

  it("returns null (never rejects) on a network error, and leaves a previous cache entry intact", async () => {
    const failing = (async () => {
      throw new Error("connection refused");
    }) as unknown as typeof fetch;

    // No prior cache → null, no throw.
    expect(await getLiveModels({ provider: "deepseek", baseUrl: "u", apiKey: "k", fetchImpl: failing, now: () => 1, homeDir: home })).toBeNull();

    // Prime the cache, then fail beyond the TTL: the previous list survives.
    const t0 = 5_000;
    await getLiveModels({ provider: "deepseek", baseUrl: "u", apiKey: "k", fetchImpl: okFetch(["deepseek-flash"]), now: () => t0, homeDir: home });
    const afterFailure = await getLiveModels({
      provider: "deepseek",
      baseUrl: "u",
      apiKey: "k",
      fetchImpl: failing,
      now: () => t0 + LIVE_MODELS_TTL_MS + 1,
      homeDir: home,
    });
    expect(afterFailure).toEqual(["deepseek-flash"]);
    expect(readCachedModels("deepseek", home)).toEqual(["deepseek-flash"]);
    // The cache file is still valid JSON, not truncated by the failed write.
    const onDisk = JSON.parse(readFileSync(join(home, LIVE_MODELS_CACHE_FILENAME), "utf-8"));
    expect(onDisk.deepseek.models).toEqual(["deepseek-flash"]);
  });
});

describe("checkModelListed", () => {
  it("reports unknown for a null list, ok for a present model, missing otherwise", () => {
    expect(checkModelListed(null, "deepseek-flash")).toBe("unknown");
    expect(checkModelListed(["deepseek-flash", "deepseek-v4-pro"], "deepseek-flash")).toBe("ok");
    expect(checkModelListed(["deepseek-flash", "deepseek-v4-pro"], "deepseek-v4-lite")).toBe("missing");
  });

  it("treats a full / bare id match in EITHER direction as listed, case-insensitively", () => {
    expect(checkModelListed(["deepseek/deepseek-flash"], "deepseek-flash")).toBe("ok");
    expect(checkModelListed(["deepseek-flash"], "deepseek/deepseek-flash")).toBe("ok");
    expect(checkModelListed(["DeepSeek-Flash"], "deepseek-flash")).toBe("ok");
  });
});
