import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// handleSlashCore is exported from cli.tsx specifically so its /model case
// (persist + validate + roll back) is unit-testable. Importing cli.tsx does
// NOT run the real CLI startup: main() is guarded to only auto-run when this
// module is the process entrypoint, which is false under vitest.
import { handleSlashCore, applyModeDefaults } from "./cli.js";
import { resolveRestoredSelection } from "./modes/model-policy.js";

// The successful-switch case runs recordRecentModel, which writes
// recentModels into the *state dir's* settings.json — resolveHome() with no
// override. Without this, the test records a real recent-models entry into
// ~/.nib/settings.json on every run.
let homeDir: string;

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), "nib-model-cmd-"));
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

describe("mode model defaults", () => {
  function shared() {
    return {
      providerName: "deepseek",
      activeModel: undefined as string | undefined,
      activeEffort: undefined as string | undefined,
      modelExplicit: false,
      effortExplicit: false,
      providerExplicit: false,
      sessionInput: 0,
      sessionOutput: 0,
    };
  }

  const general = { slug: "general", name: "General", roleDefinition: "", model: "deepseek/deepseek-flash", reasoningEffort: "low" };
  const code = { slug: "code", name: "Code", roleDefinition: "", model: "deepseek/deepseek-flash" };
  const plain = { slug: "ask", name: "Ask", roleDefinition: "" };

  async function runSlash(input: string, state: any, sessionStore: any, modeLoader: any) {
    await handleSlashCore(
      input, vi.fn(() => ({}) as any),
      {}, modeLoader, {} as any, sessionStore,
      "sess-1", {} as any, {} as any, undefined,
      () => ({}) as any, {} as any, [], {} as any,
      state, () => undefined,
      () => null, false, undefined,
      vi.fn(),
    );
  }

  it("seeds General's Flash/low defaults for a new session", () => {
    const state = shared();
    applyModeDefaults(state, general);
    expect(state).toMatchObject({ activeModel: "deepseek-flash", activeEffort: "low" });
  });

  it("seeds Code's Flash model but leaves the model's own effort for a session starting in Code", () => {
    const state = { ...shared(), activeEffort: "high" };
    applyModeDefaults(state, code);
    expect(state).toMatchObject({ providerName: "deepseek", activeModel: "deepseek-flash", activeEffort: "high" });
  });

  it("changes nothing for a mode with neither a model nor a reasoningEffort", () => {
    const state = { ...shared(), activeEffort: "high" };
    applyModeDefaults(state, plain);
    expect(state).toEqual({ ...shared(), activeEffort: "high" });
  });

  it("applies a non-general mode's reasoningEffort when the model supports effort", () => {
    const state = shared();
    applyModeDefaults(state, { ...code, reasoningEffort: "medium" });
    expect(state).toMatchObject({ activeModel: "deepseek-flash", activeEffort: "medium" });
  });

  it("keeps an explicit model over Code's default", () => {
    const state = { ...shared(), activeModel: "deepseek-v4-pro", modelExplicit: true };
    applyModeDefaults(state, code);
    expect(state.activeModel).toBe("deepseek-v4-pro");
  });

  it("ignores Code's model when an explicit provider differs", () => {
    const state = { ...shared(), providerName: "openai", activeModel: "gpt-5.6-sol", providerExplicit: true };
    applyModeDefaults(state, code);
    expect(state).toMatchObject({ providerName: "openai", activeModel: "gpt-5.6-sol" });
  });

  it("keeps the model and effort when /mode switches from General to Code", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const state = shared();
    applyModeDefaults(state, general);
    const sessionStore = { appendState: vi.fn().mockResolvedValue(undefined) };
    const modeLoader = { load: vi.fn().mockResolvedValue(code) };

    await runSlash("/mode code", state, sessionStore, modeLoader);

    expect((state as any).activeMode).toBe(code);
    expect(state).toMatchObject({ providerName: "deepseek", activeModel: "deepseek-flash", activeEffort: "low" });
    expect(sessionStore.appendState).toHaveBeenCalledWith("sess-1", { mode: "code" });
    vi.restoreAllMocks();
  });

  it("keeps a /model choice when /mode switches back to General", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const state = { ...shared(), activeModel: "deepseek-v4-pro", modelExplicit: true };
    const sessionStore = { appendState: vi.fn().mockResolvedValue(undefined) };
    const modeLoader = { load: vi.fn().mockResolvedValue(general) };

    await runSlash("/mode general", state, sessionStore, modeLoader);

    expect(state.activeModel).toBe("deepseek-v4-pro");
    vi.restoreAllMocks();
  });

  it("restores a resumed session's selection, mode default included", () => {
    expect(resolveRestoredSelection("deepseek-flash")).toEqual({ value: "deepseek-flash", explicit: true });
    expect(resolveRestoredSelection(undefined)).toEqual({ value: undefined, explicit: false });

    // Resumed in General with a model from a /model switch: not re-seeded.
    const restored = resolveRestoredSelection("deepseek-v4-pro");
    const state = { ...shared(), activeModel: restored.value, modelExplicit: restored.explicit };
    applyModeDefaults(state, general);
    expect(state.activeModel).toBe("deepseek-v4-pro");
  });
});
