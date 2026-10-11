import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Provider } from "./types.js";

/**
 * A private, empty NIB_HOME per test so the error-rewrite path's synchronous
 * readCachedModels() never sees the developer's real ~/.nib/provider-models.json.
 */
let tmpHome: string;
let previousHome: string | undefined;
beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "nib-live-models-"));
  previousHome = process.env.NIB_HOME;
  process.env.NIB_HOME = tmpHome;
});
afterEach(() => {
  if (previousHome === undefined) delete process.env.NIB_HOME;
  else process.env.NIB_HOME = previousHome;
  rmSync(tmpHome, { recursive: true, force: true });
});

/**
 * The fake fullStream the mocked `streamText` hands back. The generator reads
 * `streamEvents` when it is iterated, so a test sets it right before draining.
 */
let streamEvents: unknown[] = [];
vi.mock("ai", () => ({
  streamText: () => ({
    fullStream: (async function* () {
      for (const event of streamEvents) {
        // An Error entry models the iterator itself throwing (a network
        // failure), which never produces an `error` event part.
        if (event instanceof Error) throw event;
        yield event;
      }
    })(),
  }),
  tool: (def: unknown) => def,
  jsonSchema: (schema: unknown) => schema,
  stepCountIs: () => () => false,
}));

/**
 * A deepseek-like preset whose catalog lists BOTH the requested flash id and
 * the renamed one — the guard only fires for a served id the catalog knows.
 */
const PRESET = {
  api: "openai-compatible",
  baseUrl: "https://api.deepseek.com",
  keyEnv: "TEST_KEY",
  defaultModel: "deepseek-v4-flash",
  models: {
    "deepseek-v4-flash": { supportsTools: true, contextWindow: 1 },
    "deepseek-flash": { supportsTools: true, contextWindow: 1 },
    "deepseek-v4-pro": { supportsTools: true, contextWindow: 1 },
  },
};

const MODEL = "deepseek-v4-flash";

/** Fresh module (and therefore a fresh alias-dedup Set) for one test. */
async function loadFactory(): Promise<typeof import("./aisdk.js")["createAISDKProvider"]> {
  vi.resetModules();
  const mod = await import("./aisdk.js");
  return mod.createAISDKProvider;
}

/** Drain one streamChat over the given fake events, collecting yields. */
async function drain(
  provider: Provider,
  events: unknown[],
): Promise<{ yielded: any[]; error: unknown }> {
  streamEvents = events;
  const yielded: any[] = [];
  let error: unknown;
  try {
    for await (const event of provider.streamChat([{ role: "user", content: "hi" }], [])) {
      yielded.push(event);
    }
  } catch (err) {
    error = err;
  }
  return { yielded, error };
}

function finishEvents(servedModelId: string): unknown[] {
  return [
    { type: "finish-step", usage: { inputTokens: 1, outputTokens: 1 }, response: { modelId: servedModelId } },
    { type: "finish", finishReason: "stop" },
  ];
}

const aliasOf = (yielded: any[]) => yielded.filter((e) => e.type === "model_alias");

describe("model_alias notice", () => {
  it("emits exactly one notice when the provider serves a different, catalog-known model, and none on a later turn", async () => {
    const make = await loadFactory();
    const first = make(PRESET as never, MODEL, "sk", "deepseek");
    const a = await drain(first, finishEvents("deepseek-flash"));

    expect(aliasOf(a.yielded)).toEqual([
      { type: "model_alias", provider: "deepseek", requested: MODEL, served: "deepseek-flash" },
    ]);
    // The existing usage yield still happens alongside the notice.
    expect(a.yielded.some((e) => e.type === "usage")).toBe(true);

    // A second turn in the same process — a fresh provider instance and a fresh
    // stream — must not reprint the same provider|requested|served triple.
    const second = make(PRESET as never, MODEL, "sk", "deepseek");
    const b = await drain(second, finishEvents("deepseek-flash"));
    expect(aliasOf(b.yielded)).toEqual([]);
  });

  it("stays silent when the served modelId equals the requested one", async () => {
    const make = await loadFactory();
    const provider = make(PRESET as never, MODEL, "sk", "deepseek");
    const { yielded } = await drain(provider, finishEvents(MODEL));
    expect(aliasOf(yielded)).toEqual([]);
  });

  it("stays silent when the served modelId is not in the provider's catalog (a dated/versioned id)", async () => {
    const make = await loadFactory();
    const provider = make(PRESET as never, MODEL, "sk", "deepseek");
    const { yielded } = await drain(provider, finishEvents("deepseek-v4-flash-0731"));
    expect(aliasOf(yielded)).toEqual([]);
  });

  it("stays silent for a config-defined provider whose preset lists no models", async () => {
    const make = await loadFactory();
    const empty = { ...PRESET, models: {} };
    const provider = make(empty as never, MODEL, "sk", "myconfig");
    const { yielded } = await drain(provider, finishEvents("some-other-model"));
    expect(aliasOf(yielded)).toEqual([]);
  });
});

describe("model-not-available error", () => {
  it("rewrites a 404 model-not-found rejection into the clear message", async () => {
    const make = await loadFactory();
    const provider = make(PRESET as never, MODEL, "sk", "deepseek");
    const { error } = await drain(provider, [
      { type: "error", error: { statusCode: 404, responseBody: '{"error":{"message":"model_not_found"}}' } },
    ]);
    expect((error as Error).message).toBe(`Model "${MODEL}" is not available from deepseek.`);
  });

  it("recognizes a wrapped error through its cause chain", async () => {
    const make = await loadFactory();
    const provider = make(PRESET as never, MODEL, "sk", "deepseek");
    const wrapped = new Error("request failed") as Error & { cause?: unknown };
    wrapped.cause = { statusCode: 400, responseBody: "The model does not exist" };
    const { error } = await drain(provider, [{ type: "error", error: wrapped }]);
    expect((error as Error).message).toBe(`Model "${MODEL}" is not available from deepseek.`);
  });

  it("passes an unrelated error through unchanged", async () => {
    const make = await loadFactory();
    const provider = make(PRESET as never, MODEL, "sk", "deepseek");
    const boom = new Error("upstream timeout");
    const { error } = await drain(provider, [{ type: "error", error: boom }]);
    expect(error).toBe(boom);
  });

  it("does NOT rewrite a 400 about context length that never names the model", async () => {
    const make = await loadFactory();
    const provider = make(PRESET as never, MODEL, "sk", "deepseek");
    const boom = {
      statusCode: 400,
      responseBody: '{"error":{"message":"This model\'s maximum context length is 65536 tokens. However, your messages resulted in 70000 tokens."}}',
    };
    const { error } = await drain(provider, [{ type: "error", error: boom }]);
    // Same instance, not a rewritten Error.
    expect(error).toBe(boom);
  });

  it("appends the cached live list when the provider last reported one", async () => {
    writeFileSync(
      join(tmpHome, "provider-models.json"),
      JSON.stringify({
        deepseek: { fetchedAt: Date.now(), models: ["deepseek-flash", "deepseek-v4-pro"] },
      }),
    );
    const make = await loadFactory();
    const provider = make(PRESET as never, MODEL, "sk", "deepseek");
    const { error } = await drain(provider, [
      { type: "error", error: { statusCode: 404, responseBody: '{"error":{"message":"model_not_found"}}' } },
    ]);
    expect((error as Error).message).toBe(
      `Model "${MODEL}" is not available from deepseek. Available: deepseek-flash, deepseek-v4-pro (/model).`,
    );
  });
});
