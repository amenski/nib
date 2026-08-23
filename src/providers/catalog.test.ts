import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadModelCatalog } from "./catalog.js";
import { CATALOG_CACHE_FILENAME } from "./catalog-update.js";

describe("loadModelCatalog", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "heirloom-catalog-test-"));
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
    expect(catalog.providers.deepseek.models["deepseek-v4-flash"]).toBeDefined();
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
              "deepseek-v4-flash": { free: true },
            },
          },
        },
      }),
    );
    const catalog = loadModelCatalog(dir);
    expect(catalog.providers.deepseek.models["deepseek-v4-flash"].free).toBe(true);
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
    expect(catalog.providers.deepseek.models["deepseek-v4-flash"]).toBeDefined();
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

  it("is fine when there is no cached snapshot file (falls back to the bundled catalog)", () => {
    expect(() => loadModelCatalog(dir)).not.toThrow();
    const catalog = loadModelCatalog(dir);
    expect(catalog.providers.deepseek.models["deepseek-v4-pro"].contextWindow).toBe(1000000);
  });
});
