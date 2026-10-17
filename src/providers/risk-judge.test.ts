import { describe, it, expect, vi, beforeEach } from "vitest";

const configured: Record<string, boolean> = {};
const models: Record<string, Record<string, { contextWindow: number }>> = {};
const presets: Record<string, { models: Record<string, { contextWindow: number }> }> = {};
const created: { name: string; model?: string }[] = [];
const sent: { messages: unknown; tools: unknown; options: unknown }[] = [];
let stream: () => AsyncGenerator<{ type: string; content?: string }>;

vi.mock("./presets.js", () => ({
  getConfiguredProviders: () => configured,
  getProviderModels: (name: string) => models[name],
  getPreset: (name: string) => presets[name],
  createProvider: (name: string, options?: { modelOverride?: string }) => {
    created.push({ name, ...(options?.modelOverride !== undefined ? { model: options.modelOverride } : {}) });
    return {
      name,
      streamChat: (messages: unknown, tools: unknown, options: unknown) => {
        sent.push({ messages, tools, options });
        return stream();
      },
    };
  },
}));

import type { Provider } from "./types.js";
import { createAutoJudge, createRiskJudge, findJudgeModel } from "./risk-judge.js";

beforeEach(() => {
  for (const key of Object.keys(configured)) delete configured[key];
  for (const key of Object.keys(models)) delete models[key];
  for (const key of Object.keys(presets)) delete presets[key];
  created.length = 0;
  sent.length = 0;
  stream = async function* () {
    yield { type: "text_delta", content: "OK" };
    yield { type: "done" };
  };
});

describe("findJudgeModel", () => {
  it("picks a cheap-class model by name, not by the catalog's approximate price", () => {
    // `pricing` is documented as never feeding a routing decision
    // (providers/types.ts), so the selection is by class of model. A name
    // pattern is honest about being a preference, which a price sort is not.
    configured.anthropic = true;
    models.anthropic = { "claude-fable-5-1": { contextWindow: 1 }, "claude-haiku-5-5": { contextWindow: 1 } };
    expect(findJudgeModel()).toBe("anthropic/claude-haiku-5-5");
  });

  it("prefers the session's own provider when it has a cheap model", () => {
    configured.anthropic = true;
    configured.deepseek = true;
    models.anthropic = { "claude-haiku-5-5": { contextWindow: 1 } };
    models.deepseek = { "deepseek-flash": { contextWindow: 1 } };
    expect(findJudgeModel("deepseek")).toBe("deepseek/deepseek-flash");
    expect(findJudgeModel("anthropic")).toBe("anthropic/claude-haiku-5-5");
  });

  it("reads the built-in preset when the catalog has no entry for a provider", () => {
    configured.local = true;
    presets.local = { models: { "llama3-mini": { contextWindow: 1 } } };
    expect(findJudgeModel()).toBe("local/llama3-mini");
  });

  it("returns nothing when no configured provider has a cheap model", () => {
    configured.anthropic = true;
    models.anthropic = { "claude-fable-5-1": { contextWindow: 1 } };
    expect(findJudgeModel()).toBeUndefined();
  });

  it("returns nothing when no provider is configured at all", () => {
    expect(findJudgeModel()).toBeUndefined();
    configured.anthropic = false;
    models.anthropic = { "claude-haiku-5-5": { contextWindow: 1 } };
    expect(findJudgeModel()).toBeUndefined();
  });
});

describe("createRiskJudge", () => {
  it("is undefined when the stage is off, whatever else is configured", () => {
    expect(createRiskJudge({ enabled: false, id: "anthropic/claude-haiku-5-5" })).toBeUndefined();
  });

  it("is undefined rather than throwing when nothing usable can be resolved", () => {
    // `enabled` with no reachable model is a configuration to degrade out of,
    // not a startup failure: the classifier stays rules-only.
    expect(createRiskJudge({ enabled: true })).toBeUndefined();
    expect(createRiskJudge({ enabled: true, id: "malformed" })).toBeUndefined();
    expect(createRiskJudge({ enabled: true, id: "provider/" })).toBeUndefined();
  });

  it("uses the configured id verbatim, provider and model split on the slash", () => {
    const options = createRiskJudge({ enabled: true, id: "zai/glm-5.3-flash" });
    expect(created).toEqual([{ name: "zai", model: "glm-5.3-flash" }]);
    expect(options?.timeoutMs).toBe(3000);
  });

  it("falls back to the resolved cheap model when no id is given", () => {
    configured.anthropic = true;
    models.anthropic = { "claude-haiku-5-5": { contextWindow: 1 } };
    createRiskJudge({ enabled: true });
    expect(created).toEqual([{ name: "anthropic", model: "claude-haiku-5-5" }]);
  });

  it("sends one system message and one user message, with no tools and no thinking", async () => {
    const judge = createRiskJudge({ enabled: true, id: "p/m" })!.judge;
    await judge({ system: "S", user: "U" });
    expect(sent[0].messages).toEqual([
      { role: "system", content: "S" },
      { role: "user", content: "U" },
    ]);
    // No tools: the judge answers, it does not act.
    expect(sent[0].tools).toEqual([]);
    expect(sent[0].options).toMatchObject({ temperature: 0, maxTokens: 80 });
  });

  it("passes the abort signal through, so the deadline can cancel the request", async () => {
    const controller = new AbortController();
    const judge = createRiskJudge({ enabled: true, id: "p/m" })!.judge;
    await judge({ system: "S", user: "U" }, controller.signal);
    expect((sent[0].options as { signal?: AbortSignal }).signal).toBe(controller.signal);
  });

  it("joins the streamed text and stops at done", async () => {
    stream = async function* () {
      yield { type: "text_delta", content: "FL" };
      yield { type: "text_delta", content: "AG" };
      yield { type: "done" };
      yield { type: "text_delta", content: "never read" };
    };
    const judge = createRiskJudge({ enabled: true, id: "p/m" })!.judge;
    expect(await judge({ system: "S", user: "U" })).toBe("FLAG");
  });
});

describe("createAutoJudge", () => {
  const providerOf = () =>
    ({
      name: "p",
      streamChat: (messages: unknown, tools: unknown, options: unknown) => {
        sent.push({ messages, tools, options });
        return stream();
      },
    }) as unknown as Provider;

  it("resolves the provider per request, so a model switch applies to the next call", async () => {
    let resolved = 0;
    const judge = createAutoJudge(() => {
      resolved += 1;
      return { provider: providerOf() };
    });
    await judge({ system: "S", user: "U" });
    await judge({ system: "S", user: "U" });
    expect(resolved).toBe(2);
  });

  it("sends system and user only, temperature 0, no tools, the caller's maxTokens and the signal", async () => {
    const controller = new AbortController();
    const judge = createAutoJudge(() => ({ provider: providerOf() }));
    expect(await judge({ system: "S", user: "U" }, controller.signal, { maxTokens: 256 })).toBe("OK");
    expect(sent[0].messages).toEqual([
      { role: "system", content: "S" },
      { role: "user", content: "U" },
    ]);
    expect(sent[0].tools).toEqual([]);
    expect(sent[0].options).toMatchObject({ temperature: 0, maxTokens: 256, signal: controller.signal });
    expect(sent[0].options).not.toHaveProperty("effort");
  });

  it.each([
    [["none", "low"], "none"],
    [["none", "high"], "none"],
    [["high", "low", "max"], "low"],
    [["max", "high"], "high"],
    [["medium", "minimal"], "minimal"],
    [["turbo"], undefined],
    [[], undefined],
  ] as [string[], string | undefined][])("effort list %j sends %s", async (values, expected) => {
    const caps = { supportsTools: true, contextWindow: 1, effort: { values, default: values[0] ?? "" } };
    await createAutoJudge(() => ({ provider: providerOf(), caps }))({ system: "S", user: "U" });
    if (expected === undefined) expect(sent[0].options).not.toHaveProperty("effort");
    else expect(sent[0].options).toMatchObject({ effort: expected });
  });

  it("omits effort when the model has no effort list at all", async () => {
    await createAutoJudge(() => ({ provider: providerOf(), caps: { supportsTools: true, contextWindow: 1 } }))({ system: "S", user: "U" });
    expect(sent[0].options).not.toHaveProperty("effort");
  });

  it("collects text_delta only and stops at done", async () => {
    stream = async function* () {
      yield { type: "reasoning_delta", content: "thinking" };
      yield { type: "text_delta", content: "BLO" };
      yield { type: "text_delta", content: "CK" };
      yield { type: "done" };
      yield { type: "text_delta", content: "never read" };
    };
    expect(await createAutoJudge(() => ({ provider: providerOf() }))({ system: "S", user: "U" })).toBe("BLOCK");
  });
});
