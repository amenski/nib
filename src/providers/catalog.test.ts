import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultKeyEnv, featuredProviderNames, loadModelCatalog, saveUserDefaultModel, saveUserProvider, UNKNOWN_MODEL_CAPS,
  type UserProviderEntry,
} from "./catalog.js";
import { CATALOG_CACHE_FILENAME } from "./catalog-update.js";

describe("loadModelCatalog", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nib-catalog-test-"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("loads the bundled catalog when there is no user override", () => {
    const catalog = loadModelCatalog(dir);
    expect(catalog.providers.deepseek).toBeDefined();
    expect(catalog.providers.deepseek.label).toBe("DeepSeek");
    expect(catalog.providers.deepseek.models["deepseek-v4-pro"]).toMatchObject({
      displayName: "DeepSeek V4 Pro",
      supportsTools: true,
      contextWindow: 1000000,
    });
    expect(catalog.providers.openrouter.models["qwen/qwen3.7-flash"]).toMatchObject({
      displayName: "Qwen3.7 Flash",
      contextWindow: 1000000,
      pricing: { inputPerM: 0.03, outputPerM: 0.13 },
    });
    expect(catalog.providers.openrouter.baseUrl).toBe("https://openrouter.ai/api/v1");
  });

  it("is fine when the user file is simply missing", () => {
    expect(() => loadModelCatalog(join(dir, "does-not-exist"))).not.toThrow();
    const catalog = loadModelCatalog(join(dir, "does-not-exist"));
    expect(catalog.providers.deepseek).toBeDefined();
  });

  it("lets a user override replace a single field on an existing model", () => {
    writeFileSync(
      join(dir, "models.json"),
      JSON.stringify({
        providers: {
          deepseek: {
            models: {
              "deepseek-v4-pro": { contextWindow: 2000000 },
            },
          },
        },
      }),
    );
    const catalog = loadModelCatalog(dir);
    const model = catalog.providers.deepseek.models["deepseek-v4-pro"];
    expect(model.contextWindow).toBe(2000000);
    // Untouched fields survive the merge.
    expect(model.displayName).toBe("DeepSeek V4 Pro");
    expect(model.supportsTools).toBe(true);
  });

  it("lets a user add a new model to an existing provider without repeating the others", () => {
    writeFileSync(
      join(dir, "models.json"),
      JSON.stringify({
        providers: {
          deepseek: {
            models: {
              "deepseek-v5-preview": {
                displayName: "DeepSeek V5 Preview",
                supportsTools: true,
                contextWindow: 500000,
              },
            },
          },
        },
      }),
    );
    const catalog = loadModelCatalog(dir);
    expect(catalog.providers.deepseek.models["deepseek-v5-preview"]).toMatchObject({
      displayName: "DeepSeek V5 Preview",
      contextWindow: 500000,
    });
    // Bundled models are still present.
    expect(catalog.providers.deepseek.models["deepseek-v4-pro"]).toBeDefined();
    expect(catalog.providers.deepseek.models["deepseek-flash"]).toBeDefined();
  });

  it("lets a user add a whole new provider", () => {
    writeFileSync(
      join(dir, "models.json"),
      JSON.stringify({
        providers: {
          myproxy: {
            label: "My Proxy",
            api: "openai-compatible",
            baseUrl: "https://proxy.example.com",
            keyEnv: "MYPROXY_API_KEY",
            defaultModel: "custom-1",
            models: {
              "custom-1": { displayName: "Custom One", supportsTools: true, contextWindow: 32000 },
            },
          },
        },
      }),
    );
    const catalog = loadModelCatalog(dir);
    expect(catalog.providers.myproxy).toMatchObject({
      label: "My Proxy",
      baseUrl: "https://proxy.example.com",
      defaultModel: "custom-1",
    });
    expect(catalog.providers.myproxy.models["custom-1"]).toMatchObject({ displayName: "Custom One" });
    // Bundled providers are untouched.
    expect(catalog.providers.deepseek).toBeDefined();
  });

  it("warns to stderr and falls back to the bundled catalog on malformed JSON, without throwing", () => {
    writeFileSync(join(dir, "models.json"), "{ not valid json");
    let catalog: ReturnType<typeof loadModelCatalog> | undefined;
    expect(() => { catalog = loadModelCatalog(dir); }).not.toThrow();
    expect(console.warn).toHaveBeenCalled();
    expect(catalog!.providers.deepseek.models["deepseek-v4-pro"]).toMatchObject({
      displayName: "DeepSeek V4 Pro",
    });
  });

  it("warns and falls back when the user file's root is not an object", () => {
    writeFileSync(join(dir, "models.json"), JSON.stringify(["not", "an", "object"]));
    const catalog = loadModelCatalog(dir);
    expect(console.warn).toHaveBeenCalled();
    expect(catalog.providers.deepseek).toBeDefined();
  });

  it("marks a model free when the bundled or user catalog sets free: true", () => {
    writeFileSync(
      join(dir, "models.json"),
      JSON.stringify({
        providers: {
          deepseek: {
            models: {
              "deepseek-flash": { free: true },
            },
          },
        },
      }),
    );
    const catalog = loadModelCatalog(dir);
    expect(catalog.providers.deepseek.models["deepseek-flash"].free).toBe(true);
    expect(catalog.providers.deepseek.models["deepseek-v4-pro"].free).toBeUndefined();
  });

  it("layers a cached updated snapshot (models-catalog.json) over the bundled catalog", () => {
    writeFileSync(
      join(dir, CATALOG_CACHE_FILENAME),
      JSON.stringify({
        providers: {
          deepseek: {
            models: {
              "deepseek-v4-pro": { contextWindow: 2000000 },
              "deepseek-v5-new": { displayName: "DeepSeek V5 New", supportsTools: true, contextWindow: 500000 },
            },
          },
        },
      }),
    );
    const catalog = loadModelCatalog(dir);
    expect(catalog.providers.deepseek.models["deepseek-v4-pro"].contextWindow).toBe(2000000);
    expect(catalog.providers.deepseek.models["deepseek-v5-new"]).toMatchObject({ displayName: "DeepSeek V5 New" });
    // Untouched sibling still present.
    expect(catalog.providers.deepseek.models["deepseek-flash"]).toBeDefined();
  });

  it("lets the user override win over a cached updated snapshot", () => {
    writeFileSync(
      join(dir, CATALOG_CACHE_FILENAME),
      JSON.stringify({ providers: { deepseek: { models: { "deepseek-v4-pro": { contextWindow: 2000000 } } } } }),
    );
    writeFileSync(
      join(dir, "models.json"),
      JSON.stringify({ providers: { deepseek: { models: { "deepseek-v4-pro": { contextWindow: 3000000 } } } } }),
    );
    const catalog = loadModelCatalog(dir);
    expect(catalog.providers.deepseek.models["deepseek-v4-pro"].contextWindow).toBe(3000000);
  });

  it("takes only models and the default model from the cache, never connection fields or new providers", () => {
    writeFileSync(
      join(dir, CATALOG_CACHE_FILENAME),
      JSON.stringify({ providers: {
        zai: { baseUrl: "https://stale.example/v1", keyEnv: "STALE", defaultModel: "glm-5.3", models: {} },
        "not-bundled": { baseUrl: "https://x.example/v1", models: { m: { supportsTools: true, contextWindow: 1 } } },
      } }),
    );
    const catalog = loadModelCatalog(dir);
    expect(catalog.providers.zai).toMatchObject({ baseUrl: "https://api.z.ai/api/paas/v4", keyEnv: "ZHIPU_API_KEY", defaultModel: "glm-5.3" });
    expect(catalog.providers["not-bundled"]).toBeUndefined();
  });

  it("lists every openai-compatible Models.dev provider, featured ones first", () => {
    const catalog = loadModelCatalog(dir);
    expect(Object.keys(catalog.providers).length).toBeGreaterThan(100);
    expect(catalog.providers.zai).toMatchObject({ label: "Z.AI", baseUrl: "https://api.z.ai/api/paas/v4", keyEnv: "ZHIPU_API_KEY" });
    expect(featuredProviderNames(catalog)).toEqual(["deepseek", "openai", "openrouter", "groq", "ollama"]);
    expect(Object.keys(catalog.providers).slice(0, 5)).toEqual(featuredProviderNames(catalog));
  });

  it("is fine when there is no cached snapshot file (falls back to the bundled catalog)", () => {
    expect(() => loadModelCatalog(dir)).not.toThrow();
    const catalog = loadModelCatalog(dir);
    expect(catalog.providers.deepseek.models["deepseek-v4-pro"].contextWindow).toBe(1000000);
  });
});

describe("saveUserProvider", () => {
  let dir: string;

  function entry(overrides: Partial<UserProviderEntry> = {}): UserProviderEntry {
    return {
      label: "My Qwen",
      baseUrl: "https://example.com/v1",
      keyEnv: defaultKeyEnv("my-qwen"),
      defaultModel: "qwen3-coder-plus",
      models: { "qwen3-coder-plus": { ...UNKNOWN_MODEL_CAPS } },
      ...overrides,
    };
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nib-catalog-save-test-"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("creates models.json and registers the provider in the catalog", async () => {
    const path = await saveUserProvider("my-qwen", entry(), dir);
    expect(path).toBe(join(dir, "models.json"));

    const provider = loadModelCatalog(dir).providers["my-qwen"];
    expect(provider).toMatchObject({
      label: "My Qwen",
      api: "openai-compatible",
      baseUrl: "https://example.com/v1",
      keyEnv: "MY_QWEN_API_KEY",
      defaultModel: "qwen3-coder-plus",
    });
    expect(provider.models["qwen3-coder-plus"]).toEqual({ supportsTools: true, contextWindow: 128000 });
  });

  it("keeps other providers and existing models of the same provider", async () => {
    writeFileSync(
      join(dir, "models.json"),
      JSON.stringify({
        providers: {
          other: { baseUrl: "https://other/v1", models: {} },
          qwen: { baseUrl: "https://old/v1", models: { "qwen-max": { supportsTools: true, contextWindow: 32000 } } },
        },
      }),
    );

    await saveUserProvider("qwen", entry({
      baseUrl: "https://new/v1",
      models: { "qwen3-coder-plus": { ...UNKNOWN_MODEL_CAPS }, "qwen-max": { supportsTools: true, contextWindow: 1000000 } },
    }), dir);

    const saved = JSON.parse(readFileSync(join(dir, "models.json"), "utf-8"));
    expect(saved.providers.other).toEqual({ baseUrl: "https://other/v1", models: {} });
    expect(saved.providers.qwen.baseUrl).toBe("https://new/v1");
    expect(saved.providers.qwen.defaultModel).toBe("qwen3-coder-plus");
    // The hand-tuned entry already in the file wins over the new one.
    expect(saved.providers.qwen.models["qwen-max"]).toEqual({ supportsTools: true, contextWindow: 32000 });
    expect(saved.providers.qwen.models["qwen3-coder-plus"]).toBeDefined();
  });

  it("refuses to overwrite a malformed models.json", async () => {
    const path = join(dir, "models.json");
    writeFileSync(path, "{ not json");

    await expect(saveUserProvider("qwen", entry(), dir)).rejects.toThrow(path);
    expect(readFileSync(path, "utf-8")).toBe("{ not json");
  });
});

describe("saveUserDefaultModel", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "nib-catalog-default-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
  const read = () => JSON.parse(readFileSync(join(dir, "models.json"), "utf-8"));

  it("writes only defaultModel and keeps the provider's other overrides", async () => {
    writeFileSync(join(dir, "models.json"), JSON.stringify({ providers: { zai: { models: { "glm-5.3": { contextWindow: 1 } } } } }));
    await saveUserDefaultModel("zai", "glm-5.3-flashx", dir);
    expect(read().providers.zai).toEqual({ models: { "glm-5.3": { contextWindow: 1 } }, defaultModel: "glm-5.3-flashx" });
  });

  it("clears a stale default with undefined, removing a block left empty", async () => {
    writeFileSync(join(dir, "models.json"), JSON.stringify({ providers: { zai: { defaultModel: "old" }, other: { defaultModel: "x" } } }));
    await saveUserDefaultModel("zai", undefined, dir);
    expect(read().providers).toEqual({ other: { defaultModel: "x" } });
  });
});

describe("defaultKeyEnv", () => {
  it("uppercases the name and replaces non-alphanumerics", () => {
    expect(defaultKeyEnv("my-llm.v2")).toBe("MY_LLM_V2_API_KEY");
  });
});
