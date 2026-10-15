import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { generateCatalog, generateCatalogReport, type ProviderOverlay } from "./catalog-generator.js";
import { PROVIDER_OVERLAY } from "./provider-overlay.js";

const model = (extra: Record<string, unknown> = {}) => ({
  name: "Example",
  limit: { context: 128000 },
  tool_call: true,
  cost: { input: 1, output: 2 },
  ...extra,
});

const FEATURED = ["deepseek", "openai", "openrouter", "groq", "ollama"];

// The featured providers, minus their real default models (the inputs below
// only carry "z-model").
const overlay: Record<string, ProviderOverlay> = Object.fromEntries(FEATURED.map((name) => [name, {
  featured: true, label: name, baseUrl: `https://${name}.example/v1`, keyEnv: `${name.toUpperCase()}_API_KEY`,
}]));

function input(overrides: Record<string, unknown> = {}) {
  const providers: Record<string, unknown> = {};
  for (const name of FEATURED) providers[name] = { models: { "z-model": model() } };
  return { providers: { ...providers, ...overrides } };
}

const opts = (extra: Record<string, unknown> = {}) => ({ sourceRevision: "x", generatedAt: "y", overlay, ...extra });

const compat = (models: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  npm: "@ai-sdk/openai-compatible", api: "https://api.compat.example/v1/", env: ["COMPAT_KEY"], name: "Compat", models, ...extra,
});

describe("generateCatalog", () => {
  it("matches the checked-in snapshot for the fixture", () => {
    const fixture = JSON.parse(readFileSync(resolve("scripts/fixtures/models.dev.json"), "utf8"));
    const snapshot = JSON.parse(readFileSync(resolve("src/providers/models.json"), "utf8"));
    // Mirrors scripts/generate-models.ts's provenance derivation: the fixture
    // carries its own capture.source/capturedAt (stamped by
    // capture-models-fixture.ts), so the expected sourceRevision/generatedAt
    // here must be read from it too, not hardcoded — a hardcoded value here
    // would just reintroduce the same lying-provenance bug in a test.
    const generated = generateCatalog(fixture, {
      sourceRevision: `models.dev:${fixture.capture.source}`,
      generatedAt: fixture.capture.capturedAt,
      overlay: PROVIDER_OVERLAY,
    });
    expect(generated).toEqual(snapshot);
  });

  it("normalizes and sorts Models.dev data deterministically", () => {
    const result = generateCatalog(input({
      openrouter: { models: {
        "b-model": model({ name: "B", reasoning_options: [{ type: "effort", values: ["high", "low", "high"] }] }),
        "a-model": model({ name: "A" }),
      } },
    }), { sourceRevision: "abc", generatedAt: "2026-08-21", overlay });
    expect(Object.keys((result.providers as any).openrouter.models)).toEqual(["a-model", "b-model"]);
    expect((result.providers as any).openrouter.models["b-model"]).toMatchObject({
      displayName: "B", supportsTools: true, contextWindow: 128000,
      effort: { values: ["high", "low"], default: "high" },
    });
  });

  it("accepts the raw Models.dev provider map as well as a wrapped input", () => {
    const generated = generateCatalog(input().providers, { sourceRevision: "abc", generatedAt: "2026-08-21", overlay });
    expect((generated.providers as any).deepseek.models["z-model"]).toMatchObject({ displayName: "Example" });
  });

  it("includes provider-specific OpenRouter Qwen metadata", () => {
    const result = generateCatalog(input({ openrouter: { models: { "qwen/qwen3.7-flash": model({ name: "Qwen3.7 Flash", limit: { context: 1000000 }, cost: { input: 0.03, output: 0.13 } }) } } }), { sourceRevision: "abc", generatedAt: "today", overlay });
    expect((result.providers as any).openrouter.models["qwen/qwen3.7-flash"]).toMatchObject({ contextWindow: 1000000, pricing: { inputPerM: 0.03, outputPerM: 0.13 } });
  });

  it("derives vision from models.dev modalities.input", () => {
    const result = generateCatalog(input({
      deepseek: { models: {
        "sees-images": model({ modalities: { input: ["text", "image"] } }),
        "text-only": model({ modalities: { input: ["text"] } }),
        "no-modality": model(),
      } },
    }), { sourceRevision: "abc", generatedAt: "today", overlay });
    const models = (result.providers as any).deepseek.models;
    expect(models["sees-images"].vision).toBe(true);
    expect(models["text-only"].vision).toBe(false);
    expect(models["no-modality"].vision).toBeUndefined();
  });

  it("preserves provider effort defaults when normalizing options", () => {
    const generated = generateCatalog(input({
      deepseek: { models: { deep: model({ reasoning_options: ["low", "high"] }) } },
      groq: { models: { groq: model({ reasoning_options: ["low", "medium", "high"] }) } },
    }), { sourceRevision: "abc", generatedAt: "today", overlay });
    expect((generated.providers as any).deepseek.models.deep.effort.default).toBe("high");
    expect((generated.providers as any).groq.models.groq.effort.default).toBe("medium");
  });

  it("rejects missing providers, invalid limits, and negative costs", () => {
    expect(() => generateCatalog({ providers: {} }, opts())).toThrow(/missing featured provider/);
    expect(() => generateCatalog(input({ deepseek: { models: { bad: model({ limit: { context: 0 } }) } } }), opts())).toThrow(/positive number/);
    expect(() => generateCatalog(input({ deepseek: { models: { bad: model({ cost: { input: -1, output: 2 } }) } } }), opts())).toThrow(/non-negative/);
  });

  it("rejects a featured default that is absent from the generated provider", () => {
    expect(() => generateCatalog(input(), opts({ overlay: { ...overlay, openrouter: { ...overlay.openrouter, defaultModel: "missing" } } }))).toThrow(/default model is missing/);
  });

  it("lists featured providers first in overlay order, then the rest sorted", () => {
    const result = generateCatalog(input({ "b-host": compat({ m: model() }), "a-host": compat({ m: model() }) }), opts());
    expect(Object.keys(result.providers as object)).toEqual([...FEATURED, "a-host", "b-host"]);
    expect((result.providers as any).deepseek).toMatchObject({ featured: true, label: "deepseek", baseUrl: "https://deepseek.example/v1" });
    expect((result.providers as any)["a-host"].featured).toBeUndefined();
  });

  it("takes an openai-compatible provider's connection from the feed", () => {
    const result = generateCatalog(input({ zai: compat({ m: model() }, { name: "Z.AI", env: ["ZHIPU_API_KEY"] }) }), opts());
    expect((result.providers as any).zai).toMatchObject({
      label: "Z.AI", api: "openai-compatible", baseUrl: "https://api.compat.example/v1", keyEnv: "ZHIPU_API_KEY", defaultModel: "m",
    });
  });

  it("skips non-openai-compatible, disallowed-URL and tool-less providers", () => {
    const report = generateCatalogReport(input({
      other: compat({ m: model() }, { npm: "@ai-sdk/anthropic" }),
      plain: compat({ m: model() }, { api: "http://remote.example/v1" }),
      toolless: compat({ m: model({ tool_call: false }) }),
    }), opts());
    const ids = Object.keys(report.catalog.providers as object);
    expect(ids).not.toContain("other");
    expect(ids).not.toContain("plain");
    expect(ids).not.toContain("toolless");
    expect(report.skippedProviders).toEqual([{ provider: "toolless", reason: "empty" }]);
  });

  it("gives a local http provider no key variable and falls back to NAME_API_KEY without env", () => {
    const result = generateCatalog(input({
      lmstudio: compat({ m: model() }, { api: "http://127.0.0.1:1234/v1" }),
      "my-host": compat({ m: model() }, { env: [] }),
    }), opts());
    expect((result.providers as any).lmstudio.keyEnv).toBe("");
    expect((result.providers as any)["my-host"].keyEnv).toBe("MY_HOST_API_KEY");
  });

  it("defaults a non-featured provider to its newest tool-capable model", () => {
    const result = generateCatalog(input({ zai: compat({
      old: model({ release_date: "2025-01-01" }),
      newest: model({ release_date: "2026-09-01" }),
      "no-tools": model({ release_date: "2026-10-01", tool_call: false }),
    }) }), opts());
    expect((result.providers as any).zai.defaultModel).toBe("newest");
  });

  it("keeps a non-featured provider's preferred default while it exists, else falls back", () => {
    const feed = input({ zai: compat({ a: model({ release_date: "2025-01-01" }), b: model({ release_date: "2026-01-01" }) }) });
    const prefer = (defaultModel: string) => generateCatalog(feed, opts({ overlay: { ...overlay, zai: { defaultModel } } }));
    expect((prefer("a").providers as any).zai.defaultModel).toBe("a");
    expect((prefer("gone").providers as any).zai.defaultModel).toBe("b");
  });

  it("with `only`, generates exactly those providers and reports a missing one as absent", () => {
    const report = generateCatalogReport(input({ zai: compat({ m: model() }), extra: compat({ m: model() }) }), opts({
      only: ["deepseek", "zai", "gone"], lenient: true,
    }));
    expect(Object.keys(report.catalog.providers as object)).toEqual(["deepseek", "zai"]);
    expect(report.skippedProviders).toEqual([{ provider: "gone", reason: "absent" }]);
  });
});

// `lenient: true` is what `nib models update` sets against the live
// Models.dev feed (unlike `npm run models:generate`, which keeps strict
// throwing against the checked-in fixture — see GeneratorOptions.lenient).
describe("generateCatalog / generateCatalogReport — lenient mode", () => {
  it("skips a bad model and keeps its siblings", () => {
    const result = generateCatalog(input({
      openai: { models: {
        "good-model": model({ name: "Good" }),
        "bad-model": model({ name: "Bad", limit: { context: 0 } }),
      } },
    }), opts({ lenient: true }));
    const models = (result.providers as any).openai.models;
    expect(models["good-model"]).toBeDefined();
    expect(models["bad-model"]).toBeUndefined();
  });

  it("skips a featured provider absent from the feed instead of throwing", () => {
    const { ollama, ...rest } = input().providers as Record<string, unknown>;
    const result = generateCatalog({ providers: rest }, opts({ lenient: true }));
    expect((result.providers as any).ollama).toBeUndefined();
    expect((result.providers as any).deepseek).toBeDefined();
  });

  it("skips a provider present in the feed but with an empty models object instead of throwing", () => {
    const result = generateCatalog(input({ ollama: { models: {} } }), opts({ lenient: true }));
    expect((result.providers as any).ollama).toBeUndefined();
    expect((result.providers as any).deepseek).toBeDefined();
  });

  it("non-lenient (default) still throws when a provider present in the feed has an empty models object", () => {
    expect(() => generateCatalog(input({ ollama: { models: {} } }), opts())).toThrow(/ollama must contain models/);
  });

  it("still throws when a provider present in the feed is missing its configured default", () => {
    expect(() => generateCatalog(input(), opts({
      lenient: true, overlay: { ...overlay, openrouter: { ...overlay.openrouter, defaultModel: "missing" } },
    }))).toThrow(/default model is missing/);
  });

  it("non-lenient (default) behavior is unchanged: still throws on a missing provider and a bad model", () => {
    expect(() => generateCatalog({ providers: {} }, opts())).toThrow(/missing featured provider/);
    expect(() => generateCatalog(input({ openai: { models: { bad: model({ limit: { context: 0 } }) } } }), opts())).toThrow(/positive number/);
  });

  it("generateCatalogReport reports skipped models and skipped providers", () => {
    const { ollama, ...rest } = input({
      openai: { models: {
        "good-model": model({ name: "Good" }),
        "bad-model": model({ name: "Bad", limit: { context: 0 } }),
      } },
    }).providers as Record<string, unknown>;
    const report = generateCatalogReport({ providers: rest }, opts({ lenient: true }));
    expect(report.skippedModels).toEqual(["openai/bad-model"]);
    expect(report.skippedProviders).toEqual([{ provider: "ollama", reason: "absent" }]);
    expect((report.catalog.providers as any).openai.models["good-model"]).toBeDefined();
  });

  it("generateCatalogReport tags a present-but-empty provider with reason: empty, distinct from an absent one", () => {
    const { groq, ...rest } = input({ ollama: { models: {} } }).providers as Record<string, unknown>;
    const report = generateCatalogReport({ providers: rest }, opts({ lenient: true }));
    expect(report.skippedProviders).toEqual(expect.arrayContaining([
      { provider: "ollama", reason: "empty" },
      { provider: "groq", reason: "absent" },
    ]));
  });

  it("generateCatalogReport reports no skips for well-formed input", () => {
    const report = generateCatalogReport(input(), opts({ lenient: true }));
    expect(report.skippedModels).toEqual([]);
    expect(report.skippedProviders).toEqual([]);
  });

  it("generateCatalogReport in non-lenient mode (default) throws exactly like generateCatalog", () => {
    expect(() => generateCatalogReport({ providers: {} }, opts())).toThrow(/missing featured provider/);
  });
});
