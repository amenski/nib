import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
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
    const { toolResults } = await run({ turns: [bashTurn("c1", `touch ${target}/f`), textTurn("ok")], results: [denied([writeGroup()])], askCapability: ask });
    expect(ask).toHaveBeenCalledWith(expect.objectContaining({ capability: expect.objectContaining({ id: `write:${target}` }), probable: false, command: `touch ${target}/f` }));
    expect(activeGrants()).toEqual([`write:${target}`]);
    expect(toolResults[0].content).toContain(`[nib] The user granted "Write to ${JSON.stringify(target)}" for this session. Rerun the command once; do not retry on a repeat denial.`);
  });

  it("'always' also saves the id to the global settings file", async () => {
    await run({ turns: [bashTurn("c1", "x"), textTurn("ok")], results: [denied([writeGroup()])], askCapability: async () => "always" });
    const saved = JSON.parse(readFileSync(join(nibHome, "settings.json"), "utf8"));
    expect(saved.sandbox.grants).toEqual([`write:${target}`]);
  });

  it("a decline is remembered for the session and never asked twice", async () => {
    const ask = vi.fn(async () => "deny" as const);
    const { toolResults } = await run({
      turns: [bashTurn("c1", "a"), bashTurn("c2", "b"), textTurn("ok")],
      results: [denied([writeGroup()]), denied([writeGroup()])],
      askCapability: ask,
      sessionId: "decline-session",
    });
    expect(ask).toHaveBeenCalledTimes(1);
    expect(activeGrants()).toEqual([]);
    expect(toolResults[0].content).toContain("[nib] The user declined");
  });

  it("headless (no prompter) reports only", async () => {
    const { toolResults } = await run({ turns: [bashTurn("c1", "x"), textTurn("ok")], results: [denied([writeGroup()])] });
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
      turns: [bashTurn("c1", "x"), textTurn("ok")],
      results: [denied([writeGroup({ probable: true, samples: ["/nowhere/q"] }), ...dirs.map((d) => writeGroup({ key: d, samples: [join(d, "f")] }))])],
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
});
