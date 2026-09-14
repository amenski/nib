import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handleSlashCore } from "./cli.js";

// handleSlashCore is exported from cli.tsx specifically so its cases are
// unit-testable (see cli.slash-sessions.test.ts); importing cli.tsx does NOT
// run the real CLI startup under vitest.

function makeShared(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    providerName: "deepseek",
    activeModel: "deepseek-v4-pro",
    sessionInput: 1000,
    sessionOutput: 500,
    modelUsage: { "deepseek/deepseek-v4-pro": { input: 1000, output: 500, cached: 100 } },
    ...overrides,
  };
}

describe("/usage headless (handleSlashCore)", () => {
  let logs: string[];
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logs = [];
    logSpy = vi.spyOn(console, "log").mockImplementation((...args) => logs.push(args.map(String).join(" ")));
  });
  afterEach(() => logSpy.mockRestore());

  function call(input: string, getProvider: () => any, shared: Record<string, unknown> = makeShared()) {
    return handleSlashCore(
      input, getProvider,
      { config: {} }, {} as any, {} as any, {} as any,
      "sess-1", {} as any, {} as any, undefined,
      () => ({}) as any, {} as any, [], {} as any,
      shared, () => undefined,
      () => null, false, undefined,
      vi.fn(),
    );
  }

  it("prints the balance row, session totals, and per-model token rows, and resolves (exit 0)", async () => {
    const getProvider = vi.fn(() => ({
      getBalance: async () => ({ currency: "USD", total: 1.25, granted: 0.1 }),
    }));

    await expect(call("/usage", getProvider)).resolves.toBeUndefined();
    expect(logs[0]).toBe("Balance (USD): total $1.25 / granted $0.10 / remaining $1.15");
    expect(logs[1]).toBe("Session: 1.0k in / 0.5k out");
    expect(logs[2]).toBe("  deepseek/deepseek-v4-pro: 1,000 in / 500 out / 100 cached");
  });

  it("prints 'not supported' when the provider has no getBalance", async () => {
    const getProvider = vi.fn(() => ({}));
    await call("/usage", getProvider);
    expect(logs[0]).toBe("Balance: not supported for deepseek");
    expect(logs[1]).toBe("Session: 1.0k in / 0.5k out");
    expect(logs[2]).toContain("deepseek/deepseek-v4-pro");
  });

  it("prints 'not supported' when getBalance returns null (failed/unsupported query)", async () => {
    const getProvider = vi.fn(() => ({ getBalance: async () => null }));
    await call("/usage", getProvider);
    expect(logs[0]).toBe("Balance: not supported for deepseek");
  });

  it("never throws when the provider factory fails (e.g. no API key)", async () => {
    const getProvider = vi.fn(() => {
      throw new Error("Provider requires DEEPSEEK_API_KEY");
    });
    await expect(call("/usage", getProvider)).resolves.toBeUndefined();
    expect(logs[0]).toBe("Balance: not supported for deepseek");
  });

  it("prints a placeholder row when no token records exist", async () => {
    const shared = makeShared({ modelUsage: {} });
    await call("/usage", vi.fn(() => ({})), shared);
    expect(logs[2]).toBe("Tokens by model: none recorded yet this session");
  });
});

describe("/context headless (handleSlashCore)", () => {
  let logs: string[];
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logs = [];
    logSpy = vi.spyOn(console, "log").mockImplementation((...args) => logs.push(args.map(String).join(" ")));
  });
  afterEach(() => logSpy.mockRestore());

  it("distinguishes request-time context editing from model-relative compaction", async () => {
    const shared = makeShared({ conversationHistory: [] });
    await handleSlashCore(
      "/context", vi.fn(), { config: {} }, {} as any, {} as any, {} as any,
      "sess-1", {} as any, {} as any, undefined, () => ({}) as any, {} as any,
      [], {} as any, shared, () => undefined, () => null, false, undefined,
      vi.fn(), () => 0,
    );

    expect(logs).toContain("Context editing @ 100000  (clears old consumed results; keeps 3 + fresh batch)");
    expect(logs.some((line) => line.startsWith("Compaction @"))).toBe(true);
  });
});
