#!/usr/bin/env tsx
/**
 * Prompt-count baseline for the sandboxed-Bash session grant
 * (docs/permission-ux-redesign.md, "Measure prompts before/after").
 *
 * What this measures: how many times an interactive prompter is consulted for
 * a fixed, realistic Bash trace, in two configurations —
 *
 *   --before  no envelope is handed to the run, and the prompter's only answer
 *             is a plain "yes". This is the path the committed code takes for
 *             these calls: with an undefined envelope the gate's entire grant
 *             branch is skipped (agent.ts), which agent.grant.test.ts pins in
 *             "still prompts when the run was not handed an envelope".
 *   --after   the run is handed the envelope its launches would use, and the
 *             prompter grants the session the first time it is offered one.
 *
 * What it is NOT: a safety measurement. A prompt that stopped happening is a UX
 * number, not evidence that anything became safer — the grant narrows nothing
 * about what a contained command can do (docs/permission-ux-redesign.md
 * "Honest gaps"). Each command's decisions are reported alongside the counts so
 * the reduction is traceable to why it happened, per command.
 *
 * Boundary: the decision path is real — the real `runAgent` gate, the real
 * `PermissionEngine`, the real envelope from `buildSandboxProfile`, the real
 * metrics reducer. The tool boundary is a stub, so no child process is started,
 * no command runs, and no endpoint is contacted at any step. The launcher's
 * containment behaviour is covered by the suite (src/sandbox/readiness.test.ts,
 * src/agent.grant.test.ts), not by this script.
 *
 * Deterministic: fixed trace, scripted provider, no clock or filesystem
 * dependence in any decision.
 *
 * Usage: npx tsx scripts/permission-grant-baseline.ts [--before|--after|--both]
 * JSON goes to stdout; a short human summary goes to stderr.
 */

import { runAgent, type AgentOptions, type ToolExecutor } from "../src/agent.js";
import { PermissionEngine } from "../src/permissions/index.js";
import { computeSessionPermissionMetrics } from "../src/sessions/metrics.js";
import type { PermissionAuditRecord } from "../src/sessions/store.js";
import { setSandboxLevel, setSessionId, setSessionTempDir, setWriteRoots } from "../src/tools/index.js";
import type { Provider, StreamEvent } from "../src/providers/types.js";

type Mode = "before" | "after";

const ROOT = process.cwd();
const SESSION_TEMP = "/tmp/nib-baseline-scratch";
/** A configured extra write root, so the envelope is not the trivial one. */
const EXTRA_WRITE_ROOT = "/tmp/nib-baseline-extra-root";

/** The command that motivated the redesign: `timeout` makes it opaque to the
 *  normalizer, so it is forced to ask on every call. */
const OPAQUE = "timeout 60 python3 mcp_probe.py --check";
/** A builtin-guarded prefix: a guarded ask is never quieter. */
const GUARDED = "curl -sS https://example.invalid/health";
/** Its own per-call approval: `git config` writes get a widened profile. */
const GIT_CONFIG = "git config user.email dev@example.invalid";
/** Terminal deny: the grant must never be reachable for it. */
const DENIED = "git push --force origin main";

/**
 * A fixed session: ordinary project work, the opaque probe twice, one guarded,
 * one git-config and one denied command, and one background call — the shapes
 * the grant is, and is not, allowed to cover.
 */
const TRACE: Array<{ tool: string; command: string }> = [
  { tool: "run_bash", command: "git status --short" },
  { tool: "run_bash", command: "npm test" },
  { tool: "run_bash", command: OPAQUE },
  { tool: "run_bash", command: "npm run build" },
  { tool: "run_bash", command: "node scripts/check-fixtures.js" },
  { tool: "run_bash", command: GUARDED },
  { tool: "run_bash", command: GIT_CONFIG },
  { tool: "run_bash", command: DENIED },
  { tool: "run_bash", command: OPAQUE },
  { tool: "run_bash", command: "npm test" },
  // Background Bash never consults or creates a grant: the same class of
  // command that would be covered in the foreground asks every time.
  { tool: "run_bash_background", command: "npm run dev" },
];

const BASH_CALLS = TRACE.filter((entry) => entry.tool === "run_bash").length;

type TurnScript = StreamEvent[];

function makeProvider(turns: TurnScript[]): { provider: Provider } {
  let call = 0;
  const provider: Provider = {
    name: "baseline",
    async *streamChat() {
      const events = turns[call] ?? [];
      call++;
      for (const event of events) yield event;
    },
  };
  return { provider };
}

const textTurn = (text: string): TurnScript => [
  { type: "text_delta", content: text },
  { type: "done", finishReason: "stop" },
];

function callTurn(id: string, name: string, command: string): TurnScript {
  return [
    { type: "tool_call_start", id, name },
    { type: "tool_call_delta", id, arguments: JSON.stringify({ command }) },
    { type: "done", finishReason: "tool_calls" },
  ];
}

interface Report {
  mode: Mode;
  traceCommands: number;
  bashCalls: number;
  backgroundCalls: number;
  /** Every prompter consultation, however it was answered. */
  prompts: number;
  promptsBash: number;
  promptsOther: number;
  promptsPer100BashCalls: number;
  grantsCreated: number;
  grantsReused: number;
  grantsInvalidated: number;
  grantsRevoked: number;
  denials: number;
  sandboxFailures: number;
  /** Calls the gate let through to the tool boundary. */
  ran: number;
  /** Of those, calls that ran under the approved session envelope. */
  ranUnderGrant: number;
  /** No child process is ever started: the tool boundary is a stub. */
  childProcesses: 0;
  /** Per-command audit trail, so the prompt count is traceable to its calls. */
  perCommand: Array<{ i: number; tool: string; command: string; decisions: string[] }>;
}

async function measure(mode: Mode): Promise<Report> {
  const sessionId = `baseline-${mode}`;
  const asked: Array<{ tool: string }> = [];
  const ran: Array<{ envelopeHash?: string }> = [];
  const rows: PermissionAuditRecord[] = [];

  // The envelope builder is imported here rather than at module scope so this
  // file's --before measurement also runs against the committed HEAD tree,
  // where it does not exist.
  const envelope =
    mode === "after"
      ? await (async () => {
          const { buildSandboxProfile, sandboxEnvelopeHash } = await import("../src/sandbox/seatbelt.js");
          return {
            profileHash: sandboxEnvelopeHash(
              buildSandboxProfile("workspace-write", ROOT, [EXTRA_WRITE_ROOT], SESSION_TEMP),
            ),
            level: "workspace-write" as const,
            trustedRoot: ROOT,
            writeRoots: [EXTRA_WRITE_ROOT],
            sessionTempDir: SESSION_TEMP,
          };
        })()
      : undefined;

  // The scripted prompter: it answers the way the UI bridge does. It is offered
  // the session option only when the gate passed an envelope (i.e. the call is
  // eligible), and it takes it — one consent, then silence for the rest.
  const askUser = async (
    toolName: string,
    _args: Record<string, unknown>,
    offeredEnvelope?: unknown,
  ): Promise<boolean | "envelope-grant"> => {
    asked.push({ tool: toolName });
    if (mode === "after" && offeredEnvelope !== undefined) return "envelope-grant";
    return true;
  };

  // The tool boundary. Everything the gate decides is real; nothing runs.
  const executeTool: ToolExecutor = async (_call, exec) => {
    ran.push(exec?.envelopeHash !== undefined ? { envelopeHash: exec.envelopeHash } : {});
    return { content: "ran" };
  };

  setSessionId(sessionId);
  setSandboxLevel("workspace-write");
  setWriteRoots([EXTRA_WRITE_ROOT]);
  setSessionTempDir(SESSION_TEMP);

  const { provider } = makeProvider([
    ...TRACE.map((entry, i) => callTurn(`call_${i}`, entry.tool, entry.command)),
    textTurn("done"),
  ]);
  const options: AgentOptions = {
    provider,
    tools: [],
    executeTool,
    permissions: new PermissionEngine(undefined, ROOT),
    askUser,
    sessionStore: {
      appendPermission: async (_sessionId: string, record: PermissionAuditRecord) => {
        rows.push(record);
      },
      appendToken: async () => {},
    } as never,
    sessionId,
    ...(envelope !== undefined ? { bashEnvelope: envelope } : {}),
  };
  await runAgent("Run the project's usual commands.", options);

  const metrics = computeSessionPermissionMetrics(rows);
  const promptsBash = asked.filter((entry) => entry.tool === "run_bash").length;
  const ranUnderGrant = ran.filter((entry) => entry.envelopeHash !== undefined);

  const report: Report = {
    mode,
    traceCommands: TRACE.length,
    bashCalls: BASH_CALLS,
    backgroundCalls: TRACE.length - BASH_CALLS,
    prompts: asked.length,
    promptsBash,
    promptsOther: asked.length - promptsBash,
    promptsPer100BashCalls: round((promptsBash / BASH_CALLS) * 100),
    // `?? 0` because the committed HEAD tree predates these counters: running
    // this file's --before measurement there is what substantiates that the
    // before-mode number is HEAD's own behaviour, not a mode of this branch.
    grantsCreated: metrics.envelopeGrantsCreated ?? 0,
    grantsReused: metrics.envelopeGrantReuses ?? 0,
    grantsInvalidated: metrics.envelopeGrantInvalidations ?? 0,
    grantsRevoked: metrics.envelopeGrantRevocations ?? 0,
    denials: metrics.permissionDenials,
    sandboxFailures: metrics.sandboxFailures ?? 0,
    ran: ran.length,
    ranUnderGrant: ranUnderGrant.length,
    childProcesses: 0,
    perCommand: TRACE.map((entry, i) => ({
      i,
      tool: entry.tool,
      command: entry.command,
      decisions: rows.filter((row) => row.toolCallId === `call_${i}`).map((row) => row.decision),
    })),
  };

  check(report, metrics, ranUnderGrant.map((entry) => entry.envelopeHash), envelope?.profileHash);
  return report;
}

/**
 * The harness's own honesty guards. A silent mismatch would make the reported
 * numbers unverifiable, so each one is fatal.
 */
function check(
  report: Report,
  metrics: ReturnType<typeof computeSessionPermissionMetrics>,
  coveredHashes: Array<string | undefined>,
  envelopeHash: string | undefined,
): void {
  const fail = (why: string): never => {
    throw new Error(`baseline self-check failed (${report.mode}): ${why}`);
  };
  // The shipped metrics reducer and the interactive bridge must agree on how
  // many prompts there were — the reported count is the bridge's, and the
  // reducer's is what the product would show for the same session.
  if (metrics.permissionPrompts !== report.prompts) {
    fail(
      `reducer counted ${metrics.permissionPrompts} prompts, bridge saw ${report.prompts}: ` +
        JSON.stringify(report.perCommand),
    );
  }
  // Nothing runs unprompted: every trace call that was not denied reached the
  // tool boundary.
  if (report.ran + report.denials !== report.traceCommands) {
    fail(`${report.ran} ran + ${report.denials} denied != ${report.traceCommands} trace calls`);
  }
  if (report.mode === "before") {
    if (report.grantsCreated !== 0 || report.grantsReused !== 0 || report.ranUnderGrant !== 0) {
      fail("before mode created, reused, or ran under a session grant");
    }
  } else {
    // Exactly one consent, and every covered call ran under the envelope that
    // consent was for — never under whatever the session looks like later.
    if (report.grantsCreated !== 1) fail(`expected one consent, saw ${report.grantsCreated}`);
    if (coveredHashes.length === 0) fail("no call ran under the session envelope");
    if (coveredHashes.some((hash) => hash !== envelopeHash)) fail("a covered call ran under a different envelope");
  }
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

function delta(before: Report, after: Report): Record<string, number> {
  const keys = [
    "prompts", "promptsBash", "promptsOther", "promptsPer100BashCalls",
    "grantsCreated", "grantsReused", "grantsInvalidated", "grantsRevoked",
    "denials", "sandboxFailures", "ran", "ranUnderGrant",
  ] as const;
  const out: Record<string, number> = {};
  for (const key of keys) out[key] = round(after[key] - before[key]);
  return out;
}

function summarize(report: Report): string {
  return (
    `${report.mode.padEnd(6)} prompts ${report.prompts}` +
    ` (bash ${report.promptsBash}/${report.bashCalls} calls = ${report.promptsPer100BashCalls}/100, other ${report.promptsOther})` +
    ` · grants ${report.grantsCreated} created, ${report.grantsReused} reused` +
    ` · denials ${report.denials} · sandbox failures ${report.sandboxFailures}\n`
  );
}

async function main(): Promise<void> {
  const arg = (process.argv[2] ?? "--both").replace(/^--/, "");
  if (arg !== "before" && arg !== "after" && arg !== "both") {
    process.stderr.write("usage: npx tsx scripts/permission-grant-baseline.ts [--before|--after|--both]\n");
    process.exit(1);
  }

  const out: Record<string, unknown> = {};
  if (arg !== "after") out.before = await measure("before");
  if (arg !== "before") out.after = await measure("after");
  if (arg === "both") out.delta = delta(out.before as Report, out.after as Report);
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);

  for (const key of ["before", "after"] as const) {
    const report = out[key] as Report | undefined;
    if (report) process.stderr.write(summarize(report));
  }
  const d = out.delta as Record<string, number> | undefined;
  if (d) process.stderr.write(`delta  prompts ${d.prompts} · per 100 Bash calls ${d.promptsPer100BashCalls}\n`);
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
