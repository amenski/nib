import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * One resolver, one order: explicit key, then the provider's env var, then the
 * key `nib auth` stored. createProvider, the model picker and `nib doctor` all
 * go through it, so this is the only place the order is asserted.
 */
describe("provider key resolution", () => {
  let home: string;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "nib-resolve-key-"));
    saved.NIB_HOME = process.env.NIB_HOME;
    process.env.NIB_HOME = home;
    for (const k of Object.keys(process.env)) {
      if (k.endsWith("_API_KEY")) {
        saved[k] = process.env[k];
        delete process.env[k];
      }
    }
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  const storeKey = (line: string) => writeFileSync(join(home, "credentials.yaml"), `${line}\n`, { mode: 0o600 });

  it("prefers an explicit key over the env var over the stored key", async () => {
    const { resolveProviderKey } = await import("../config/credentials.js");
    storeKey("deepseek: from-file");
    process.env.DEEPSEEK_API_KEY = "from-env";
    expect(resolveProviderKey("deepseek", "DEEPSEEK_API_KEY", "from-options")).toEqual({ key: "from-options", source: "options" });
    expect(resolveProviderKey("deepseek", "DEEPSEEK_API_KEY")).toEqual({ key: "from-env", source: "env" });
    delete process.env.DEEPSEEK_API_KEY;
    expect(resolveProviderKey("deepseek", "DEEPSEEK_API_KEY")).toEqual({ key: "from-file", source: "credentials" });
  });

  it("reports none when nothing is set, and ignores a key stored for another provider", async () => {
    const { resolveProviderKey } = await import("../config/credentials.js");
    storeKey("openrouter: other-provider");
    expect(resolveProviderKey("deepseek", "DEEPSEEK_API_KEY")).toEqual({ key: "", source: "none" });
  });

  it("skips the env lookup for a provider that names no env var", async () => {
    const { resolveProviderKey } = await import("../config/credentials.js");
    process.env.DEEPSEEK_API_KEY = "must-not-leak";
    storeKey("ollama: stored");
    expect(resolveProviderKey("ollama", undefined)).toEqual({ key: "stored", source: "credentials" });
  });

  it("createProvider uses the same order, and its error names the env var", async () => {
    const { createProvider } = await import("./presets.js");
    expect(() => createProvider("deepseek")).toThrow(/DEEPSEEK_API_KEY/);
    storeKey("deepseek: from-file");
    expect(() => createProvider("deepseek")).not.toThrow();
    expect(() => createProvider("deepseek", { apiKey: "explicit" })).not.toThrow();
  });

  it("getKeySources lists env vars and stored providers by name, env first", async () => {
    const { getKeySources, getConfiguredProviders } = await import("./presets.js");
    storeKey("deepseek: from-file\nopenrouter: from-file");
    process.env.DEEPSEEK_API_KEY = "from-env";
    const sources = getKeySources();
    expect(sources.env).toContain("DEEPSEEK_API_KEY");
    // A provider with both is reported once, under env.
    expect(sources.credentials).not.toContain("deepseek");
    expect(sources.credentials).toContain("openrouter");
    expect(JSON.stringify(sources)).not.toContain("from-file");
    expect(JSON.stringify(sources)).not.toContain("from-env");
    expect(getConfiguredProviders().deepseek).toBe(true);
    expect(getConfiguredProviders().openrouter).toBe(true);
  });
});
