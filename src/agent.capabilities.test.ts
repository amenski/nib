import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { runAgent } from "./agent.js";
import type { Provider, StreamEvent } from "./providers/types.js";
import type { ToolOutput } from "./types.js";
import type { DenialGroup } from "./sandbox/denials.js";
import type { CapabilityAnswer, CapabilityRequest } from "./sandbox/capabilities.js";
import { activeGrants, configureSandbox } from "./sandbox/seatbelt.js";
import { bashEnvelopeGrants, type BashEnvelope } from "./permissions/session-grant.js";

type TurnScript = StreamEvent[];
function makeProvider(turns: TurnScript[]): Provider {
  let call = 0;
  return {
    name: "fake",
    async *streamChat() {
      for (const event of turns[call++] ?? []) yield event;
    },
  } as Provider;
}
const textTurn = (text: string): TurnScript => [{ type: "text_delta", content: text }, { type: "done", finishReason: "stop" }];
const bashTurn = (id: string, command: string): TurnScript => [
  { type: "tool_call_start", id, name: "run_bash" },
  { type: "tool_call_delta", id, arguments: JSON.stringify({ command }) },
  { type: "done", finishReason: "tool_calls" },
];

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "nib-agent-cap-")));
const target = join(scratch, "out");
const nibHome = join(scratch, "nib-home");
const previousHome = process.env.NIB_HOME;
beforeAll(() => {
  mkdirSync(target);
  mkdirSync(nibHome);
  process.env.NIB_HOME = nibHome;
});
afterAll(() => {
  if (previousHome === undefined) delete process.env.NIB_HOME;
  else process.env.NIB_HOME = previousHome;
  rmSync(scratch, { recursive: true, force: true });
});
afterEach(() => configureSandbox({}));

const writeGroup = (over: Partial<DenialGroup> = {}): DenialGroup => ({
  opClass: "write", key: target, ops: ["file-write-create"], samples: [join(target, "f")], count: 1, probable: false, ...over,
});
const denied = (groups: DenialGroup[]): ToolOutput => ({ content: "Exit code: 1\ntouch: Operation not permitted", error: "Exit code: 1", sandboxDenials: groups });

async function run(opts: {
  turns: TurnScript[];
  results: ToolOutput[];
  askCapability?: (req: CapabilityRequest) => Promise<CapabilityAnswer>;
  sessionId?: string;
  bashEnvelope?: () => BashEnvelope | undefined;
  sessionStore?: unknown;
}) {
  let i = 0;
  const executeTool = vi.fn(async () => opts.results[i++] ?? { content: "ok" });
  const toolResults: ToolOutput[] = [];
  await runAgent("go", {
    provider: makeProvider(opts.turns),
    tools: [],
    executeTool,
    askCapability: opts.askCapability,
    sessionId: opts.sessionId,
    bashEnvelope: opts.bashEnvelope,
    sessionStore: opts.sessionStore as never,
    onToolResult: (_n, r) => toolResults.push(r),
  });
  return { executeTool, toolResults };
}

describe("capability grants after a sandbox denial", () => {
  it("asks, grants for the session, and tells the model to rerun once", async () => {
    const ask = vi.fn(async () => "session" as const);
    const { toolResults } = await run({ turns: [bashTurn("c1", `touch ${target}/f`), textTurn("ok")], results: [denied([writeGroup({ probable: true })])], askCapability: ask });
    expect(ask).toHaveBeenCalledWith(expect.objectContaining({ capability: expect.objectContaining({ id: `write:${target}` }), probable: true, command: `touch ${target}/f` }));
    expect(activeGrants()).toEqual([`write:${target}`]);
    expect(toolResults[0].content).toContain(`[nib] The user granted "Write to ${JSON.stringify(target)}" for this session. Rerun the command once; do not retry on a repeat denial.`);
  });

  it("'always' also saves the id to the global settings file", async () => {
    await run({ turns: [bashTurn("c1", `touch ${target}/f`), textTurn("ok")], results: [denied([writeGroup({ probable: true })])], askCapability: async () => "always" });
    const saved = JSON.parse(readFileSync(join(nibHome, "settings.json"), "utf8"));
    expect(saved.sandbox.grants).toEqual([`write:${target}`]);
    // The loader requires `enabled` whenever the block exists.
    expect(saved.sandbox.enabled).toBe(true);
  });

  it("a decline is remembered for the session and never asked twice", async () => {
    const ask = vi.fn(async () => "deny" as const);
    const { toolResults } = await run({
      turns: [bashTurn("c1", `touch ${target}/f`), bashTurn("c2", `touch ${target}/f`), textTurn("ok")],
      results: [denied([writeGroup({ probable: true })]), denied([writeGroup({ probable: true })])],
      askCapability: ask,
      sessionId: "decline-session",
    });
    expect(ask).toHaveBeenCalledTimes(1);
    expect(activeGrants()).toEqual([]);
    expect(toolResults[0].content).toContain("[nib] The user declined");
  });

  it("grants a plain denied directory for the session without asking, headless included", async () => {
    const ask = vi.fn(async () => "deny" as const);
    const { toolResults } = await run({ turns: [bashTurn("c1", "x"), textTurn("ok")], results: [denied([writeGroup()])], askCapability: ask });
    expect(ask).not.toHaveBeenCalled();
    expect(activeGrants()).toEqual([`write:${target}`]);
    expect(toolResults[0].content).toContain(`[nib] Allowed "Write to ${JSON.stringify(target)}" for this session.`);
    configureSandbox({});
    await run({ turns: [bashTurn("c1", "x"), textTurn("ok")], results: [denied([writeGroup()])] });
    expect(activeGrants()).toEqual([`write:${target}`]);
  });

  it("headless (no prompter) reports only a probable denial", async () => {
    const { toolResults } = await run({ turns: [bashTurn("c1", `touch ${target}/f`), textTurn("ok")], results: [denied([writeGroup({ probable: true })])] });
    expect(activeGrants()).toEqual([]);
    expect(toolResults[0].content).not.toContain("[nib] The user");
  });

  it("says when the thing denied is not grantable, without asking", async () => {
    const ask = vi.fn(async () => "session" as const);
    const { toolResults } = await run({
      turns: [bashTurn("c1", "x"), textTurn("ok")],
      results: [denied([writeGroup({ key: "/usr", samples: ["/usr/nib-x"] })])],
      askCapability: ask,
    });
    expect(ask).not.toHaveBeenCalled();
    expect(toolResults[0].content).toMatch(/\[nib\] Not offered to the user: "\/usr" is not grantable/);
  });

  it("does not ask about a probable denial with no evidence, and caps prompts at three", async () => {
    const ask = vi.fn(async () => "deny" as const);
    const dirs = ["a", "b", "c", "d"].map((n) => { const d = join(scratch, n); mkdirSync(d, { recursive: true }); return d; });
    await run({
      turns: [bashTurn("c1", dirs.map((d) => join(d, "f")).join(" ")), textTurn("ok")],
      results: [denied([writeGroup({ probable: true, samples: ["/nowhere/q"] }), ...dirs.map((d) => writeGroup({ probable: true, key: d, samples: [join(d, "f")] }))])],
      askCapability: ask,
    });
    expect(ask).toHaveBeenCalledTimes(3);
  });

  it("moves a session grant to the widened envelope instead of invalidating it", async () => {
    const sessionId = "renew-session";
    const envelope = (): BashEnvelope => ({
      profileHash: `hash:${activeGrants().join(",")}`, level: "workspace-write", trustedRoot: scratch,
      writeRoots: [scratch], sessionTempDir: scratch, autoGrant: true,
    });
    bashEnvelopeGrants.grant({ sessionId, tool: "run_bash", profileHash: envelope().profileHash, level: "workspace-write", trustedRoot: scratch, writeRoots: [scratch], sessionTempDir: scratch });
    const sessionStore = { appendPermission: vi.fn(async () => {}), appendToken: vi.fn(async () => {}) };
    await run({ turns: [bashTurn("c1", "x"), textTurn("ok")], results: [denied([writeGroup()])], askCapability: async () => "session", sessionId, bashEnvelope: envelope, sessionStore });
    expect(bashEnvelopeGrants.lookup(sessionId, "run_bash", `hash:write:${target}`)).not.toBeNull();
    expect(sessionStore.appendPermission).toHaveBeenCalledWith(sessionId, expect.objectContaining({ decision: "grant-renewed", subject: `write:${target}` }));
    bashEnvelopeGrants.revoke(sessionId, "run_bash");
  });

  it("treats a failed background job as failed, so a denied read under $HOME is granted", async () => {
    const dir = mkdtempSync(join(homedir(), "nib-cap-job-"));
    try {
      const real = realpathSync(dir);
      const readGroup: DenialGroup = { opClass: "read", key: real, ops: ["file-read-data"], samples: [join(real, "f")], count: 1, probable: false };
      const job = (status: string): ToolOutput => ({ content: `Job j1\nStatus: ${status}\n`, sandboxDenials: [readGroup] });
      await run({ turns: [bashTurn("c1", "x"), textTurn("ok")], results: [job("exited (exit 0)")] });
      expect(activeGrants()).toEqual([]);
      await run({ turns: [bashTurn("c1", "x"), textTurn("ok")], results: [job("exited (exit 1)")] });
      expect(activeGrants()).toEqual([`read:${real}`]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  describe("macOS service lookups", () => {
    const machGroup = (service: string, over: Partial<DenialGroup> = {}): DenialGroup => ({
      opClass: "mach", key: service, ops: ["mach-lookup"], samples: [service], count: 1, probable: false, ...over,
    });
    const ok = (groups: DenialGroup[]): ToolOutput => ({ content: "done", sandboxDenials: groups });
    const service = "com.apple.coreservices.quarantine-resolver";

    it("grants a harmless service for the session without asking, even when the command succeeded", async () => {
      const ask = vi.fn(async () => "deny" as const);
      const { toolResults } = await run({ turns: [bashTurn("c1", "flutter analyze"), textTurn("ok")], results: [ok([machGroup(service)])], askCapability: ask });
      expect(ask).not.toHaveBeenCalled();
      expect(activeGrants()).toEqual([`mach:${service}`]);
      expect(toolResults[0].content).toContain(`[nib] Allowed "Look up ${JSON.stringify(service)}" for this session.`);
      // The earlier "always" test left a settings file behind; this grant must not be added to it.
      const saved = existsSync(join(nibHome, "settings.json")) ? readFileSync(join(nibHome, "settings.json"), "utf8") : "";
      expect(saved).not.toContain("mach:");
    });

    it("grants without a prompter too (headless)", async () => {
      await run({ turns: [bashTurn("c1", "x"), textTurn("ok")], results: [ok([machGroup(service)])] });
      expect(activeGrants()).toEqual([`mach:${service}`]);
    });

    it("never grants a service that would act as the user", async () => {
      const ask = vi.fn(async () => "session" as const);
      const { toolResults } = await run({ turns: [bashTurn("c1", "x"), textTurn("ok")], results: [ok([machGroup("com.apple.pasteboard.1")])], askCapability: ask });
      expect(ask).not.toHaveBeenCalled();
      expect(activeGrants()).toEqual([]);
      expect(toolResults[0].content).toContain("[nib] Not offered to the user:");
    });

    it("does not grant a probable (guessed) attribution", async () => {
      await run({ turns: [bashTurn("c1", "x"), textTurn("ok")], results: [ok([machGroup(service, { probable: true })])] });
      expect(activeGrants()).toEqual([]);
    });
  });
});
