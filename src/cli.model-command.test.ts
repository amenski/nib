import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// handleSlashCore is exported from cli.tsx specifically so its /model case
// (persist + validate + roll back) is unit-testable. Importing cli.tsx does
// NOT run the real CLI startup: main() is guarded to only auto-run when this
// module is the process entrypoint, which is false under vitest.
import { handleSlashCore, syncModeModel } from "./cli.js";
import { resolveRestoredSelection } from "./modes/model-policy.js";

// The successful-switch case runs recordRecentModel, which writes
// recentModels into the *state dir's* settings.json — resolveHome() with no
// override. Without this, the test records a real recent-models entry into
// ~/.nib/settings.json on every run.
let homeDir: string;

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), "heirloom-model-cmd-"));
  process.env.NIB_HOME = homeDir;
});

afterEach(() => {
  delete process.env.NIB_HOME;
  rmSync(homeDir, { recursive: true, force: true });
});

function makeShared(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    providerName: "deepseek",
    activeModel: "deepseek-v4-pro",
    sessionInput: 0,
    sessionOutput: 0,
    ...overrides,
  };
}

describe("/model command (C2: persist + validate + roll back)", () => {
  let sessionStore: { appendState: ReturnType<typeof vi.fn> };
  let resetCompactor: ReturnType<typeof vi.fn<() => void>>;
  let getCompactor: () => any;

  beforeEach(() => {
    sessionStore = { appendState: vi.fn().mockResolvedValue(undefined) };
    resetCompactor = vi.fn<() => void>();
    getCompactor = () => ({}) as any;
  });

  it("on a successful switch, persists provider/model via appendState and resets the compactor", async () => {
    const shared = makeShared();
    const getProvider = vi.fn(() => ({}) as any);

    await handleSlashCore(
      "/model openai/gpt-5.6-sol", getProvider,
      {}, {} as any, {} as any, sessionStore as any,
      "sess-1", {} as any, {} as any, undefined,
      getCompactor, {} as any, [], {} as any,
      shared, () => undefined,
      () => null, false, undefined,
      resetCompactor,
    );

    expect(shared.providerName).toBe("openai");
    expect(shared.activeModel).toBe("gpt-5.6-sol");
    expect(sessionStore.appendState).toHaveBeenCalledWith("sess-1", { provider: "openai", model: "gpt-5.6-sol", modelExplicit: true });
    expect(resetCompactor).toHaveBeenCalledTimes(1);
  });

  it("on a failing switch, rolls back shared.providerName/activeModel and does not persist", async () => {
    const shared = makeShared({ providerName: "deepseek", activeModel: "deepseek-v4-pro" });
    const getProvider = vi.fn(() => {
      throw new Error('Provider "nope" requires NOPE_API_KEY to be set');
    });

    await handleSlashCore(
      "/model nope/some-model", getProvider,
      {}, {} as any, {} as any, sessionStore as any,
      "sess-1", {} as any, {} as any, undefined,
      getCompactor, {} as any, [], {} as any,
      shared, () => undefined,
      () => null, false, undefined,
      resetCompactor,
    );

    expect(shared.providerName).toBe("deepseek");
    expect(shared.activeModel).toBe("deepseek-v4-pro");
    expect(sessionStore.appendState).not.toHaveBeenCalled();
    expect(resetCompactor).not.toHaveBeenCalled();
  });
});

describe("mode model defaults on resume", () => {
  function shared() {
    return {
      providerName: "deepseek",
      activeModel: undefined as string | undefined,
      activeEffort: undefined as string | undefined,
      modelExplicit: false,
      effortExplicit: false,
      providerExplicit: false,
      baselineProviderName: "deepseek",
      baselineModel: undefined as string | undefined,
      baselineEffort: undefined as string | undefined,
    };
  }

  it("recomputes General's Flash/low defaults for a known mode-derived resume", () => {
    const restored = resolveRestoredSelection("deepseek-v4-flash", false);
    expect(restored).toEqual({ value: undefined, explicit: false });

    const state = shared();
    syncModeModel(state, { slug: "general", name: "General", roleDefinition: "", model: "deepseek/deepseek-v4-flash", reasoningEffort: "low" });
    expect(state).toMatchObject({ activeModel: "deepseek-v4-flash", activeEffort: "low" });
  });

  it("recomputes a specialist default when Code follows a mode-derived Flash session", () => {
    const restored = resolveRestoredSelection("deepseek-v4-flash", false);
    const state = { ...shared(), activeModel: restored.value };
    syncModeModel(state, { slug: "code", name: "Code", roleDefinition: "" });
    expect(state.activeModel).toBeUndefined();
    expect(state.activeEffort).toBe("high");
  });

  it("preserves explicit and legacy-ambiguous restored choices", () => {
    expect(resolveRestoredSelection("openai-model", true)).toEqual({ value: "openai-model", explicit: true });
    expect(resolveRestoredSelection("legacy-model", undefined)).toEqual({ value: "legacy-model", explicit: true });
  });
});
