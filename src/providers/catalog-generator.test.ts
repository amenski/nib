import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { generateCatalog } from "./catalog-generator.js";

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
    const generated = generateCatalog(fixture, { sourceRevision: "fixture-2026-08-21", generatedAt: "2026-08-21" });
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
