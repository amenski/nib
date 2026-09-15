import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderPreset } from "./presets.js";
import type { Provider } from "./types.js";

const FAKE_HOME = mkdtempSync(join(tmpdir(), "heirloom-presets-test-"));

vi.mock("node:os", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:os")>();
  return { ...original, homedir: () => FAKE_HOME };
});

const { aisdkMock } = vi.hoisted(() => {
  const fn = vi.fn<(preset: ProviderPreset, model: string, apiKey: string) => Provider>(() => ({} as never));
  return { aisdkMock: fn };
});

vi.mock("./aisdk.js", () => ({
  createAISDKProvider: aisdkMock,
}));

describe("createProvider key resolution", () => {
  const ENV_KEY = "DEEPSEEK_API_KEY";
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env[ENV_KEY];
    delete process.env[ENV_KEY];
    mkdirSync(join(FAKE_HOME, ".nib"), { recursive: true });
    vi.resetModules();
    aisdkMock.mockClear();
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = originalEnv;
    rmSync(join(FAKE_HOME, ".nib"), { recursive: true, force: true });
  });

  it("reads credentials.yaml when the env var is unset", async () => {
    writeFileSync(join(FAKE_HOME, ".nib", "credentials.yaml"), "deepseek: sk-test-dummy\n");

    const { createProvider } = await import("./presets.js");
    createProvider("deepseek");

    expect(aisdkMock).toHaveBeenCalledTimes(1);
    expect(aisdkMock.mock.calls[0][2]).toBe("sk-test-dummy");
  });

  it("prefers the env var over credentials.yaml when both are set", async () => {
    process.env[ENV_KEY] = "sk-env-dummy";
    writeFileSync(join(FAKE_HOME, ".nib", "credentials.yaml"), "deepseek: sk-test-dummy\n");

    const { createProvider } = await import("./presets.js");
    createProvider("deepseek");

    expect(aisdkMock).toHaveBeenCalledTimes(1);
    expect(aisdkMock.mock.calls[0][2]).toBe("sk-env-dummy");
  });

  it("throws a helpful error when neither env var nor credentials.yaml has the key", async () => {
    const { createProvider } = await import("./presets.js");
    expect(() => createProvider("deepseek")).toThrow(/DEEPSEEK_API_KEY/);
  });

  it("creates a deepseek provider for the deepseek-v4-pro model via modelOverride", async () => {
    process.env[ENV_KEY] = "sk-env-dummy";

    const { createProvider } = await import("./presets.js");
    createProvider("deepseek", { modelOverride: "deepseek-v4-pro" });

    expect(aisdkMock).toHaveBeenCalledTimes(1);
    const model = aisdkMock.mock.calls[0]?.[1];
    expect(model).toBe("deepseek-v4-pro");
  });

  it("honors an options.baseUrl override for a built-in preset (B2)", async () => {
    process.env[ENV_KEY] = "sk-env-dummy";

    const { createProvider } = await import("./presets.js");
    createProvider("deepseek", { baseUrl: "http://127.0.0.1:9" });

    expect(aisdkMock).toHaveBeenCalledTimes(1);
    const preset = aisdkMock.mock.calls[0]?.[0];
    expect(preset.baseUrl).toBe("http://127.0.0.1:9");
  });

  it("falls back to the preset baseUrl when no override is given", async () => {
    process.env[ENV_KEY] = "sk-env-dummy";

    const { createProvider } = await import("./presets.js");
    createProvider("deepseek");

    expect(aisdkMock).toHaveBeenCalledTimes(1);
    const preset = aisdkMock.mock.calls[0]?.[0];
    expect(preset.baseUrl).toBe("https://api.deepseek.com");
  });

  // C1 security regression: cli.tsx's getProvider() only forwards the startup
  // env.API_KEY/env.BASE_URL when switching to the SAME provider that was
  // active at startup; for any other provider it passes apiKey/baseUrl as
  // undefined so createProvider falls through to that provider's own
  // keyEnv/getCredential resolution instead of reusing a key scoped to a
  // different provider/host.
  it("does not reuse a differently-scoped key when apiKey is omitted (switching away from the startup provider)", async () => {
    // Simulates: startup provider was deepseek (holding DEEPSEEK_API_KEY via
    // options.apiKey), user runs /model openai/..., cli.tsx now calls
    // createProvider("openai", { apiKey: undefined, baseUrl: undefined }).
    process.env.OPENAI_API_KEY = "sk-openai-real";

    const { createProvider } = await import("./presets.js");
    createProvider("openai", { apiKey: undefined, baseUrl: undefined });

    expect(aisdkMock).toHaveBeenCalledTimes(1);
    const [preset, , apiKey] = aisdkMock.mock.calls[0];
    // Must resolve OpenAI's own key from OPENAI_API_KEY, never the startup
    // provider's key, and must use OpenAI's own preset baseUrl, never a
    // startup env.BASE_URL pinned to the previous provider's host.
    expect(apiKey).toBe("sk-openai-real");
    expect(preset.baseUrl).toBe("https://api.openai.com/v1");

    delete process.env.OPENAI_API_KEY;
  });

  it("would leak a stale key if apiKey were forwarded across providers (documents the bug C1 fixes)", async () => {
    // Negative control: if cli.tsx forwarded the startup provider's resolved
    // key/baseUrl unconditionally (the pre-fix behavior), createProvider has
    // no way to detect the mismatch — options.apiKey/baseUrl are the highest
    // priority source. This asserts that passing a key explicitly always wins,
    // which is exactly why getProvider() must not do so for a non-startup
    // provider.
    const { createProvider } = await import("./presets.js");
    createProvider("openai", { apiKey: "sk-deepseek-leaked", baseUrl: "https://api.deepseek.com" });

    expect(aisdkMock).toHaveBeenCalledTimes(1);
    const [preset, , apiKey] = aisdkMock.mock.calls[0];
    expect(apiKey).toBe("sk-deepseek-leaked");
    expect(preset.baseUrl).toBe("https://api.deepseek.com");
  });
});

describe("BUILTIN_PRESETS models map", () => {
  it("deepseek preset carries both v4 models with correct capabilities", async () => {
    const { BUILTIN_PRESETS } = await import("./presets.js");
    expect(BUILTIN_PRESETS.deepseek_reasoner).toBeUndefined();
    expect(BUILTIN_PRESETS.deepseek.models["deepseek-v4-flash"]).toMatchObject({
      supportsTools: true,
      contextWindow: 1000000,
      pricing: { inputPerM: 0.14, outputPerM: 0.28 },
    });
    expect(BUILTIN_PRESETS.deepseek.models["deepseek-v4-pro"]).toMatchObject({
      supportsTools: true,
      contextWindow: 1000000,
      pricing: { inputPerM: 0.435, outputPerM: 0.87 },
    });
  });

  it("getContextWindowForModel resolves deepseek models from the preset", async () => {
    const { getContextWindowForModel } = await import("./presets.js");
    expect(getContextWindowForModel("deepseek", "deepseek-v4-flash", -1)).toBe(1000000);
    expect(getContextWindowForModel("deepseek", "deepseek-v4-pro", -1)).toBe(1000000);
  });

  it("getContextWindowForModel falls back for an unknown provider", async () => {
    const { getContextWindowForModel } = await import("./presets.js");
    expect(getContextWindowForModel("nonexistent", "whatever", 42)).toBe(42);
  });
});

describe("getProviderCapabilities per model", () => {
  it("resolves supportsTools per model instead of per provider", async () => {
    const { getProviderCapabilities } = await import("./registry.js");
    expect(getProviderCapabilities("deepseek", "deepseek-v4-flash").supportsTools).toBe(true);
    expect(getProviderCapabilities("deepseek", "deepseek-v4-pro").supportsTools).toBe(true);
  });

  it("falls back to the provider's default model when no model is given", async () => {
    const { getProviderCapabilities } = await import("./registry.js");
    const def = getProviderCapabilities("deepseek");
    expect(def.supportsTools).toBe(true);
    expect(def.contextWindow).toBe(1000000);
    expect(def.pricing).toBeDefined();
  });
});

describe("imageSupportWarning", () => {
  it("is silent when the model is declared vision-capable", async () => {
    const { imageSupportWarning } = await import("./registry.js");
    expect(imageSupportWarning("deepseek", "deepseek-v4-flash-vision-exp", 1)).toBeUndefined();
  });

  it("is silent when no images are being sent", async () => {
    const { imageSupportWarning } = await import("./registry.js");
    expect(imageSupportWarning("deepseek", "deepseek-chat", 0)).toBeUndefined();
  });

  it("warns when the model is declared text-only", async () => {
    const { imageSupportWarning } = await import("./registry.js");
    const warning = imageSupportWarning("deepseek", "deepseek-chat", 1);
    expect(warning).toMatch(/does not accept image input/);
  });

  it("warns (differently) when the model's vision capability is undeclared", async () => {
    const { imageSupportWarning } = await import("./registry.js");
    const warning = imageSupportWarning("ollama", "llama3.2", 2);
    expect(warning).toMatch(/not declared as accepting image input/);
    expect(warning).toContain("images");
  });

  it("warns for an unknown provider rather than assuming capability", async () => {
    const { imageSupportWarning } = await import("./registry.js");
    expect(imageSupportWarning("nonexistent", "whatever", 1)).toMatch(/not declared as accepting image input/);
  });
});
