import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { projectDirPath, projectSettingsPath } from "./config/paths.js";
import { tmpdir } from "node:os";
import type { StreamEvent } from "./providers/types.js";
import type { ToolCall, ToolOutput, Message } from "./types.js";
import type { ExecInputStream } from "./exec-input.js";

// Verifies that headless exec mode (`-x`) runs WITH the permission engine and
// fails closed (T11). We mock the two boundaries `runExecMode` reaches out to:
//   - ./providers/presets.js — so no network call is made; the fake provider
//     scripts exactly one tool call on turn 1, then finishes on turn 2.
//   - ./tools/index.js — so we can spy on whether executeTool actually ran, and
//     avoid touching the real tool registry.
// The permission engine itself is NOT mocked: we drive real rule resolution
// (allow rule, defaultMode ask, guarded tier, destructive deny) through the
// real runAgent code path that exec-runner wires up.

const TEST_DIR = join(tmpdir(), `nib-exec-runner-${process.pid}`);
const HOME_DIR = join(TEST_DIR, "home");
const PROJECT_DIR = join(TEST_DIR, "project");

let scriptedCall: { name: string; args: Record<string, unknown> } | null = null;
let lastStreamOptions: Record<string, unknown> | undefined;
/** The message array the provider last received — how mention expansion is observed. */
let lastMessages: Message[] | undefined;
const executeToolSpy = vi.fn(async (_call: ToolCall): Promise<ToolOutput> => ({ content: "ok" }));

// The scripted "happy path" provider used by the permission tests: one tool call
// on turn 1, then finishes on turn 2. Individual tests can swap `providerFactory`
// to make createProvider throw (B1) or stream an error (B6).
function scriptedProvider() {
  return {
    name: "fake",
    async *streamChat(messages?: unknown, _tools?: unknown, options?: Record<string, unknown>): AsyncGenerator<StreamEvent> {
      lastStreamOptions = options;
      lastMessages = messages as Message[];
      if (scriptedCall) {
        const call = scriptedCall;
        scriptedCall = null;
        yield { type: "tool_call_start", id: "call-1", name: call.name };
        yield { type: "tool_call_delta", id: "call-1", arguments: JSON.stringify(call.args) };
        yield { type: "done", finishReason: "tool_calls" };
      } else {
        yield { type: "text_delta", content: "done" };
        yield { type: "done", finishReason: "stop" };
      }
    },
  };
}

// createProvider is captured (so B2 can assert the config baseUrl reaches it) and
// delegates to a swappable factory (so B1/B6 can script failures).
const createProviderSpy = vi.fn();
let providerFactory: (name: string, options?: unknown) => unknown = () => scriptedProvider();

vi.mock("./providers/presets.js", () => ({
  initPresets: () => {},
  getPreset: (name: string) => name === "deepseek" ? {
    defaultModel: "deepseek-v4-pro",
    models: {
      "deepseek-v4-flash": { effort: { values: ["low", "high", "max"], default: "high" } },
      "deepseek-v4-pro": { effort: { values: ["low", "high", "max"], default: "high" } },
    },
  } : undefined,
  createProvider: (name: string, options?: unknown) => {
    createProviderSpy(name, options);
    return providerFactory(name, options);
  },
}));

const getByModeSpy = vi.fn((_groups: unknown) => []);
vi.mock("./tools/index.js", () => ({
  executeTool: (call: ToolCall) => executeToolSpy(call),
  registry: { getAllDefs: () => [], getByMode: (groups: unknown) => getByModeSpy(groups), register: () => {} },
  setSessionId: () => {},
  setSignal: () => {},
  setTimeoutToBackground: () => {},
  setSandboxLevel: () => {},
  setWriteRoots: () => {},
  setWebSearchConfig: () => {},
}));

// The notify hook is mocked so the completion-site tests below can assert
// whether/how it fires without spawning a real script.
const fireNotifySpy = vi.fn();
vi.mock("./notify.js", () => ({
  fireNotify: (...args: unknown[]) => fireNotifySpy(...args),
}));

function nonTtyInput(): ExecInputStream {
  // isTTY:false with an empty stream => buildExecPrompt returns the prompt as-is.
  return {
    isTTY: false,
    async *[Symbol.asyncIterator]() {
      /* empty stdin */
    },
  };
}

function writeSettings(settings: Record<string, unknown>): void {
  mkdirSync(projectDirPath(PROJECT_DIR), { recursive: true });
  writeFileSync(projectSettingsPath(PROJECT_DIR), JSON.stringify(settings), "utf-8");
}

async function run(opts?: { mode?: string; model?: string; debug?: boolean; prompt?: string }): Promise<{ code: number; stderr: string }> {
  const { runExecMode } = await import("./exec-runner.js");
  const chunks: string[] = [];
  // console.error routes through process.stderr.write, so spying on write
  // captures both the exec-runner's own lines and any leaked SDK dumps.
  const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: any) => {
    chunks.push(String(chunk));
    return true;
  });
  const outSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  try {
    const code = await runExecMode({
      prompt: opts?.prompt ?? "go",
      projectRoot: PROJECT_DIR,
      input: nonTtyInput(),
      mode: opts?.mode,
      model: opts?.model,
      debug: opts?.debug,
    });
    return { code, stderr: chunks.join("") };
  } finally {
    writeSpy.mockRestore();
    outSpy.mockRestore();
  }
}

describe("runExecMode headless permission enforcement (T11)", () => {
  beforeEach(() => {
    mkdirSync(PROJECT_DIR, { recursive: true });
    mkdirSync(HOME_DIR, { recursive: true });
    // Isolate from the developer's real ~/.nib/settings.json.
    process.env.NIB_HOME = HOME_DIR;
    executeToolSpy.mockClear();
    createProviderSpy.mockClear();
    providerFactory = () => scriptedProvider();
    scriptedCall = null;
    lastStreamOptions = undefined;
    lastMessages = undefined;
  });

  afterEach(() => {
    delete process.env.NIB_HOME;
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("(a) executes a tool call that matches an explicit allow rule", async () => {
    writeSettings({ permissions: { rules: [{ tool: "run_bash", pattern: "git status", action: "allow" }] } });
    // permissions is an execution-capable key (settings-trust.ts) — trust the
    // project settings file so the configured allow rule actually reaches the
    // PermissionEngine instead of being stripped to the ask-all default.
    const { trustSettings } = await import("./config/settings-trust.js");
    trustSettings(projectSettingsPath(PROJECT_DIR));
    scriptedCall = { name: "run_bash", args: { command: "git status" } };

    const { stderr } = await run();

    expect(executeToolSpy).toHaveBeenCalledTimes(1);
    expect(stderr).not.toContain("permission denied (headless)");
  });

  it("(b) denies an ask-resolving call (defaultMode askAll) without executing it", async () => {
    writeSettings({ permissions: { defaultMode: "askAll", rules: [] } });
    scriptedCall = { name: "run_bash", args: { command: "echo hi" } };

    const { stderr } = await run();

    expect(executeToolSpy).not.toHaveBeenCalled();
    expect(stderr).toContain("permission denied (headless): run_bash echo hi");
  });

  it("(c) denies a guarded-tier call (reading .env) without executing it", async () => {
    writeSettings({ permissions: { defaultMode: "allowAll", rules: [] } });
    scriptedCall = { name: "read_file", args: { path: join(PROJECT_DIR, ".env") } };

    const { stderr } = await run();

    expect(executeToolSpy).not.toHaveBeenCalled();
    expect(stderr).toContain("permission denied (headless): read_file");
  });

  it("(d) denies a destructive-tier call (rm -rf /) without executing it", async () => {
    writeSettings({ permissions: { defaultMode: "allowAll", rules: [] } });
    scriptedCall = { name: "run_bash", args: { command: "rm -rf /" } };

    const { stderr } = await run();

    expect(executeToolSpy).not.toHaveBeenCalled();
    // Destructive deny never reaches askUser, so no headless-ask notice — but
    // the call must still be blocked from executing.
    expect(stderr).not.toContain("permission denied (headless): run_bash rm -rf /");
  });

  it("(e) the deny path emits a single stderr notice naming the tool and subject", async () => {
    writeSettings({ permissions: { defaultMode: "askAll", rules: [] } });
    scriptedCall = { name: "run_bash", args: { command: "npm install left-pad" } };

    const { stderr } = await run();

    const notices = stderr.split("\n").filter((l) => l.includes("permission denied (headless)"));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toBe("permission denied (headless): run_bash npm install left-pad");
  });

  it("(f) a permissionProfile deny blocks execution silently — the headless ask path is never reached", async () => {
    writeSettings({
      permissions: { defaultMode: "askAll", rules: [] },
      permissionProfile: { level: "workspace-write", fs: [{ path: "**/*.env", action: "deny" }] },
    });
    // permissionProfile is an execution-capable key (settings-trust.ts) —
    // trust the project settings file so the configured workspace-write
    // profile actually reaches ProfileEvaluator instead of being forced to
    // strict-sandbox by the untrusted-strip fallback.
    const { trustSettings } = await import("./config/settings-trust.js");
    trustSettings(projectSettingsPath(PROJECT_DIR));
    scriptedCall = { name: "read_file", args: { path: join(PROJECT_DIR, "secret.env") } };

    const { code, stderr } = await run();

    // Fail-closed exactly like a rule deny: no execution, no prompts, no
    // headless-ask notice (a layer-1 deny never resolves to ask), no noise.
    expect(code).toBe(0);
    expect(executeToolSpy).not.toHaveBeenCalled();
    expect(stderr).not.toContain("permission denied (headless)");
    expect(stderr).toBe("");
  });

  it("(g) a profile that passes keeps the headless ask-deny path untouched", async () => {
    writeSettings({
      permissions: { defaultMode: "askAll", rules: [] },
      permissionProfile: { level: "workspace-write" },
    });
    scriptedCall = { name: "run_bash", args: { command: "echo hi" } };

    const { stderr } = await run();

    // run_bash is not profile-gated, so layer 1 passes; the rule engine still
    // asks, and headless denies with the usual single-line notice.
    expect(executeToolSpy).not.toHaveBeenCalled();
    expect(stderr).toContain("permission denied (headless): run_bash echo hi");
  });
});

// B1 — a brand-new user's first command must never surface a raw Node stack
// trace. Every failure reachable before the agent runs (missing key, unknown
// provider, unknown mode) must be one/two clean stderr lines with exit code 1.
describe("runExecMode first-run failures are clean (B1)", () => {
  beforeEach(() => {
    mkdirSync(PROJECT_DIR, { recursive: true });
    mkdirSync(HOME_DIR, { recursive: true });
    process.env.NIB_HOME = HOME_DIR;
    createProviderSpy.mockClear();
    providerFactory = () => scriptedProvider();
    scriptedCall = null;
  });

  afterEach(() => {
    delete process.env.NIB_HOME;
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("missing provider key exits 1 with a clean one-line message pointing to auth", async () => {
    writeSettings({ provider: "deepseek" });
    providerFactory = () => {
      throw new Error(
        'Provider "deepseek" requires DEEPSEEK_API_KEY to be set, or run `nib auth` to store a key in credentials.yaml',
      );
    };

    const { code, stderr } = await run();

    expect(code).toBe(1);
    const lines = stderr.split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("nib auth");
    expect(stderr).not.toContain("    at "); // no stack frames
  });

  it("unknown provider exits 1 with a clean message", async () => {
    writeSettings({ provider: "nope" });
    providerFactory = () => {
      throw new Error('Unknown provider: "nope". Known: deepseek, openai');
    };

    const { code, stderr } = await run();

    expect(code).toBe(1);
    expect(stderr).toContain('Error: Unknown provider: "nope"');
    expect(stderr).not.toContain("    at ");
  });

  it("unknown --mode exits 1 with an 'unknown mode' message listing available modes", async () => {
    writeSettings({ provider: "deepseek" });

    const { code, stderr } = await run({ mode: "bogusmode" });

    expect(code).toBe(1);
    expect(stderr).toContain('unknown mode "bogusmode"');
    expect(stderr).toContain("available:");
    expect(stderr).toContain("code"); // a real built-in mode
    expect(stderr).not.toContain("    at ");
    // The provider gate must not have fired — mode is validated first.
    expect(createProviderSpy).not.toHaveBeenCalled();
  });

  it("defaults to General's read-only tool set when no --mode is given, matching the TUI's startup default", async () => {
    getByModeSpy.mockClear();

    const { code } = await run();

    expect(code).toBe(0);
    expect(getByModeSpy).toHaveBeenCalledWith(["read"]);
    expect(createProviderSpy).toHaveBeenCalledWith("deepseek", expect.objectContaining({ modelOverride: "deepseek-v4-flash" }));
    expect(lastStreamOptions?.effort).toBe("low");
  });

  it("keeps an explicit model over General's default", async () => {
    const { code } = await run({ model: "openai/gpt-5.6-luna" });

    expect(code).toBe(0);
    expect(createProviderSpy).toHaveBeenCalledWith("openai", expect.objectContaining({ modelOverride: "gpt-5.6-luna" }));
  });

  it("gates tools to the explicit --mode's groups instead of General's default", async () => {
    writeSettings({ provider: "deepseek" });
    getByModeSpy.mockClear();

    const { code } = await run({ mode: "code" });

    expect(code).toBe(0);
    expect(getByModeSpy).toHaveBeenCalledWith(["read", "edit", "command", "workflow"]);
    expect(createProviderSpy).toHaveBeenCalledWith("deepseek", expect.objectContaining({ modelOverride: undefined }));
  });
});

// B6 — provider/API failures during the run must print one concise line
// (status + provider message), not the entire AI SDK error object. The full
// dump (the SDK's default console.error(error)) is only allowed with --debug.
describe("runExecMode provider failures are concise (B6)", () => {
  beforeEach(() => {
    mkdirSync(PROJECT_DIR, { recursive: true });
    mkdirSync(HOME_DIR, { recursive: true });
    process.env.NIB_HOME = HOME_DIR;
    createProviderSpy.mockClear();
    providerFactory = () => scriptedProvider();
    scriptedCall = null;
    writeSettings({ provider: "deepseek" });
  });

  afterEach(() => {
    delete process.env.NIB_HOME;
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("extracts status + message from an APICallError and suppresses the object dump", async () => {
    const { APICallError } = await import("ai");
    providerFactory = () => ({
      name: "fake",
      async *streamChat(): AsyncGenerator<StreamEvent> {
        // Simulate the AI SDK's default onError, which dumps the whole object.
        console.error(
          new APICallError({
            message: "Authentication Fails",
            url: "https://api.deepseek.com/chat/completions",
            requestBodyValues: { model: "deepseek-v4-pro", secret: "leaked" },
            statusCode: 401,
            responseHeaders: { "x-request-id": "abc" },
            responseBody: '{"error":"Authentication Fails"}',
            isRetryable: false,
          }),
        );
        throw new APICallError({
          message: "Authentication Fails",
          url: "https://api.deepseek.com/chat/completions",
          requestBodyValues: { model: "deepseek-v4-pro", secret: "leaked" },
          statusCode: 401,
          responseHeaders: { "x-request-id": "abc" },
          responseBody: '{"error":"Authentication Fails"}',
          isRetryable: false,
        });
        yield { type: "done", finishReason: "stop" };
      },
    });

    const { code, stderr } = await run();

    expect(code).toBe(1);
    expect(stderr).toContain("Error: HTTP 401: Authentication Fails");
    // None of the internal request detail leaks without --debug.
    expect(stderr).not.toContain("requestBodyValues");
    expect(stderr).not.toContain("leaked");
    expect(stderr).not.toContain("x-request-id");
  });

  it("unwraps a RetryError to the last provider error", async () => {
    const { APICallError, RetryError } = await import("ai");
    providerFactory = () => ({
      name: "fake",
      async *streamChat(): AsyncGenerator<StreamEvent> {
        const api = new APICallError({
          message: "Cannot connect to API: bad port",
          url: "http://127.0.0.1:9/chat/completions",
          requestBodyValues: {},
          isRetryable: true,
        });
        throw new RetryError({
          message: "Failed after 4 attempts. Last error: AI_APICallError: Cannot connect to API: bad port",
          reason: "maxRetriesExceeded",
          errors: [api],
        });
        yield { type: "done", finishReason: "stop" };
      },
    });

    const { code, stderr } = await run();

    expect(code).toBe(1);
    expect(stderr).toContain("Error: Cannot connect to API: bad port");
    expect(stderr).not.toContain("Failed after 4 attempts");
  });

  it("with --debug, the full error object is handed to console.error for diagnosis", async () => {
    const { APICallError } = await import("ai");
    const thrown = new APICallError({
      message: "Authentication Fails",
      url: "https://api.deepseek.com/chat/completions",
      requestBodyValues: { model: "deepseek-v4-pro" },
      statusCode: 401,
      responseHeaders: {},
      responseBody: "{}",
      isRetryable: false,
    });
    providerFactory = () => ({
      name: "fake",
      async *streamChat(): AsyncGenerator<StreamEvent> {
        throw thrown;
        yield { type: "done", finishReason: "stop" };
      },
    });
    // With --debug, exec-runner leaves console.error live and re-emits the full
    // error object through it. Spy so we can assert the object (not a string) is
    // passed for the developer to inspect.
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { code, stderr } = await run({ debug: true });

    expect(code).toBe(1);
    expect(stderr).toContain("Error: HTTP 401: Authentication Fails");
    expect(errSpy).toHaveBeenCalledWith(thrown);
    errSpy.mockRestore();
  });

  it("without --debug, console.error is suppressed so the SDK object dump cannot leak", async () => {
    const { APICallError } = await import("ai");
    // A live spy on console.error stands in for the SDK's default onError dump.
    const errSpy = vi.spyOn(console, "error");
    providerFactory = () => ({
      name: "fake",
      async *streamChat(): AsyncGenerator<StreamEvent> {
        // The SDK would dump the whole object here; exec-runner must have
        // replaced console.error with a no-op, so this reaches nothing.
        console.error("FULL_SDK_DUMP requestBodyValues secret");
        throw new APICallError({
          message: "Authentication Fails",
          url: "https://api.deepseek.com/chat/completions",
          requestBodyValues: {},
          statusCode: 401,
          responseHeaders: {},
          responseBody: "{}",
          isRetryable: false,
        });
        yield { type: "done", finishReason: "stop" };
      },
    });

    const { code, stderr } = await run();

    expect(code).toBe(1);
    expect(stderr).toContain("Error: HTTP 401: Authentication Fails");
    expect(stderr).not.toContain("FULL_SDK_DUMP");
    errSpy.mockRestore();
  });
});

// B2 — settings.json env.BASE_URL (and API_KEY) must actually reach the
// built-in provider path. We assert createProvider receives the config values.
describe("runExecMode honors config BASE_URL / API_KEY (B2)", () => {
  beforeEach(() => {
    mkdirSync(PROJECT_DIR, { recursive: true });
    mkdirSync(HOME_DIR, { recursive: true });
    process.env.NIB_HOME = HOME_DIR;
    createProviderSpy.mockClear();
    providerFactory = () => scriptedProvider();
    scriptedCall = null;
  });

  afterEach(() => {
    delete process.env.NIB_HOME;
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("passes env.BASE_URL and env.API_KEY from settings.json into createProvider (trusted project settings)", async () => {
    writeSettings({
      provider: "deepseek",
      env: { BASE_URL: "http://127.0.0.1:9", API_KEY: "sk-from-config" },
    });
    // env.BASE_URL is an execution-capable key (settings-trust.ts) — headless
    // fails closed on an untrusted project settings file, so this test trusts
    // it first to observe the value actually reaching createProvider.
    const { trustSettings } = await import("./config/settings-trust.js");
    trustSettings(projectSettingsPath(PROJECT_DIR));

    const { code } = await run();

    expect(code).toBe(0);
    expect(createProviderSpy).toHaveBeenCalledWith(
      "deepseek",
      expect.objectContaining({ baseUrl: "http://127.0.0.1:9", apiKey: "sk-from-config" }),
    );
  });

  it("strips env.BASE_URL from an untrusted project settings file, with a stderr warning", async () => {
    writeSettings({
      provider: "deepseek",
      env: { BASE_URL: "http://127.0.0.1:9", API_KEY: "sk-from-config" },
    });

    const { code, stderr } = await run();

    expect(code).toBe(0);
    expect(createProviderSpy).toHaveBeenCalledWith(
      "deepseek",
      expect.objectContaining({ baseUrl: undefined }),
    );
    expect(stderr).toContain("[warn]");
    expect(stderr).toContain("env");
  });
});

// Notify hook fires from the headless completion boundary — once on a normal
// end ("completed"), once with FAIL_REASON on a provider failure ("failed"),
// and never when `notify` is absent from settings.json.
describe("runExecMode fires the notify hook at the completion boundary", () => {
  beforeEach(() => {
    mkdirSync(PROJECT_DIR, { recursive: true });
    mkdirSync(HOME_DIR, { recursive: true });
    process.env.NIB_HOME = HOME_DIR;
    createProviderSpy.mockClear();
    fireNotifySpy.mockClear();
    providerFactory = () => scriptedProvider();
    scriptedCall = null;
  });

  afterEach(() => {
    delete process.env.NIB_HOME;
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("passes an undefined script path when `notify` is absent (fireNotify no-ops on it)", async () => {
    writeSettings({ provider: "deepseek" });

    const { code } = await run();

    expect(code).toBe(0);
    // The completion site always calls fireNotify; the no-op-when-unconfigured
    // guard lives inside fireNotify (covered in notify.test.ts). Here we assert
    // the site forwards `undefined` when `notify` is not set.
    expect(fireNotifySpy).toHaveBeenCalledTimes(1);
    expect(fireNotifySpy.mock.calls[0][0]).toBeUndefined();
  });

  it("fires with status 'completed', the config script path, last reply body, and passthrough env", async () => {
    writeSettings({
      provider: "deepseek",
      notify: "/tmp/notify.sh",
      env: { SLACK_WEBHOOK_URL: "https://hooks.example/x" },
    });
    // notify and env are execution-capable keys — trust the project settings
    // file so the configured script path/env actually reach fireNotify.
    const { trustSettings } = await import("./config/settings-trust.js");
    trustSettings(projectSettingsPath(PROJECT_DIR));

    const { code } = await run();

    expect(code).toBe(0);
    expect(fireNotifySpy).toHaveBeenCalledTimes(1);
    const [scriptPath, input] = fireNotifySpy.mock.calls[0] as [string, any];
    expect(scriptPath).toBe("/tmp/notify.sh");
    expect(input.status).toBe("completed");
    expect(input.body).toBe("done"); // the scripted provider's last reply text
    expect(input.title).toBe("go"); // first-prompt prefix
    expect(input.passthroughEnv).toMatchObject({ SLACK_WEBHOOK_URL: "https://hooks.example/x" });
  });

  it("fires with status 'failed' and a FAIL_REASON when the provider throws", async () => {
    writeSettings({ provider: "deepseek", notify: "/tmp/notify.sh" });
    const { trustSettings } = await import("./config/settings-trust.js");
    trustSettings(projectSettingsPath(PROJECT_DIR));
    providerFactory = () => ({
      name: "fake",
      // eslint-disable-next-line require-yield
      async *streamChat(): AsyncGenerator<StreamEvent> {
        throw new Error("stream exploded");
      },
    });

    const { code } = await run();

    expect(code).toBe(1);
    expect(fireNotifySpy).toHaveBeenCalledTimes(1);
    const [scriptPath, input] = fireNotifySpy.mock.calls[0] as [string, any];
    expect(scriptPath).toBe("/tmp/notify.sh");
    expect(input.status).toBe("failed");
    expect(input.failReason).toContain("stream exploded");
  });
});

// Proves the self-reflection / error-recovery subsystems are actually
// constructed and passed by the headless call site — before wiring they were
// always undefined, so neither of these behaviors could occur.
describe("runExecMode wires self-reflection + error-recovery (engagement)", () => {
  beforeEach(() => {
    mkdirSync(PROJECT_DIR, { recursive: true });
    mkdirSync(HOME_DIR, { recursive: true });
    process.env.DEEPCODE_HOME = HOME_DIR;
    executeToolSpy.mockClear();
    createProviderSpy.mockClear();
    scriptedCall = null;
  });

  afterEach(() => {
    delete process.env.DEEPCODE_HOME;
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("errorReflector: a failing tool result drives a reflection retry turn", async () => {
    // allowAll so the tool runs; it returns an error the first time. The wired
    // reflector injects a retry prompt, so the provider is asked for a second
    // turn (which finishes). Without a reflector the run would stop after the
    // single failed turn without re-prompting.
    writeSettings({ provider: "deepseek", permissions: { defaultMode: "allowAll", rules: [] } });

    let providerTurns = 0;
    providerFactory = () => ({
      name: "fake",
      async *streamChat(): AsyncGenerator<StreamEvent> {
        providerTurns++;
        if (providerTurns === 1) {
          yield { type: "tool_call_start", id: "c1", name: "read_file" };
          yield { type: "tool_call_delta", id: "c1", arguments: JSON.stringify({ path: "a.txt" }) };
          yield { type: "done", finishReason: "tool_calls" };
        } else {
          yield { type: "text_delta", content: "recovered" };
          yield { type: "done", finishReason: "stop" };
        }
      },
    });
    executeToolSpy.mockImplementationOnce(async () => ({ content: "", error: "ENOENT: missing" }));

    const { code } = await run();

    expect(code).toBe(0);
    // A second provider turn only happens because the reflector re-prompted
    // after the failed tool result.
    expect(providerTurns).toBe(2);
  });

  it("errorRecovery: malformed tool-call JSON drives a correction retry instead of executing the tool", async () => {
    writeSettings({ provider: "deepseek", permissions: { defaultMode: "allowAll", rules: [] } });

    let providerTurns = 0;
    providerFactory = () => ({
      name: "fake",
      async *streamChat(): AsyncGenerator<StreamEvent> {
        providerTurns++;
        if (providerTurns === 1) {
          yield { type: "tool_call_start", id: "c1", name: "read_file" };
          yield { type: "tool_call_delta", id: "c1", arguments: "{not json" };
          yield { type: "done", finishReason: "tool_calls" };
        } else {
          yield { type: "text_delta", content: "fixed" };
          yield { type: "done", finishReason: "stop" };
        }
      },
    });

    const { code } = await run();

    expect(code).toBe(0);
    // The malformed call is never executed; recovery re-prompts for valid JSON.
    expect(executeToolSpy).not.toHaveBeenCalled();
    expect(providerTurns).toBe(2);
  });
});

// Config errors must fail fast in headless mode with the same message shape
// as the TUI — an invalid matcher regex is fatal, never a silent match-ALL
// hook (fix 5).
describe("runExecMode config errors fail fast (fix 5)", () => {
  beforeEach(() => {
    mkdirSync(PROJECT_DIR, { recursive: true });
    mkdirSync(HOME_DIR, { recursive: true });
    process.env.NIB_HOME = HOME_DIR;
    createProviderSpy.mockClear();
    providerFactory = () => scriptedProvider();
    scriptedCall = null;
  });

  afterEach(() => {
    delete process.env.NIB_HOME;
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("an invalid matcher regex exits 1 with the config error, before the provider is even built", async () => {
    writeSettings({ hooks: { PreToolUse: [{ matcher: "(bad", command: "guard.sh" }] } });
    scriptedCall = { name: "run_bash", args: { command: "git status" } };

    const { code, stderr } = await run();

    expect(code).toBe(1);
    expect(stderr).toContain('Error: config: hooks entry "guard.sh" has invalid matcher regex "(bad"');
    expect(executeToolSpy).not.toHaveBeenCalled();
    expect(createProviderSpy).not.toHaveBeenCalled();
  });
});

// Headless lifecycle hooks (hooks-spec.md): UserPromptSubmit gates the prompt
// before it enters the agent — exit 2 blocks the run with a stderr notice,
// exit-0 stdout appends to the prompt as context. Global-settings hooks are
// trusted implicitly, so a headless run executes them (untrusted project
// hooks are skipped per §6 — covered in src/hooks/trust.test.ts).
describe("runExecMode lifecycle hooks (headless)", () => {
  beforeEach(() => {
    mkdirSync(PROJECT_DIR, { recursive: true });
    mkdirSync(HOME_DIR, { recursive: true });
    process.env.NIB_HOME = HOME_DIR;
    createProviderSpy.mockClear();
    providerFactory = () => scriptedProvider();
    scriptedCall = null;
  });

  afterEach(() => {
    delete process.env.NIB_HOME;
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  function writeGlobalSettings(settings: Record<string, unknown>): void {
    writeFileSync(join(HOME_DIR, "settings.json"), JSON.stringify(settings), "utf-8");
  }

  it("blocks the run when a UserPromptSubmit hook exits 2, notifying on stderr", async () => {
    writeGlobalSettings({ hooks: { UserPromptSubmit: [{ command: "exit 2" }] } });

    const { code, stderr } = await run();

    expect(code).toBe(1);
    expect(stderr).toContain("UserPromptSubmit hook blocked the message");
    expect(createProviderSpy).toHaveBeenCalledTimes(1); // provider built, but the prompt never reached it
  });

  it("appends exit-0 UserPromptSubmit stdout to the prompt as context", async () => {
    writeGlobalSettings({ hooks: { UserPromptSubmit: [{ command: "echo HOOK-CONTEXT" }] } });
    const seenMessages: Array<Array<{ role: string; content?: string }>> = [];
    providerFactory = () => ({
      name: "fake",
      async *streamChat(messages: Array<{ role: string; content?: string }>) {
        seenMessages.push([...messages]);
        yield { type: "text_delta", content: "done" };
        yield { type: "done", finishReason: "stop" };
      },
    });

    const { code } = await run();

    expect(code).toBe(0);
    const lastUser = [...seenMessages[0]].reverse().find((m) => m.role === "user");
    expect(String(lastUser?.content ?? "")).toContain("HOOK-CONTEXT");
  });
});

describe("runExecMode @mention parity with the TUI", () => {
  beforeEach(() => {
    mkdirSync(PROJECT_DIR, { recursive: true });
    mkdirSync(HOME_DIR, { recursive: true });
    process.env.NIB_HOME = HOME_DIR;
    providerFactory = () => scriptedProvider();
    scriptedCall = null;
    lastMessages = undefined;
  });

  afterEach(() => {
    delete process.env.NIB_HOME;
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("expands a text mention into a <file> block, as the TUI does", async () => {
    writeFileSync(join(PROJECT_DIR, "notes.md"), "# NOTES BODY", "utf-8");

    const { code } = await run({ prompt: "summarize @notes.md" });

    expect(code).toBe(0);
    const firstUser = lastMessages!.find((m) => m.role === "user");
    expect(String(firstUser?.content ?? "")).toContain('<file path="notes.md">');
    expect(String(firstUser?.content ?? "")).toContain("# NOTES BODY");
  });

  it("attaches an image mention via imageUrls instead of dropping it as binary", async () => {
    // NUL bytes: the shape the old binary guard silently discarded.
    writeFileSync(join(PROJECT_DIR, "shot.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]));

    const { code } = await run({ prompt: "what is in @shot.png?" });

    expect(code).toBe(0);
    const attached = lastMessages!.find(
      (m): m is Extract<Message, { role: "user" }> => m.role === "user" && (m.imageUrls?.length ?? 0) > 0,
    );
    expect(attached?.imageUrls?.[0]).toMatch(/^data:image\/png;base64,/);
  });

  it("does nothing when the prompt has no mention", async () => {
    const { code } = await run({ prompt: "plain prompt" });

    expect(code).toBe(0);
    const firstUser = lastMessages!.find((m) => m.role === "user");
    // The volatile env/cwd context is prefixed to the user turn, so assert the
    // prompt survived and no mention was expanded.
    expect(String(firstUser?.content ?? "")).toContain("plain prompt");
    expect(String(firstUser?.content ?? "")).not.toContain("<file path=");
    expect(lastMessages!.some((m) => m.role === "user" && (m.imageUrls?.length ?? 0) > 0)).toBe(false);
  });
});
