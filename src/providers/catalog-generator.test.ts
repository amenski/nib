import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { generateCatalog, generateCatalogReport } from "./catalog-generator.js";

const model = (extra: Record<string, unknown> = {}) => ({
  name: "Example",
  limit: { context: 128000 },
  tool_call: true,
  cost: { input: 1, output: 2 },
  ...extra,
});

function input(overrides: Record<string, unknown> = {}) {
  const providers: Record<string, unknown> = {};
  for (const name of ["deepseek", "openai", "openrouter", "groq", "ollama"]) providers[name] = { models: { "z-model": model() } };
  return { providers: { ...providers, ...overrides } };
}

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
    });
    expect(generated).toEqual(snapshot);
  });

  it("normalizes and sorts Models.dev data deterministically", () => {
    const result = generateCatalog(input({
      openrouter: { models: {
        "b-model": model({ name: "B", reasoning_options: [{ type: "effort", values: ["high", "low", "high"] }] }),
        "a-model": model({ name: "A" }),
      } },
    }), { sourceRevision: "abc", generatedAt: "2026-08-21" });
    expect(Object.keys((result.providers as any).openrouter.models)).toEqual(["a-model", "b-model"]);
    expect((result.providers as any).openrouter.models["b-model"]).toMatchObject({
      displayName: "B", supportsTools: true, contextWindow: 128000,
      effort: { values: ["high", "low"], default: "high" },
    });
  });

  it("accepts the raw Models.dev provider map as well as a wrapped input", () => {
    const generated = generateCatalog(input().providers, { sourceRevision: "abc", generatedAt: "2026-08-21" });
    expect((generated.providers as any).deepseek.models["z-model"]).toMatchObject({ displayName: "Example" });
  });

  it("includes provider-specific OpenRouter Qwen metadata", () => {
    const result = generateCatalog(input({ openrouter: { models: { "qwen/qwen3.7-flash": model({ name: "Qwen3.7 Flash", limit: { context: 1000000 }, cost: { input: 0.03, output: 0.13 } }) } } }), { sourceRevision: "abc", generatedAt: "today" });
    expect((result.providers as any).openrouter.models["qwen/qwen3.7-flash"]).toMatchObject({ contextWindow: 1000000, pricing: { inputPerM: 0.03, outputPerM: 0.13 } });
  });

  it("derives vision from models.dev modalities.input", () => {
    const result = generateCatalog(input({
      deepseek: { models: {
        "sees-images": model({ modalities: { input: ["text", "image"] } }),
        "text-only": model({ modalities: { input: ["text"] } }),
        "no-modality": model(),
      } },
    }), { sourceRevision: "abc", generatedAt: "today" });
    const models = (result.providers as any).deepseek.models;
    expect(models["sees-images"].vision).toBe(true);
    expect(models["text-only"].vision).toBe(false);
    expect(models["no-modality"].vision).toBeUndefined();
  });

  it("preserves provider effort defaults when normalizing options", () => {
    const generated = generateCatalog(input({
      deepseek: { models: { deep: model({ reasoning_options: ["low", "high"] }) } },
      groq: { models: { groq: model({ reasoning_options: ["low", "medium", "high"] }) } },
    }), { sourceRevision: "abc", generatedAt: "today" });
    expect((generated.providers as any).deepseek.models.deep.effort.default).toBe("high");
    expect((generated.providers as any).groq.models.groq.effort.default).toBe("medium");
  });

  it("rejects missing providers, invalid limits, and negative costs", () => {
    expect(() => generateCatalog({ providers: {} }, { sourceRevision: "x", generatedAt: "y" })).toThrow(/missing supported provider/);
    expect(() => generateCatalog(input({ deepseek: { models: { bad: model({ limit: { context: 0 } }) } } }), { sourceRevision: "x", generatedAt: "y" })).toThrow(/positive number/);
    expect(() => generateCatalog(input({ deepseek: { models: { bad: model({ cost: { input: -1, output: 2 } }) } } }), { sourceRevision: "x", generatedAt: "y" })).toThrow(/non-negative/);
  });

  it("rejects a preset default that is absent from the generated provider", () => {
    expect(() => generateCatalog(input(), { sourceRevision: "x", generatedAt: "y", defaultModels: { openrouter: "missing" } })).toThrow(/default model is missing/);
  });
});

// `lenient: true` is what `heirloom models update` sets against the live
// Models.dev feed (unlike `npm run models:generate`, which keeps strict
// throwing against the checked-in fixture — see GeneratorOptions.lenient).
describe("generateCatalog / generateCatalogReport — lenient mode", () => {
  it("skips a bad model and keeps its siblings", () => {
    const result = generateCatalog(input({
      openai: { models: {
        "good-model": model({ name: "Good" }),
        "bad-model": model({ name: "Bad", limit: { context: 0 } }),
      } },
    }), { sourceRevision: "x", generatedAt: "y", lenient: true });
    const models = (result.providers as any).openai.models;
    expect(models["good-model"]).toBeDefined();
    expect(models["bad-model"]).toBeUndefined();
  });

  it("skips a SUPPORTED_PROVIDERS entry absent from the feed instead of throwing", () => {
    const { ollama, ...rest } = input().providers as Record<string, unknown>;
    const result = generateCatalog({ providers: rest }, { sourceRevision: "x", generatedAt: "y", lenient: true });
    expect((result.providers as any).ollama).toBeUndefined();
    expect((result.providers as any).deepseek).toBeDefined();
  });

  it("skips a provider present in the feed but with an empty models object instead of throwing", () => {
    const result = generateCatalog(input({ ollama: { models: {} } }), { sourceRevision: "x", generatedAt: "y", lenient: true });
    expect((result.providers as any).ollama).toBeUndefined();
    expect((result.providers as any).deepseek).toBeDefined();
  });

  it("non-lenient (default) still throws when a provider present in the feed has an empty models object", () => {
    expect(() => generateCatalog(input({ ollama: { models: {} } }), { sourceRevision: "x", generatedAt: "y" })).toThrow(/ollama must contain models/);
  });

  it("still throws when a provider present in the feed is missing its configured default", () => {
    expect(() => generateCatalog(input(), {
      sourceRevision: "x", generatedAt: "y", lenient: true, defaultModels: { openrouter: "missing" },
    })).toThrow(/default model is missing/);
  });

  it("non-lenient (default) behavior is unchanged: still throws on a missing provider and a bad model", () => {
    expect(() => generateCatalog({ providers: {} }, { sourceRevision: "x", generatedAt: "y" })).toThrow(/missing supported provider/);
    expect(() => generateCatalog(input({ openai: { models: { bad: model({ limit: { context: 0 } }) } } }), { sourceRevision: "x", generatedAt: "y" })).toThrow(/positive number/);
  });

  it("generateCatalogReport reports skipped models and skipped providers", () => {
    const { ollama, ...rest } = input({
      openai: { models: {
        "good-model": model({ name: "Good" }),
        "bad-model": model({ name: "Bad", limit: { context: 0 } }),
      } },
    }).providers as Record<string, unknown>;
    const report = generateCatalogReport({ providers: rest }, { sourceRevision: "x", generatedAt: "y", lenient: true });
    expect(report.skippedModels).toEqual(["openai/bad-model"]);
    expect(report.skippedProviders).toEqual([{ provider: "ollama", reason: "absent" }]);
    expect((report.catalog.providers as any).openai.models["good-model"]).toBeDefined();
  });

  it("generateCatalogReport tags a present-but-empty provider with reason: empty, distinct from an absent one", () => {
    const { groq, ...rest } = input({ ollama: { models: {} } }).providers as Record<string, unknown>;
    const report = generateCatalogReport({ providers: rest }, { sourceRevision: "x", generatedAt: "y", lenient: true });
    expect(report.skippedProviders).toEqual(expect.arrayContaining([
      { provider: "ollama", reason: "empty" },
      { provider: "groq", reason: "absent" },
    ]));
  });

  it("generateCatalogReport reports no skips for well-formed input", () => {
    const report = generateCatalogReport(input(), { sourceRevision: "x", generatedAt: "y", lenient: true });
    expect(report.skippedModels).toEqual([]);
    expect(report.skippedProviders).toEqual([]);
  });

  it("generateCatalogReport in non-lenient mode (default) throws exactly like generateCatalog", () => {
    expect(() => generateCatalogReport({ providers: {} }, { sourceRevision: "x", generatedAt: "y" })).toThrow(/missing supported provider/);
  });
});
