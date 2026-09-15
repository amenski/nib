import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runModels } from "./models-command.js";
import { CATALOG_CACHE_FILENAME } from "./catalog-update.js";

const fixture = JSON.parse(readFileSync(resolve("scripts/fixtures/models.dev.json"), "utf8"));

function fetchImplFor(body: unknown, opts: { ok?: boolean; status?: number; statusText?: string } = {}): { fetchImpl: typeof fetch; requestedUrl: () => string | undefined } {
  let requestedUrl: string | undefined;
  const fetchImpl = (async (url: string) => {
    requestedUrl = url;
    return {
      ok: opts.ok ?? true,
      status: opts.status ?? 200,
      statusText: opts.statusText ?? "OK",
      json: async () => body,
    } as unknown as Response;
  }) as typeof fetch;
  return { fetchImpl, requestedUrl: () => requestedUrl };
}

describe("runModels", () => {
  let dir: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nib-models-command-test-"));
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const cacheFile = () => join(dir, CATALOG_CACHE_FILENAME);

  it("prints usage and exits 1 when called with no subcommand", async () => {
    const code = await runModels([], { homeDir: dir });
    expect(code).toBe(1);
    expect(errorSpy).toHaveBeenCalled();
  });

  it("prints usage and exits 1 for an unknown subcommand", async () => {
    const code = await runModels(["bogus"], { homeDir: dir });
    expect(code).toBe(1);
    expect(errorSpy).toHaveBeenCalled();
  });

  describe("status", () => {
    it("reports the bundled snapshot when there is no cached update", async () => {
      const code = await runModels(["status"], { homeDir: dir });
      expect(code).toBe(0);
      const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join("\n");
      expect(output).toContain("snapshot: bundled");
      expect(output).toContain("providers: 5");
    });

    it("reports an updated (cached) snapshot once one exists", async () => {
      const { fetchImpl } = fetchImplFor(fixture);
      // Change one value so the diff is non-empty and the update actually writes.
      const mutated = JSON.parse(JSON.stringify(fixture));
      mutated.providers.deepseek.models["deepseek-v4-pro"].cost.input = 0.99;
      const { fetchImpl: mutatedFetch } = fetchImplFor(mutated);
      await runModels(["update", "--yes"], { homeDir: dir, fetchImpl: mutatedFetch, now: new Date("2026-01-02") });

      const code = await runModels(["status"], { homeDir: dir });
      expect(code).toBe(0);
      const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join("\n");
      expect(output).toContain("snapshot: updated (cached)");
      expect(output).toContain("models.dev:2026-01-02");
    });

    it("rejects extra arguments", async () => {
      const code = await runModels(["status", "extra"], { homeDir: dir });
      expect(code).toBe(1);
    });
  });

  describe("update", () => {
    it("fails cleanly on a fetch error, writing no cache file", async () => {
      const fetchImpl = (async () => { throw new Error("network unreachable"); }) as unknown as typeof fetch;
      const code = await runModels(["update", "--yes"], { homeDir: dir, fetchImpl });
      expect(code).toBe(1);
      expect(errorSpy).toHaveBeenCalled();
      expect(existsSync(cacheFile())).toBe(false);
    });

    it("fails cleanly on invalid feed data (non-object root), writing no cache file", async () => {
      // A missing-every-provider feed is no longer instant-fatal — runUpdate
      // generates in lenient mode and would just carry every provider forward
      // from the active snapshot (see the carry-forward test below). A
      // non-object root is still fatal in both modes: generateCatalogReport
      // never even reaches the per-provider loop.
      const { fetchImpl } = fetchImplFor("not an object");
      const code = await runModels(["update", "--yes"], { homeDir: dir, fetchImpl });
      expect(code).toBe(1);
      expect(errorSpy).toHaveBeenCalled();
      expect(existsSync(cacheFile())).toBe(false);
    });

    it("still fails when a provider present in the feed is missing its configured default model", async () => {
      const mutated = JSON.parse(JSON.stringify(fixture));
      delete mutated.providers.deepseek.models["deepseek-v4-pro"]; // the configured default
      const { fetchImpl } = fetchImplFor(mutated);
      const code = await runModels(["update", "--yes"], { homeDir: dir, fetchImpl });
      expect(code).toBe(1);
      expect(errorSpy).toHaveBeenCalled();
      expect(existsSync(cacheFile())).toBe(false);
    });

    it("carries a provider absent from the feed forward from the active snapshot, not as a diffed removal", async () => {
      const mutated = JSON.parse(JSON.stringify(fixture));
      delete mutated.providers.ollama; // like the real Models.dev feed: no ollama entry at all
      mutated.providers.deepseek.models["deepseek-v4-pro"].cost.input = 0.99; // force a real, non-empty diff
      const { fetchImpl } = fetchImplFor(mutated);
      const code = await runModels(["update", "--yes"], { homeDir: dir, fetchImpl, now: new Date("2026-01-02") });
      expect(code).toBe(0);
      const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join("\n");
      // Not a silent drop — reported, but not as a diff removal.
      expect(output).not.toContain("Removed:");
      expect(output).toContain("not refreshed — absent from the feed: ollama");
      expect(existsSync(cacheFile())).toBe(true);
      const written = JSON.parse(readFileSync(cacheFile(), "utf-8"));
      // Carried forward verbatim from the bundled active snapshot.
      expect(written.providers.ollama.models["llama3.2"]).toBeDefined();
    });

    it("carries a provider present in the feed but with an empty models object forward, reported distinctly from an absent one", async () => {
      const mutated = JSON.parse(JSON.stringify(fixture));
      mutated.providers.ollama.models = {}; // present, but upstream gave nothing usable
      mutated.providers.deepseek.models["deepseek-v4-pro"].cost.input = 0.99; // force a real, non-empty diff
      const { fetchImpl } = fetchImplFor(mutated);
      const code = await runModels(["update", "--yes"], { homeDir: dir, fetchImpl, now: new Date("2026-01-02") });
      expect(code).toBe(0);
      const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join("\n");
      expect(output).not.toContain("Removed:");
      expect(output).toContain("not refreshed — feed listed no models: ollama");
      expect(output).not.toContain("not refreshed — absent from the feed");
      expect(existsSync(cacheFile())).toBe(true);
      const written = JSON.parse(readFileSync(cacheFile(), "utf-8"));
      expect(written.providers.ollama.models["llama3.2"]).toBeDefined();
    });

    it("reports a skipped-models count in the pre-confirmation output", async () => {
      const mutated = JSON.parse(JSON.stringify(fixture));
      // No limit.context at all — like the live feed's image/audio models.
      mutated.providers.openai.models["gpt-image-1"] = { name: "GPT Image 1", tool_call: false };
      const { fetchImpl } = fetchImplFor(mutated);
      const code = await runModels(["update", "--yes"], { homeDir: dir, fetchImpl });
      expect(code).toBe(0);
      const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join("\n");
      expect(output).toContain("skipped 1 models with no usable context limit (image/audio)");
      // The skipped model never entered the catalog, so the rest is unchanged
      // and there's nothing to write.
      expect(existsSync(cacheFile())).toBe(false);
    });

    it("reports no differences and writes nothing when the feed matches the active catalog", async () => {
      const { fetchImpl } = fetchImplFor(fixture);
      const code = await runModels(["update", "--yes"], { homeDir: dir, fetchImpl });
      expect(code).toBe(0);
      const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join("\n");
      expect(output).toContain("catalog is already up to date");
      expect(existsSync(cacheFile())).toBe(false);
    });

    it("refuses to write when not a TTY and --yes is not given", async () => {
      const mutated = JSON.parse(JSON.stringify(fixture));
      mutated.providers.deepseek.models["deepseek-v4-pro"].cost.input = 0.99;
      const { fetchImpl } = fetchImplFor(mutated);
      const code = await runModels(["update"], { homeDir: dir, fetchImpl, isTTY: false });
      expect(code).toBe(1);
      expect(errorSpy).toHaveBeenCalled();
      expect(existsSync(cacheFile())).toBe(false);
    });

    it("--yes skips the prompt and writes the cache atomically", async () => {
      const mutated = JSON.parse(JSON.stringify(fixture));
      mutated.providers.deepseek.models["deepseek-v4-pro"].cost.input = 0.99;
      const { fetchImpl } = fetchImplFor(mutated);
      const code = await runModels(["update", "--yes"], { homeDir: dir, fetchImpl, now: new Date("2026-01-02") });
      expect(code).toBe(0);
      expect(existsSync(cacheFile())).toBe(true);
      const written = JSON.parse(readFileSync(cacheFile(), "utf-8"));
      expect(written.source.revision).toBe("models.dev:2026-01-02");
      expect(written.providers.deepseek.models["deepseek-v4-pro"].pricing.inputPerM).toBe(0.99);
    });

    it("on a TTY, prompts and writes when the injected confirm resolves true", async () => {
      const mutated = JSON.parse(JSON.stringify(fixture));
      mutated.providers.deepseek.models["deepseek-v4-pro"].cost.input = 0.99;
      const { fetchImpl } = fetchImplFor(mutated);
      const confirm = vi.fn().mockResolvedValue(true);
      const code = await runModels(["update"], { homeDir: dir, fetchImpl, isTTY: true, confirm });
      expect(code).toBe(0);
      expect(confirm).toHaveBeenCalled();
      expect(existsSync(cacheFile())).toBe(true);
    });

    it("on a TTY, declines and writes nothing when the injected confirm resolves false", async () => {
      const mutated = JSON.parse(JSON.stringify(fixture));
      mutated.providers.deepseek.models["deepseek-v4-pro"].cost.input = 0.99;
      const { fetchImpl } = fetchImplFor(mutated);
      const confirm = vi.fn().mockResolvedValue(false);
      const code = await runModels(["update"], { homeDir: dir, fetchImpl, isTTY: true, confirm });
      expect(code).toBe(0);
      expect(existsSync(cacheFile())).toBe(false);
    });

    it("passes an explicit --url through to the fetch", async () => {
      const { fetchImpl, requestedUrl } = fetchImplFor(fixture);
      await runModels(["update", "--url", "https://example.com/feed.json", "--yes"], { homeDir: dir, fetchImpl });
      expect(requestedUrl()).toBe("https://example.com/feed.json");
    });

    it("rejects an unknown flag", async () => {
      const code = await runModels(["update", "--bogus"], { homeDir: dir });
      expect(code).toBe(1);
      expect(errorSpy).toHaveBeenCalled();
    });

    it("rejects a trailing --url with no value, without making any request", async () => {
      const { fetchImpl } = fetchImplFor(fixture);
      const fetchSpy = vi.fn(fetchImpl);
      const code = await runModels(["update", "--url"], { homeDir: dir, fetchImpl: fetchSpy });
      expect(code).toBe(1);
      expect(errorSpy).toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(existsSync(cacheFile())).toBe(false);
    });

    it("rejects an empty --url=, without making any request", async () => {
      const { fetchImpl } = fetchImplFor(fixture);
      const fetchSpy = vi.fn(fetchImpl);
      const code = await runModels(["update", "--url=", "--yes"], { homeDir: dir, fetchImpl: fetchSpy });
      expect(code).toBe(1);
      expect(errorSpy).toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(existsSync(cacheFile())).toBe(false);
    });
  });
});
