import type { Provider } from "./providers/types.js";
import type { Message, ToolCall, ToolDef, ToolOutput } from "./types.js";
import type { PermissionEngine, ResolveResult } from "./permissions/index.js";
import { authorize, type ProfileEvaluator } from "./permissions/index.js";
import type { ModeConfig } from "./modes/loader.js";
import type { Compactor } from "./compaction/compactor.js";
import type { DiagnosticRunner } from "./diagnostics/index.js";
import type { LspManager } from "./lsp/index.js";
import { formatDiagnostics, diagnosticsBlock, relPath } from "./lsp/index.js";
import { wrapUntrusted, sanitizeControlChars } from "./tools/untrusted-content.js";
import type { ErrorReflector } from "./selfreflection/index.js";
import type { ErrorRecovery } from "./errorrecovery/index.js";
import type { SkillDef } from "./skills/index.js";
import type { AgentDef } from "./agents/index.js";
import type { MemoryStore } from "./memory/store.js";
import type { HookRunner } from "./hooks/index.js";
import type { SessionStore, CompactionSummary, PermissionDecision, PermissionAuditRecord, AutoAuditRecord } from "./sessions/store.js";
import { buildStablePreamble, buildVolatileContext, type PromptContext } from "./prompt.js";
import { estimateTokens, estimateOverheadTokens } from "./compaction/budget.js";
import { editToolResultsForRequest } from "./compaction/context-editing.js";
import { VerificationGate } from "./verification-gate.js";
import { formatTodoBlock } from "./tools/todo.js";
import type { TodoItem } from "./tools/todo.js";
import { formatPlanBlock } from "./plans/store.js";
import { logTiming } from "./debug/logger.js";
import { extractCapabilityPlan } from "./permissions/capabilities.js";
import { isGitConfigOperation } from "./permissions/git-config-operations.js";
import {
  bashEnvelopeGrants,
  isEligibleForGrant,
  type BashEnvelope,
} from "./permissions/session-grant.js";
import type { SandboxFailureReason } from "./sandbox/launcher.js";
import { unsandboxedRequestsAllowed, unsandboxedRun } from "./sandbox/unsandboxed.js";
import {
  applyRiskVerdict,
  autoBlockMessage,
  autoHardStop,
  classifyRiskWithModel,
  priorToolCalls,
  riskNarrowed,
  runAutoJudge,
  type AutoModeOptions,
  type RiskInput,
  type RiskMode,
  type Stage2Options,
} from "./permissions/risk/index.js";
import { formatRiskReason } from "./permissions/risk/reasons.js";
import { isJudgeableBlock, skipsAutoJudge } from "./permissions/risk/auto.js";
import type { ToolExecOptions } from "./tools/types.js";

/**
 * Why auto handed a call to a human, when the human must really be asked: a
 * hard stop (credential or protected path, git config, outside the sandbox, a
 * call matched by the user's own `ask` rule) or a session paused after repeated
 * blocks. A judge failure (timeout, error, unparseable) is not one — it carries
 * no handoff, so an in-write-set edit may still skip the prompt.
 */
export type AutoHandoff = "hard-stop" | "paused";

/** What the auto gate decided for one ask (see decideAuto in the permission gate). */
type AutoDecision =
  | { kind: "allow"; reason: string; auto: AutoAuditRecord }
  | { kind: "denied" }
  | { kind: "prompt"; note: string; handoff?: AutoHandoff };

export type ToolExecutor = (call: ToolCall, exec?: ToolExecOptions) => Promise<ToolOutput>;

import { extractToolSubject } from "./permissions/rules.js";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

function permissionSubjectText(toolName: string, args: Record<string, unknown>): string {
  return extractToolSubject(toolName, args);
}

/** Tools whose success means the workspace gained a file the session owns. */
const SESSION_WRITE_TOOLS = new Set([
  "edit", "edit_file", "write_to_file", "apply_patch", "apply_diff", "search_replace",
]);

/**
 * Absolute paths a successful write tool call produced, for the risk
 * classifier's `createdThisSession` set. Resolved the way the classifier
 * resolves a delete target (lexically — no symlink chase, `~` expanded), so
 * the two spellings always meet; a realpath here would resolve the same
 * directory differently and every delete would look pre-session.
 */
function writtenPaths(toolName: string, args: Record<string, unknown>): string[] {
  if (!SESSION_WRITE_TOOLS.has(toolName)) return [];
  // apply_patch's subject is its list of `+++ b/…` targets, comma-joined.
  const subject = permissionSubjectText(toolName, args);
  if (subject === "") return [];
  return subject.split(", ").flatMap((raw) => {
    const trimmed = raw.trim();
    if (trimmed === "") return [];
    const expanded = trimmed === "~" || trimmed.startsWith("~/") ? join(homedir(), trimmed.slice(1)) : trimmed;
    return [isAbsolute(expanded) ? expanded : resolve(process.cwd(), expanded)];
  });
}

/**
 * The last few user turns as plain text, for the risk classifier (§3.1: user
 * messages only — never tool results or assistant prose, so hostile file or
 * web content cannot address the rules that read this).
 *
 * This is a list the run *builds*, not a filter over `messages`, and that is
 * the point. The transcript carries `role: "user"` messages the agent wrote
 * itself — the error reflector's note quotes a tool's error text verbatim, and
 * a failed read or fetch puts file or web content in there. Filtering by role
 * would hand all of it to the classifier; only the two places the run receives
 * text from a human (the opening prompt and a steering message) append here.
 *
 * Prior-session turns from `options.history` are deliberately not included:
 * their provenance is not distinguishable after a resume, and omitting them
 * makes the two rules that read this stricter, never looser.
 */
function pushHumanTurn(turns: string[], text: string | undefined): void {
  if (text === undefined || text.trim() === "") return;
  turns.push(text);
  if (turns.length > MAX_HUMAN_TURNS) turns.shift();
}

const MAX_HUMAN_TURNS = 5;

// Every tool call in an assistant message must be answered by a tool message
// with the same id — providers reject a request where one is missing (the AI
// SDK throws AI_MissingToolResultsError before the call even goes out). The
// tool loop below can leave a call unanswered whenever it stops mid-batch:
// the turn-ending breaks (attempt_completion, loop detected, five consecutive
// failures) skip the remaining calls, and an unexpected throw inside the batch
// unwinds to the recovery catch. The gap then persists into session history,
// so every later request in that session — and every resume of it — fails the
// same way. Backfill a synthetic result for each unanswered call instead, just
// before the request is built, so the conversation stays well-formed no matter
// how the previous batch ended.
const UNANSWERED_TOOL_RESULT = "Error: tool call did not complete (the turn ended before this call produced a result).";

function repairOrphanedToolCalls(messages: Message[]): number {
  const answered = new Set<string>();
  for (const m of messages) {
    if (m.role === "tool") answered.add(m.toolCallId);
  }
  let repaired = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "assistant" || !m.toolCalls?.length) continue;
    const missing = m.toolCalls.filter((tc) => !answered.has(tc.id));
    if (missing.length === 0) continue;
    // Insert after the results this batch did produce, so the backfilled ones
    // land at the end of their own batch rather than ahead of their siblings.
    let at = i + 1;
    while (at < messages.length && messages[at].role === "tool") at++;
    messages.splice(
      at,
      0,
      ...missing.map((tc) => ({ role: "tool" as const, toolCallId: tc.id, toolName: tc.name, content: UNANSWERED_TOOL_RESULT })),
    );
    repaired += missing.length;
  }
  return repaired;
}

// Reporting threshold only, not a limit — large tool-call arguments (e.g. a
// big file write) are still parsed and executed in full. This just surfaces
// via onDiagnostic when JSON.parse is about to run on a large string, since
// that synchronous parse can stall the main thread long enough to look like
// a hang (spinner + elapsed clock both stalling).
const TOOL_ARGS_SIZE_DIAGNOSTIC_THRESHOLD = 256 * 1024; // 256KB

// Tools that carry no side-effects and are safe to execute in parallel. These
// match the "read" group in the tool registry. `ask_user_question` is excluded
// deliberately — it interacts with the user and must remain sequential.
const READ_TOOLS = new Set([
  "read_file", "list_files", "glob", "search", "web_fetch", "web_search",
]);

// Rebuilding the stable preamble is pure string concatenation, but it's still
// wasted work every turn when nothing it depends on has changed — and more
// importantly, recomputing it is how a would-be-stable prefix accidentally
// drifts. Cache it keyed on the primitive inputs that feed buildStablePreamble;
// reuse the previous string when they're unchanged (mode/skills are stable
// object references across turns, only reassigned on explicit mode/skill
// switches). One CLI process runs one agent loop at a time, so a module-level
// cache is safe here.
let stableCache: { mode?: ModeConfig; workingDir: string; skills?: SkillDef[]; agents?: AgentDef[]; agentInstructions?: string; memory?: string; repomap?: string; text: string } | undefined;

function getStablePreamble(ctx: PromptContext): string {
  if (
    stableCache &&
    stableCache.mode === ctx.mode &&
    stableCache.workingDir === ctx.workingDir &&
    stableCache.skills === ctx.skills &&
    stableCache.agents === ctx.agents &&
    stableCache.agentInstructions === ctx.agentInstructions &&
    stableCache.memory === ctx.memory &&
    stableCache.repomap === ctx.repomap
  ) {
    return stableCache.text;
  }
  const text = buildStablePreamble(ctx);
  stableCache = { mode: ctx.mode, workingDir: ctx.workingDir, skills: ctx.skills, agents: ctx.agents, agentInstructions: ctx.agentInstructions, memory: ctx.memory, repomap: ctx.repomap, text };
  return text;
}

export type AgentResult = {
  messages: Message[];
  newMessages: Message[];
  stopReason: "done" | "aborted" | "max_turns";
};

export interface AgentOptions {
  provider: Provider;
  tools: ToolDef[];
  executeTool: ToolExecutor;
  permissions?: PermissionEngine;
  /**
   * The capability-boundary gate (permission-profile.md §4, decision L):
   * profile first, then the rule engine. Absent (feature off) → the engine
   * alone decides, today's behavior byte-for-byte.
   */
  permissionProfile?: ProfileEvaluator;
  /**
   * How the command risk classifier acts on its verdict
   * (docs/command-risk-classifier.md §9): `off`, `shadow` (label and log only
   * — the default when unset), or `enforce` (clamp live). Absent is treated as
   * `shadow`, so a caller that has not been taught about the classifier still
   * produces the shadow rows the phase-1 review needs.
   */
  classifierMode?: RiskMode;
  /**
   * The classifier's optional model stage (docs/command-risk-classifier.md §6).
   * Absent means rules-only. Built by the composition root
   * (`providers/risk-judge.ts`), so this module never learns about providers.
   */
  classifierModel?: Stage2Options;
  /**
   * The auto posture (docs/command-risk-classifier.md §1.4–1.5). While
   * `isActive()` is true, the gate decides the asks the rules left to a human:
   * read-only calls and edits inside the write set run, a rules `block` is
   * denied, and a model judge allows or blocks the rest; anything it cannot
   * decide falls back to the ordinary prompt. Absent or inactive leaves the
   * gate exactly as it is without auto. Built by the composition root.
   */
  autoMode?: AutoModeOptions;
  mode?: ModeConfig;
  compactor?: Compactor;
  diagnostics?: DiagnosticRunner;
  /**
   * Native language-server support. Present when at least one server is
   * configured (`resolveLspServers`); the loop then asks it for diagnostics on
   * the files each successful write tool touched and appends them to that
   * call's own result. Absent → no diagnostics, no cost.
   */
  lsp?: LspManager;
  errorReflector?: ErrorReflector;
  errorRecovery?: ErrorRecovery;
  /**
   * Cap on model requests for this turn (one request per loop iteration).
   * Defaults to unlimited: an interactive turn ends on completion, a loop
   * detection, the five-consecutive-failure stop, or Esc — a fixed cap only
   * truncated long legitimate work. Headless `-p` and subagents pass their own
   * explicit bounds (100 and `maxSubTurns`); `--max-turns` still caps here when
   * given.
   */
  maxTurns?: number;
  /** Advisory: remind once when attempt_completion follows an unverified edit (docs/todo.md D2). */
  completionGate?: boolean;
  /** Request-time trimming of old tool results (compaction/context-editing.ts). Default off — see the call site. */
  contextEditing?: boolean;
  /** Context-window ceiling used as budgetMax for per-turn token rows. Defaults to 128000, the codebase-wide fallback. */
  contextWindow?: number;
  skills?: SkillDef[];
  /** Re-read per sub-turn: the persisted plan artifact (docs/todo.md D6), so it survives compaction like the todo block. */
  getPlan?: () => string | undefined;
  /** Loaded agent definitions — their name+description index joins the stable
   *  preamble so the model knows the names new_task accepts (feature-plans.md §F4). */
  agents?: AgentDef[];
  /** Agent-definition instructions, prepended to the stable preamble. */
  agentInstructions?: string;
  /** Precomputed session-stable repository-map snapshot (see buildRepoMap). */
  repomap?: string;
  /** Process-start `git status --porcelain` snapshot for dirty-file tagging. */
  dirtyBaseline?: string;
  /** Precomputed research-notes block (see loadProjectResearch). Plan-mode only. */
  research?: string;
  memory?: string;
  memoryStore?: MemoryStore;
  sessionStore?: SessionStore;
  sessionId?: string;
  signal?: AbortSignal;
  effort?: string;
  thinkingEnabled?: boolean;
  history?: Message[];
  imageUrls?: string[];
  planMode?: boolean;
  onText?: (chunk: string) => void;
  onReasoning?: (chunk: string) => void;
  onToolStart?: (name: string, args: Record<string, unknown>) => void;
  onToolResult?: (name: string, result: ToolOutput) => void;
  onDiagnostic?: (msg: string) => void;
  onRetry?: (msg: string) => void;
  onCompacted?: (msg: string) => void;
  onLoopDetected?: (msg: string) => void;
  onMaxTurns?: (messages: Message[], requests: number) => void;
  onUsage?: (input: number, output: number, cached?: number) => void;
  /**
   * Every permission decision the gate resolved, whether or not a session
   * store exists to persist it. Headless `-p` runs write no session, so this
   * is the only way a caller outside the loop (the eval harness) can see what
   * the agent was allowed to do (docs/eval-harness.md §3).
   */
  onPermissionDecision?: (row: PermissionAuditRecord) => void;
  /**
   * Interactive approval bridge for ask-tier calls. Resolves true (approved)
   * or false (denied); resolves "posture" when the UI allowed the call without
   * showing a prompt (an edit inside the profile write set) — recorded as
   * allow-by-posture in the audit trail (permission-spec.md §11); resolves
   * "envelope-grant" when the user chose the session-wide sandboxed-Bash grant
   * that `envelope` describes (docs/permission-ux-redesign.md). `envelope` is
   * passed only on an ask the grant may satisfy — a prompter that never offers
   * the option simply ignores it. `origin` is present when the ask comes from a
   * sub-agent rather than the root run, so the prompt can say whose call it is.
   * `autoHandoff` is present only under the auto posture, when auto handed the
   * call to a human because of a hard stop or a paused session: the prompter
   * must show the real prompt and must NOT resolve "posture" (the write-set
   * overlay), because "ask me" was the answer. Absent in every other case, and
   * a prompter that never reads it keeps its old behaviour.
   */
  askUser?: (
    toolName: string,
    args: Record<string, unknown>,
    envelope?: BashEnvelope,
    origin?: { subagent: string },
    /**
     * What the risk classifier read (always, when it ran), and — only when it
     * is why this call is stricter — the sentence saying so.
     */
    policyRisk?: { tier: string; reasons: string[]; message?: string },
    autoHandoff?: AutoHandoff,
  ) => Promise<boolean | "posture" | "envelope-grant">;
  /**
   * Set by the orchestrator on a sub-agent's run: the label the permission
   * prompt shows so a user can tell a background task's ask from the main
   * conversation's. Undefined for the root run.
   */
  askOrigin?: { subagent: string };
  /**
   * The containment this run's foreground Bash calls would execute under —
   * present exactly when this session has an active sandbox envelope
   * (`hasActiveSandboxContainment`), absent otherwise. Passing it is what makes
   * a run eligible to reuse or create a session grant, so it is set by the
   * interactive root run only: subagent runs and headless exec runs are never
   * handed one, and the grant therefore cannot be inherited by delegated or
   * autonomous work.
   */
  bashEnvelope?: BashEnvelope | (() => BashEnvelope | undefined);
  /** Live reader for the update_todo_list store; injected into the volatile
   *  prefix each sub-turn so the model always sees current plan state. */
  getTodos?: () => TodoItem[];
  /**
   * Mid-turn steering mailbox: polled once before each provider call (a
   * decision point — never mid-stream). A non-null result is injected as a
   * "User message (typed mid-turn): …" block in that call's volatile prefix
   * and pushed to `messages` as a real user message, so the session record
   * stays honest. A hit is consumed — the next poll returns whatever the
   * mailbox holds then.
   */
  pollSteeringMessage?: () => string | null;
  /** Lifecycle hooks dispatcher (docs/hooks-spec.md). Hooks only ever see
   *  calls that survived rule resolution (§5); a hook deny routes through the
   *  permission engine as deny-by-rule / ask-denied. */
  hooks?: HookRunner;
}

/**
 * Recognise transient network/fetch errors that should surface as a diagnostic
 * instead of a fatal crash. These are distinct from AbortError (user-initiated)
 * but equally recoverable — the user can retry the same prompt.
 *
 * TypeError is the name Node's undici fetch assigns to a "terminated" error
 * (HTTP/2 stream reset, connection drop), hence we must inspect the message
 * rather than just the error name.
 *
 * Walks the `cause` chain: the AI SDK wraps underlying fetch errors in
 * APICallError, so the ECONNRESET may be nested one or two levels down.
 */
function isTransientNetworkError(err: Error): boolean {
  for (let e: Error | undefined = err; e; e = (e as any).cause as Error | undefined) {
    // undici TypeError: terminated (HTTP/2 GOAWAY, stream reset, ECONNRESET)
    if (e.name === "TypeError" && e.message.includes("terminated")) return true;
    // Node.js system errors with typical transient codes
    const code = (e as any).code as string | undefined;
    if (code === "ECONNRESET" || code === "ECONNREFUSED" || code === "ETIMEDOUT" || code === "ENOTFOUND") return true;
    // undici errors surfaced as TypeError with fetch-related messages
    if (e.name === "TypeError" && /fetch\s+failed/i.test(e.message)) return true;
    // AI SDK APICallError — check its URL/message for transient indicators
    if (e.name === "AI_APICallError" && /ECONNRESET|ECONNREFUSED|ETIMEDOUT|terminated/i.test(e.message)) return true;
  }
  return false;
}

/**
 * The text of a tool result as it enters message history — and, because the
 * user should see what the model sees, as the TUI previews it (`App.tsx`
 * onToolResult imports this rather than rebuilding it).
 *
 * A failing result keeps the tool's own output under the error line. It used
 * to be dropped (`result.error ? \`Error: ${result.error}\` : result.content`),
 * so every failure reached the model as a bare line — `Error: Exit code: 1`
 * with no stderr, no `<error_analysis>` block, and no sandbox hint — which the
 * 2026-10-10 onramp logs show costing the model extra calls to rediscover what
 * the output already said (src/tools/sandbox-hint.ts documents one such case).
 * A tool that returns `content: ""` on error is byte-identical to before.
 *
 * The content is used as-is: handlers already wrapped it in the untrusted
 * delimiters, and nib's own notes (the sandbox hint) sit after them.
 */
/**
 * The volatile note for a message that arrived mid-turn. It states the fact and
 * asks for one answer; the message itself is already pushed into the request as
 * a real user message (which may be long — a mid-turn `/skill <name> <text>`
 * injects a whole SKILL.md body), so repeating even its first line would send
 * the same thing twice and invite answering it twice.
 */
const STEERING_NOTE =
  "The user's latest message was typed while you were working. Answer it once, then continue the task.";

export function toolResultForHistory(result: Pick<ToolOutput, "content" | "error">): string {
  if (!result.error) return result.content;
  return result.content.trim() !== ""
    ? `Error: ${result.error}\n${result.content}`
    : `Error: ${result.error}`;
}

export async function runAgent(
  userMessage: string,
  options: AgentOptions,
): Promise<AgentResult> {
  const { provider, tools, executeTool, permissions, permissionProfile, compactor, diagnostics, errorReflector, errorRecovery, maxTurns = Infinity, effort, thinkingEnabled } = options;
  const completionGate = options.completionGate ? new VerificationGate() : undefined;

  /**
   * Paths this session's own write tools produced, for the risk classifier's
   * "does this delete something that predates the session" question (§4.2
   * `preSessionTarget`). Session-scoped and lexical — the classifier resolves
   * a delete target the same way, so the two spellings always meet.
   */
  const createdThisSession = new Set<string>();

  /**
   * The user turns the classifier may read (§3.1). Built here rather than
   * filtered out of `messages` later — see pushHumanTurn.
   */
  const humanTurns: string[] = [];
  pushHumanTurn(humanTurns, userMessage);

  const promptCtx: PromptContext = {
    mode: options.mode,
    workingDir: process.cwd(),
    skills: options.skills,
    agents: options.agents,
    agentInstructions: options.agentInstructions,
    repomap: options.repomap,
    dirtyBaseline: options.dirtyBaseline,
    memory: options.memory,
    research: options.research,
    planMode: options.planMode,
    lspServersAvailable: options.lsp?.hasServers === true,
  };
  const promptAssemblyStart = Date.now();
  const stablePreamble = getStablePreamble(promptCtx);
  let volatileContext = await buildVolatileContext(promptCtx);

  // Overhead the compaction check must account for beyond `messages` itself.
  // Stable for the session, so computed once here rather than per turn. Shares
  // estimateOverheadTokens with the status bar meter and /context so all three
  // measure the same payload.
  const compactionOverheadTokens = estimateOverheadTokens(tools, volatileContext);

  logTiming({
    phase: "prompt_assembly",
    promptBytes: stablePreamble.length + volatileContext.length,
    estimatedTokens: Math.ceil((stablePreamble.length + volatileContext.length) / 4) + compactionOverheadTokens,
    toolCount: tools.length,
    durationsMs: { total: Date.now() - promptAssemblyStart },
  });

  let messages: Message[] = options.history ? [...options.history] : [];
  // Loaded history can carry an unanswered tool call from an earlier run that
  // ended mid-batch. Repair it here, before `newStart` is taken, so the index
  // stays honest and the backfill never lands inside the already-persisted
  // region.
  repairOrphanedToolCalls(messages);
  // The system prompt lives at position 0 only, and holds only the stable
  // preamble — replacing it every turn with byte-identical content (the
  // common case) is a no-op for the provider's prefix cache. Volatile context
  // (RepoMap, plan-mode instruction, env/git) is appended only in the request
  // sent to the provider (see appendVolatile below), never stored on
  // `messages`, so it reaches the model every turn without ever mutating the
  // cached system prefix or polluting history.
  if (messages[0]?.role === "system") messages.shift();
  messages.unshift({ role: "system", content: stablePreamble });
  messages.push({ role: "user", content: userMessage, ...(options.imageUrls?.length ? { imageUrls: options.imageUrls } : {}) });
  const newStart = messages.length;
  const newMessages: Message[] = [];
  let newCursor = newStart;
  // Tool results are fresh until a provider request has successfully consumed
  // them. A single assistant response may create a batch larger than the
  // normal retained-three window, so freshness cannot be inferred by position.
  const freshToolResults = new Set<Message>();

  function appendFreshToolResult(toolCallId: string, toolName: string, content: string): void {
    const message: Message = { role: "tool", toolCallId, toolName, content };
    messages.push(message);
    freshToolResults.add(message);
  }

  // Compaction replaces `messages` with a shorter array, so a single numeric
  // slice boundary cannot track current-turn records across it. Capture the
  // append-only session delta before replacement, then restart the cursor on
  // the compacted live context.
  function captureNewMessages(): void {
    newMessages.push(...messages.slice(newCursor));
    newCursor = messages.length;
  }

  // Volatile context is injected only into the request sent to the provider,
  // never into the stored `messages` array — otherwise it would accumulate in
  // history and bake stale RepoMap/env snapshots into every past user turn.
  // Reattach it each sub-turn so it reaches the model on every streamChat call
  // this turn.
  //
  // It is APPENDED as a trailing message rather than merged into the last
  // user-role one. Merging rewrites a message the provider has already seen:
  // the turn's opening user message carries the prefix on this turn and not on
  // the next, so the provider's cached prefix is invalidated from that index
  // onward — the whole conversation — on every turn's first request. Appending
  // leaves every earlier message at the same index with the same bytes, so the
  // stable prefix only ever grows and the volatile tail is the only part that
  // changes. (See `request prefix stability` in agent.test.ts.)
  // The block stays on the USER role deliberately. It carries filesystem- and
  // repo-derived text (git status lists file paths), so the system role would
  // promote attacker-influenceable strings to instruction authority; as user
  // content it keeps the trust level it had when it was merged into the user's
  // message. `volatile: true` is what keeps it distinguishable from the user's
  // own words, since its content can no longer be told apart by position alone.
  function appendVolatile(msgs: Message[], prefix: string): Message[] {
    if (!prefix) return msgs;
    return [...msgs, { role: "user", content: prefix, volatile: true }];
  }

  // Shared by the pre-request check (before provider.streamChat, so an
  // oversized request never goes out) and the end-of-turn check (catches
  // growth from tool results within the turn). Reassigns the outer `messages`
  // in place; `compactor.compact()` itself early-returns as a no-op when
  // `needsCompaction` is false, so calling this when nothing changed is cheap.
  async function maybeCompact(overheadTokens: number): Promise<void> {
    if (!compactor || !compactor.needsCompaction(messages, overheadTokens)) return;
    const persistedCount = options.sessionStore && options.sessionId
      ? await options.sessionStore.getMessageCount(options.sessionId)
      : 0;
    const before = messages.length;
    // PreCompact hooks run immediately before the compactor; their stdout is
    // appended to the compaction prompt (hooks-spec.md §2).
    const preCompact = options.hooks ? await options.hooks.dispatch("PreCompact", {}) : undefined;
    captureNewMessages();
    messages = await compactor.compact(
      messages,
      preCompact?.stdout ?? undefined,
      overheadTokens,
    );
    if (messages[0]?.role !== "system") {
      // Reinsert the stable preamble only — no volatile RepoMap/env here,
      // consistent with the per-turn path above (the next user turn will
      // carry fresh volatile context of its own).
      const rebuiltPrompt = getStablePreamble({
        mode: options.mode,
        workingDir: process.cwd(),
        skills: options.skills,
        agents: options.agents,
        agentInstructions: options.agentInstructions,
        repomap: options.repomap,
        memory: options.memory,
        lspServersAvailable: options.lsp?.hasServers === true,
      });
      messages.unshift({ role: "system", content: rebuiltPrompt });
    }
    newCursor = messages.length;
    if (options.sessionStore && options.sessionId && persistedCount > 0) {
      const { summary, files } = compactor.getLastCompaction();
      const compactionSummary: CompactionSummary = {
        task: summary ?? "Conversation summarized.",
        decisions: [],
        files,
        errors_resolved: [],
      };
      await options.sessionStore.appendCompaction(
        options.sessionId,
        persistedCount - 1,
        compactionSummary,
      );
    }
    if (options.hooks) await options.hooks.dispatch("PostCompact", {});
    options.onCompacted?.(`${before} → ${messages.length} messages`);
  }

  let stopReason: "done" | "aborted" | "max_turns" = "done";
  let turn = 0;
  let turnEnded = false;
  // One-shot guard for the empty-response retry below: a stream that ends with
  // no text, no reasoning, and no tool calls is a transient provider hiccup,
  // not a finished turn — retry once before giving up.
  let emptyResponseRetried = false;
  // One-shot guard for the announced-but-unperformed-action nudge below: a
  // model that ends a turn on a colon (e.g. "Let me check the file:") has
  // signaled a tool call it never made — nudge it back once rather than
  // silently treating the preamble as a finished answer.
  let unfinishedIntentNudged = false;
  // Cross-turn dedup for ask_user_question: the model sometimes repeats the
  // same question in a later turn. Track the exact question+options key and
  // inject a system note if it's asked again — the note tells the model it
  // already asked and got an answer, preventing redundant prompts.
  const askedQuestions = new Set<string>();
  while (turn < maxTurns && !turnEnded) {
    if (options.signal?.aborted) {
      stopReason = "aborted";
      break;
    }
    const seenCalls = new Map<string, number>();
    const currentEnvelope = (): BashEnvelope | undefined =>
      typeof options.bashEnvelope === "function" ? options.bashEnvelope() : options.bashEnvelope;
    let failedStreak = 0;
    let warnedRepeat = false;
    let warnedFailures = false;

    try {
    turn++;
    errorReflector?.resetTurn();
    errorRecovery?.reset();

    let content = "";
    let reasoning = "";
    let turnTokens = 0;
    const pendingCalls: Map<string, { name: string; args: string }> = new Map();

    // Pre-request compaction: catches an oversized context BEFORE it goes out
    // (the end-of-turn check below only shrinks context for the NEXT turn).
    // Recomputes requestMessages from `messages` after this, so the request
    // reflects the compacted set.
    await maybeCompact(compactionOverheadTokens);

    try {
    // The env block's git line goes stale the moment a tool edits a file, so
    // every request after the first re-runs it (the first reuses the build
    // above). It lives only in the request-only tail, so rebuilding it never
    // touches the cached prefix.
    if (turn > 1) volatileContext = await buildVolatileContext(promptCtx);
    // Live todo block: the todo list also changes mid-turn, so it is re-read and
    // appended here per sub-turn — same appendVolatile mechanism, one extra section.
    const todoBlock = options.getTodos ? formatTodoBlock(options.getTodos()) : "";
    // Persisted plan (docs/todo.md D6): same mechanism as the todo block —
    // re-read per sub-turn into the request-only tail, so compaction cannot
    // drop it and an amended plan file is picked up on the next request.
    const planBlock = options.getPlan ? formatPlanBlock(options.getPlan() ?? "") : "";
    // Mid-turn steering mailbox: poll once per decision point; a hit joins the
    // volatile assembly below AND is pushed to `messages` as a real user
    // message. Pushed at the poll site (not flushed after the turn) so the
    // conversation order stays honest — the message sits before the
    // assistant/tool messages that respond to it — and newMessages/
    // onNewMessages persistence picks it up automatically.
    const steering = options.pollSteeringMessage?.() ?? null;
    if (steering) {
      messages.push({ role: "user", content: steering });
      pushHumanTurn(humanTurns, steering);
    }
    // The note says the message arrived and asks for one answer — it does not
    // repeat the message. It used to echo the first line, so in the request
    // that carried the question the question appeared twice, and the model
    // answered it twice: once to the note, once to the message, both before a
    // tool call (2026-10-10, onramp 1117-ecdc).
    const prefix = [volatileContext, todoBlock, planBlock, steering ? STEERING_NOTE : ""].filter(Boolean).join("\n\n");
    const orphaned = repairOrphanedToolCalls(messages);
    if (orphaned > 0) {
      options.onDiagnostic?.(`backfilled ${orphaned} unanswered tool result${orphaned === 1 ? "" : "s"}`);
    }
    const assembledMessages = appendVolatile(messages, prefix);
    // The volatile prefix is already present in assembledMessages, so only
    // tool-schema overhead is added here. This request-only copy deliberately
    // leaves messages/newMessages/session history complete and unedited.
    // Request-time trimming of old tool results is OFF unless asked for. It
    // rewrote the 4th-newest result into a placeholder on every request once
    // it engaged, and the provider's prefix cache ends at the first changed
    // message — measured 2026-10-10 in onramp: 78% of a session's cache misses
    // (1.16M of 1.49M tokens) came from that slide. With cached input ~50x
    // cheaper than uncached (DeepSeek), keeping results verbatim and leaving
    // size control to compaction is cheaper. A batched variant can re-enable it.
    const requestMessages = options.contextEditing
      ? editToolResultsForRequest(assembledMessages, estimateOverheadTokens(tools), freshToolResults)
      : assembledMessages;
    // What nib thinks this request costs; the provider's usage report for it
    // calibrates the compaction trigger. requestMessages already carries the
    // volatile tail, so only the tool schemas are added on top.
    const requestEstimate = estimateTokens(requestMessages) + estimateOverheadTokens(tools);
    for await (const event of provider.streamChat(requestMessages, tools, { signal: options.signal, effort, thinkingEnabled })) {
      switch (event.type) {
        case "text_delta":
          content += event.content;
          options.onText?.(event.content);
          break;
        case "reasoning_delta":
          reasoning += event.content;
          options.onReasoning?.(event.content);
          break;
        case "tool_call_start":
          pendingCalls.set(event.id, { name: event.name, args: "" });
          break;
        case "tool_call_delta": {
          const entry = pendingCalls.get(event.id);
          if (entry) entry.args += event.arguments;
          break;
        }
        case "usage":
          turnTokens += event.inputTokens + event.outputTokens;
          compactor?.observeUsage(requestEstimate, event.inputTokens);
          options.onUsage?.(event.inputTokens, event.outputTokens, event.cachedInputTokens);
          break;
        case "model_alias":
          // The provider served a different model than requested. App.tsx
          // renders every diagnostic with its own "⚠ " prefix, so this text
          // must NOT carry one. /model is the switch command the TUI lists.
          options.onDiagnostic?.(
            `${event.provider} serves "${event.requested}" as "${event.served}" — switch with /model ${event.provider}/${event.served}`,
          );
          break;
        case "done":
          break;
      }
    }
    // The provider has received the full fresh batch. Keep later request
    // copies bounded by treating these results as consumed from now on.
    freshToolResults.clear();
    } catch (err) {
      if (err instanceof Error && (err.name === "AbortError" || (err as any).name === "AbortError")) {
        options.onDiagnostic?.("aborted by user");
        stopReason = "aborted";
        break;
      }
      // Transient network/connection errors (e.g. ECONNRESET, "terminated") are
      // recoverable — surface them as a diagnostic so the user sees what happened
      // and can retry, rather than crashing with a raw stack trace.
      if (err instanceof Error && isTransientNetworkError(err)) {
        options.onDiagnostic?.(`connection lost: ${err.message}`);
        stopReason = "aborted";
        break;
      }
      // Provider stream failures (auth, HTTP, network) have deliberate handling
      // by the caller — headless surfaces them as a non-zero exit, the TUI shows
      // the error. errorRecovery.handleFatalError is for *unexpected* faults in
      // the rest of the turn body (tool loop, compaction, diagnostics), not for
      // these. Tag the error so the outer recovery catch re-throws it untouched.
      (err as any).__providerStreamError = true;
      throw err;
    }

    if (content) options.onText?.("\n");

    if (reasoning) messages.push({ role: "assistant", content: reasoning, meta: { asThinking: true } });

    // One token-usage row per turn: turnTokens is the provider-reported
    // input+output for this turn; totalUsed mirrors what compaction measures
    // (estimateTokens of the live message set, calibrated) so remaining = budgetMax -
    // totalUsed agrees with the compaction headroom; budgetMax is the context
    // window. remaining is derived on read, never stored.
    const recordTokens = async (): Promise<void> => {
      if (!options.sessionStore || !options.sessionId) return;
      await options.sessionStore.appendToken(options.sessionId, {
        turnTokens,
        totalUsed: Math.round(estimateTokens(messages) * (compactor?.tokenCalibration ?? 1)),
        budgetMax: options.contextWindow ?? 128000,
      });
    };

    if (pendingCalls.size === 0) {
      // A trailing colon on the final line is the signature of an announced
      // action ("Let me read the file:") that never actually happened — the
      // model stopped instead of following through with the tool call.
      if (content && /:\s*$/.test(content.trim()) && !unfinishedIntentNudged) {
        unfinishedIntentNudged = true;
        messages.push({ role: "assistant", content });
        messages.push({
          role: "system",
          content: "You ended your turn without calling a tool, right after announcing an action. Either make the tool call you just described, or give a complete final answer.",
        });
        options.onDiagnostic?.("turn ended on an announced-but-unperformed action — nudging once");
        await recordTokens();
        continue;
      }
      if (!content && !reasoning) {
        if (!emptyResponseRetried) {
          emptyResponseRetried = true;
          options.onDiagnostic?.("empty response from provider — retrying once");
          continue;
        }
        options.onText?.("[empty response from provider]\n");
      }
      if (content) messages.push({ role: "assistant", content });
      await recordTokens();
      break;
    }

    const toolCalls: ToolCall[] = [];
    let retryWithCorrection = false;

    for (const [id, tc] of pendingCalls) {
      let args: Record<string, unknown> = {};
      if (tc.args.length > TOOL_ARGS_SIZE_DIAGNOSTIC_THRESHOLD) {
        options.onDiagnostic?.(`large tool call args (${tc.args.length} bytes) for ${tc.name}`);
      }
      try {
        args = JSON.parse(tc.args || "{}");
      } catch {
        if (tc.args && errorRecovery) {
          const correctionMsg = errorRecovery.handleParseError(tc.args);
          if (correctionMsg) {
            messages.push({ role: "assistant", content: content || null });
            messages.push({ role: "system", content: correctionMsg });
            retryWithCorrection = true;
            break;
          }
        }
        args = { _raw: tc.args };
      }
      toolCalls.push({ id, name: tc.name, arguments: args });
    }

    if (retryWithCorrection) continue;

    messages.push({
      role: "assistant",
      content: content || null,
      toolCalls,
    });

    await recordTokens();

    await diagnostics?.snapshot();

    // Pre-resolve every call once so the partition below is decided from a
    // single snapshot (resolve is pure — no side effects). The partition
    // only decides which reads may run concurrently; each call is resolved
    // again at execution time, so a mid-batch session-rule approval (from a
    // prompt in this same batch) still applies to the calls after it. The
    // composed authorize() runs the profile gate (layer 1) first, so a
    // profile-denied read is never partitioned into the parallel set.
    const resolved = new Map<string, ResolveResult>();
    if (permissions) {
      for (const tc of toolCalls) {
        resolved.set(tc.id, authorize({ tool: tc.name, arguments: tc.arguments }, permissions, permissionProfile));
      }
    }

    // Fast path: partition, don't bail — when the batch holds at least one
    // pre-allowed read, those reads execute concurrently via
    // Promise.allSettled and everything else (writes, asks, denies,
    // unallowed reads) is processed sequentially afterwards in the
    // assistant's original call order. Multi-file reads are the common
    // case — without this, three read_file calls take 3×RTT serially. A
    // batch with no allowed reads has nothing to parallelize and stays
    // fully sequential.
    const parallelReads = toolCalls.filter((tc) => {
      if (!READ_TOOLS.has(tc.name)) return false;
      if (!permissions) return true;
      return resolved.get(tc.id)?.action === "allow";
    });
    const canRunParallel = toolCalls.length > 1 && parallelReads.length > 0;

    // Lifecycle hooks (hooks-spec.md §5): hooks only ever see calls that
    // survived rule resolution, and they can only narrow what survives —
    // a hook `allow` can never upgrade a rule-derived ask.
    const hookBlocks = async (tc: ToolCall, event: "PreToolUse" | "PermissionRequest"): Promise<boolean> => {
      if (!options.hooks) return false;
      const r = await options.hooks.dispatch(event, { tool_name: tc.name, tool_input: tc.arguments });
      return r.blocked;
    };
    const hookDenied = (tc: ToolCall, event: "PreToolUse" | "PermissionRequest"): void => {
      const msg = `PERMISSION_DENIED: denied by ${event} hook`;
      options.onDiagnostic?.("denied");
      appendFreshToolResult(tc.id, tc.name, msg);
    };

    /**
     * Pre-execution gate for one call: permission resolution + the
     * PreToolUse/PermissionRequest hooks. Returns `denied: true` when the
     * call is denied — the audit row and the PERMISSION_DENIED tool message
     * are recorded here, so the deny is real (nothing executes afterwards)
     * and the audit row tells the truth. Returns `denied: false` when the
     * call may execute, optionally carrying the per-call execution grant
     * (`exec`) that only an explicit interactive approval of this call can
     * produce. Runs exactly once per call: the parallel path gates its reads
     * BEFORE executing them (fix 3), the sequential path gates immediately
     * before execution.
     */
    const gateCall = async (tc: ToolCall): Promise<{ denied: boolean; exec?: ToolExecOptions }> => {
      // Set only on the explicit-approval path below; see the ask branch.
      let exec: ToolExecOptions | undefined;
      if (permissions) {
        // The one composed permission surface (permission-profile.md §4,
        // decision L): the profile gate (layer 1) denies terminally before
        // rule resolution — no profile (feature off) passes straight through
        // to the unchanged engine, so today's behavior is byte-for-byte.
        const { action: resolvedAction, winningRule, wasUnresolved, reason, isGuarded } = authorize(
          { tool: tc.name, arguments: tc.arguments },
          permissions,
          permissionProfile,
        );
        // A shell call that leaves the OS sandbox (sandbox/unsandboxed.ts). It
        // takes no envelope grant — there is no profile to bind consent to —
        // and is never quieted by an allow rule: whether the model asked for it
        // or sandbox.excludedCommands matched, it is always asked about.
        const unsandboxedKind = unsandboxedRun(tc.name, tc.arguments);
        // What the engine decided on its own: a shell call that leaves the OS
        // sandbox is always asked about, whatever a rule said.
        const engineAction = unsandboxedKind !== undefined && resolvedAction === "allow" ? "ask" : resolvedAction;
        const subject = permissionSubjectText(tc.name, tc.arguments);

        // The risk classifier (docs/command-risk-classifier.md §9). Built per
        // call, not cached: a session grant approved mid-turn changes the
        // envelope, and the write-set it carries changes with it. In shadow
        // mode nothing below reads `action` from it — the verdict rides on the
        // audit row only. An unset mode is shadow, so a caller that has not
        // been taught about the classifier still produces the shadow rows.
        const riskMode: RiskMode = options.classifierMode ?? "shadow";
        // Auto needs the rules' verdict whatever the classifier mode says, and
        // it is the judge: the cheap stage-2 model must not also run on the
        // same call, so it is not handed over while auto is active.
        const autoMode = options.autoMode?.isActive() === true ? options.autoMode : undefined;
        const riskInput: RiskInput | undefined =
          riskMode === "off" && autoMode === undefined
            ? undefined
            : {
                tool: tc.name,
                args: tc.arguments,
                workingDir: process.cwd(),
                writeRoots: permissionProfile?.writeRoots ?? [process.cwd()],
                sandbox: {
                  level: currentEnvelope()?.level ?? permissionProfile?.level ?? "unrestricted",
                  contained: currentEnvelope() !== undefined,
                },
                ...(unsandboxedKind !== undefined ? { unsandboxed: unsandboxedKind } : {}),
                engine: { action: engineAction, winningRule, wasUnresolved, isGuarded },
                session: {
                  headless: options.askUser === undefined,
                  userMessages: humanTurns,
                  createdThisSession,
                  ...(autoMode !== undefined
                    ? {
                        sessionUserMessages: autoMode.humanTurns(),
                        priorToolCalls: priorToolCalls(messages, tc.id),
                        ...(autoMode.delegatedTask !== undefined ? { delegatedTask: autoMode.delegatedTask } : {}),
                      }
                    : {}),
                },
              };
        const riskVerdict =
          riskInput === undefined
            ? undefined
            : await classifyRiskWithModel(riskInput, autoMode !== undefined ? undefined : options.classifierModel);

        // §3.3's clamp, applied after the unsandboxed override and before the
        // audit row, so the row describes the decision that was actually taken.
        // Outside enforce mode applyRiskVerdict is the identity. Auto denies a
        // rules `block` in every mode (an engine deny keeps its own message).
        // A credential variable sent over the network is the one block the
        // judge decides instead (isJudgeableBlock): it is an ask, whatever a
        // user allow rule or the classifier mode would have said.
        const autoJudgesBlock =
          autoMode !== undefined && riskVerdict !== undefined && engineAction !== "deny" && isJudgeableBlock(riskVerdict);
        const autoRulesBlock =
          autoMode !== undefined && riskVerdict?.tier === "block" && engineAction !== "deny" && !autoJudgesBlock;
        const action = autoRulesBlock
          ? "deny"
          : autoJudgesBlock
            ? "ask"
            : applyRiskVerdict(engineAction, riskVerdict, riskMode);

        /**
         * Whether the classifier *acted* on this call: it applied a clamp, which
         * takes enforce mode. Kept separate from what it *read*, because the two
         * are shown differently and, under `shadow`, only one of them is true —
         * a shadow verdict never made anything stricter, so a prompt must not
         * say it did.
         */
        const riskActed =
          riskMode === "enforce" && riskVerdict !== undefined && riskNarrowed(engineAction, riskVerdict);

        /**
         * What the prompt is shown about the classifier: its tier and reason
         * tags whenever it ran (advisory — the user can see the read even in
         * shadow mode), plus the sentence explaining *why this call is stricter*
         * only when it is what made it stricter.
         */
        const policyRisk =
          riskVerdict === undefined
            ? undefined
            : {
                tier: riskVerdict.tier,
                reasons: riskVerdict.reasons,
                ...(riskActed && riskVerdict.message !== undefined ? { message: riskVerdict.message } : {}),
              };

        // The auto gate's trace for this call, set when it falls back to a
        // prompt so the row the prompt eventually writes carries why.
        let autoTrace: AutoAuditRecord | undefined;

        const audit = async (
          decision: PermissionDecision,
          reason: string,
          envelopeGrant?: "reuse" | "granted",
          auto?: AutoAuditRecord,
        ): Promise<void> => {
          const autoRecord = auto ?? autoTrace;
          const capabilityPlan = extractCapabilityPlan(tc.name, tc.arguments, process.cwd());
          const record: PermissionAuditRecord = {
            toolCallId: tc.id, tool: tc.name, subject, decision, winningRule, reason,
            ...(envelopeGrant !== undefined ? { envelopeGrant } : {}),
            ...(capabilityPlan.commandClassification
              ? { commandClassification: capabilityPlan.commandClassification }
              : {}),
            ...(riskVerdict !== undefined ? { risk: riskVerdict } : {}),
            ...(autoRecord !== undefined ? { auto: autoRecord } : {}),
          };
          // Observed before the store write: a headless run has no store, and
          // the caller still needs the row (eval harness).
          options.onPermissionDecision?.(record);
          if (!options.sessionStore || !options.sessionId) return;
          await options.sessionStore.appendPermission(options.sessionId, record);
        };

        /** One block counted; the user hears once, on the block that pauses auto. */
        const noteAutoBlock = (): void => {
          if (autoMode?.state.recordBlock().justSuspended) {
            options.onDiagnostic?.("auto mode paused after repeated blocks: it will ask you from here on");
          }
        };

        /**
         * Auto's decision for an ask the rules left to a human: run it, deny it
         * (the tool result and audit row are already written), or hand it to the
         * ordinary prompt with a note saying why auto did not decide. Reached
         * only after the PermissionRequest hook and the envelope-grant reuse
         * have had their say.
         */
        const decideAuto = async (): Promise<AutoDecision> => {
          const am = autoMode!;
          const verdict = riskVerdict!;
          const judge = am.judgeLabel?.();
          const fallback = (auto: AutoAuditRecord, note: string, handoff?: AutoHandoff): AutoDecision => {
            autoTrace = auto;
            return { kind: "prompt", note, ...(handoff !== undefined ? { handoff } : {}) };
          };

          const stop = autoHardStop(tc.name, tc.arguments, verdict, unsandboxedKind);
          if (stop !== undefined) {
            return fallback({ stage: "fallback", outcome: "hard-stop", latencyMs: 0 }, `Auto mode: ${stop}.`, "hard-stop");
          }
          // A rule the user (or the session) wrote with action "ask" is an
          // instruction to be asked, so the judge never overrules it. Keyed on
          // the action, excluding builtin-guarded: those synthesized asks
          // (secret globs, out-of-workspace reads) are not the user's words,
          // and treating them as stops would make auto prompt for ordinary
          // work. No winning rule at all (the default mode) still goes to the judge.
          if (winningRule?.action === "ask" && winningRule.origin !== "builtin-guarded") {
            const what = winningRule.pattern !== "" ? `${winningRule.tool}: ${winningRule.pattern}` : winningRule.tool;
            return fallback(
              { stage: "fallback", outcome: "hard-stop", latencyMs: 0 },
              `Auto mode: your ask rule matched (${what}).`,
              "hard-stop",
            );
          }
          if (am.state.suspended) {
            return fallback(
              { stage: "fallback", outcome: "suspended", latencyMs: 0 },
              "Auto mode paused after repeated blocks.",
              "paused",
            );
          }
          if (
            skipsAutoJudge(tc.name) ||
            verdict.tier === "safe" ||
            permissionProfile?.editTargetInWriteSet(tc.name, tc.arguments)
          ) {
            am.state.recordAllow();
            return {
              kind: "allow",
              reason: skipsAutoJudge(tc.name)
                ? "auto mode: interactive or read-only status tool, no judge needed"
                : "auto mode: read-only call or edit inside the write set",
              auto: { stage: "readonly", outcome: "allow", latencyMs: 0 },
            };
          }

          const result = await runAutoJudge(riskInput!, verdict.features, am, options.signal);
          if (options.signal?.aborted) {
            options.onDiagnostic?.("denied");
            await audit("ask-denied", "interrupted while the auto mode judge was running", undefined, {
              stage: result.stage,
              outcome: result.outcome,
              latencyMs: result.latencyMs,
            });
            appendFreshToolResult(tc.id, tc.name, "PERMISSION_DENIED: interrupted");
            return { kind: "denied" };
          }
          const trace: AutoAuditRecord = {
            stage: result.stage,
            outcome: result.outcome,
            latencyMs: result.latencyMs,
            ...(result.tag !== undefined ? { tag: result.tag } : {}),
            ...(result.reason !== undefined ? { reason: result.reason } : {}),
            ...(judge !== undefined ? { judge } : {}),
          };
          const failed = result.outcome !== "allow" && result.outcome !== "block";
          const health = am.state.recordJudgeOutcome(judge, failed);
          if (health.justFailing) {
            options.onDiagnostic?.(
              `auto mode judge ${judge ?? "model"} failed ${health.failures} of its last ${health.calls} calls ` +
                `(${result.outcome}${result.reason !== undefined ? `: ${result.reason}` : ""}): ` +
                "each failure asks you instead. Set classifier.model.id to a different model.",
            );
          }
          if (result.outcome === "allow") {
            am.state.recordAllow();
            return { kind: "allow", reason: "auto mode judge allowed the call", auto: trace };
          }
          if (result.outcome === "block") {
            // The model is told the tag's own sentence, never the judge's text.
            await audit(
              "deny-by-classifier",
              `auto mode judge blocked the call${result.tag !== undefined ? ` (${result.tag})` : ""}`,
              undefined,
              trace,
            );
            appendFreshToolResult(tc.id, tc.name, autoBlockMessage(result.tag));
            noteAutoBlock();
            options.onDiagnostic?.(`auto mode blocked ${tc.name}: ${result.reason ?? autoBlockMessage(result.tag)}`);
            return { kind: "denied" };
          }
          return fallback(trace, `Auto mode could not decide (${result.outcome}).`);
        };

        // Shadow mode's whole product: a call the classifier would have made
        // stricter, recorded as evidence so the phase-1 review (proposal §9)
        // has a queue to read. Written only on a disagreement, never on
        // agreement — an agreement is already visible on the audit row.
        //
        // Diagnostic-only, and awaited by nobody, on the same principle as
        // onSandboxFailure above: a store that cannot record evidence must not
        // become a second failure path in the turn that is running.
        if (riskMode === "shadow" && riskVerdict !== undefined && riskNarrowed(resolvedAction, riskVerdict)) {
          void options.sessionStore
            ?.appendClassifierEvidence?.(options.sessionId!, {
              toolCallId: tc.id,
              source: "policy",
              reason: `shadow: engine ${resolvedAction}, classifier ${riskVerdict.tier} (${riskVerdict.reasons.join(", ")})`,
            })
            .catch(() => {});
        }

        /**
         * A sandboxed launch whose containment promise did not hold: the child
         * never confirmed this machine applied its profile, or it would run
         * under a different profile than the session grant was approved for.
         * The command did not run either way, so any grant covering it is
         * revoked — an approval standing against a profile Seatbelt refuses, or
         * that no longer describes the launch, is worse than no approval. The
         * Bash handler returns its own specific refusal; this only records why
         * the grant is gone. Forward-only: nothing already running is stopped
         * and no effect is undone.
         */
        const onSandboxFailure = (why: SandboxFailureReason): void => {
          const sessionId = options.sessionId;
          const revoked = sessionId !== undefined && bashEnvelopeGrants.revoke(sessionId, "run_bash");
          const cause =
            why === "containment-not-applied"
              ? "the macOS sandbox profile was not confirmed inside the child"
              : "the sandbox envelope changed after the grant was approved";
          // The handler does not wait on this write: a failure to record the
          // failure must not become a second failure path.
          void audit(
            why === "containment-not-applied" ? "sandbox-failure" : "grant-invalidated",
            revoked ? `${cause}; the session grant was revoked` : cause,
          ).catch((err: unknown) => {
            options.onDiagnostic?.(`audit write failed: ${String(err)}`);
          });
        };

        // A containment failure is a property of the launch, not of the
        // approval path, so the channel is open for every sandboxed Bash call —
        // including one a rule allowed without a prompt. Grant coverage is
        // decided separately, below.
        if ((tc.name === "run_bash" || tc.name === "run_bash_background") && currentEnvelope() !== undefined && unsandboxedKind === undefined) {
          exec = { onSandboxFailure };
        }

        // The model asked to leave the sandbox where that is switched off.
        if (unsandboxedKind === "requested" && !unsandboxedRequestsAllowed()) {
          const msg = "UNSANDBOXED_NOT_ALLOWED: running outside the sandbox is turned off here (sandbox.allowUnsandboxedCommands is false, or the level is strict-sandbox). Work within the sandbox or ask the user to run the command themselves.";
          options.onDiagnostic?.("denied");
          await audit("deny-by-rule", "unsandboxed run refused: not allowed at this level or by sandbox.allowUnsandboxedCommands");
          appendFreshToolResult(tc.id, tc.name, msg);
          return { denied: true };
        }

        // Auto: a rules `block` is a denial whatever the classifier mode is.
        if (autoRulesBlock && riskVerdict !== undefined) {
          const msg = `Permission denied. ${riskVerdict.message ?? (riskVerdict.reasons.length > 0 ? formatRiskReason("block", riskVerdict.reasons) : "Blocked by nib policy.")}`;
          options.onDiagnostic?.("denied");
          await audit(
            "deny-by-classifier",
            `denied by the risk classifier in auto mode (${riskVerdict.reasons.join(", ")})`,
            undefined,
            {
              stage: "rules",
              outcome: "block",
              latencyMs: 0,
              ...(riskVerdict.reasons[0] !== undefined ? { tag: riskVerdict.reasons[0] } : {}),
            },
          );
          appendFreshToolResult(tc.id, tc.name, msg);
          noteAutoBlock();
          return { denied: true };
        }
        if (action === "deny") {
          // A classifier block carries its reason to the model (§3.4): the
          // sentence says which rule fired and how to rewrite the call, which
          // is what keeps a block from becoming a retry loop. An engine deny
          // keeps its existing message — there the rule is the whole answer.
          const msg =
            riskActed && policyRisk?.message !== undefined
              ? `Permission denied. ${policyRisk.message}`
              : `Permission denied for ${tc.name}`;
          options.onDiagnostic?.("denied");
          // Layer 1 (profile) and layer 2 (rule) denies share the same tool
          // message; the audit row names the winning layer so the trail stays
          // one-directional (permission-spec.md §11). The row stays
          // deny-by-rule for a classifier block — it is the rule layer that
          // acted — and the verdict on the row says which rule and why.
          if (reason === "deny-by-profile") {
            await audit("deny-by-profile", "deny by profile (layer 1)");
          } else if (riskActed) {
            await audit("deny-by-rule", `denied by the risk classifier (${riskVerdict?.reasons.join(", ")})`);
          } else {
            await audit("deny-by-rule", `deny rule matched (${winningRule?.origin ?? "rule"})`);
          }
          appendFreshToolResult(tc.id, tc.name, msg);
          return { denied: true };
        }
        if (action === "ask") {
          // PermissionRequest hooks fire before the user prompt; a deny is
          // recorded as ask-denied, as if the user answered no.
          if (await hookBlocks(tc, "PermissionRequest")) {
            await audit("ask-denied", "denied by PermissionRequest hook");
            hookDenied(tc, "PermissionRequest");
            return { denied: true };
          }
          if (options.askUser) {
            // The session grant (docs/permission-ux-redesign.md). Eligibility is
            // decided before the prompt, and by the one shared definition: an
            // ineligible ask is asked exactly as it is today and the prompter is
            // not even offered the session option. A run with no session
            // identity can neither reuse nor create a grant.
            // Read now, not at run start: a capability granted earlier in the
            // session changed the profile, and the hash must describe it.
            const liveEnvelope = currentEnvelope();
            const envelope =
              options.sessionId !== undefined &&
              unsandboxedKind === undefined &&
              isEligibleForGrant({
                toolName: tc.name,
                args: tc.arguments,
                isGuarded,
                winningRuleOrigin: winningRule?.origin,
                envelope: liveEnvelope,
              })
                ? liveEnvelope
                : undefined;
            // An envelope already approved for this session needs no prompt at
            // all — that is the point of the grant, and everything above (deny,
            // guarded, hooks, profile) has already run.
            const reused =
              envelope !== undefined
                ? bashEnvelopeGrants.lookup(options.sessionId!, "run_bash", envelope.profileHash)
                : null;
            if (reused === null && envelope !== undefined) {
              // A grant exists for this session but was approved against
              // different profile bytes — a write root, the level, or the
              // scratch directory changed. It is dropped *before* the prompt, so
              // it does not survive a "no": leaving it would let the envelope
              // change back and silently re-arm an approval the user is being
              // asked to renew right now.
              if (bashEnvelopeGrants.invalidateOther(options.sessionId!, "run_bash", envelope.profileHash)) {
                await audit(
                  "grant-invalidated",
                  "session grant invalidated: the envelope it was approved against no longer matches this launch's sandbox profile",
                );
              }
            }
            // sandbox.autoAllowBash: an eligible call under a live envelope is
            // granted without a prompt — it takes the same "envelope-grant"
            // path a user's session choice would.
            //
            // `askOrigin` (the sub-agent label) and `policyRisk` (the risk
            // classifier's reason, when it is what caused this ask) are both
            // undefined on an ordinary root-run prompt, which is the shape
            // every prompter was originally written against.
            let allowed: boolean | "posture" | "envelope-grant" | "auto";
            let autoAllow: Extract<AutoDecision, { kind: "allow" }> | undefined;
            if (reused !== null) {
              allowed = true;
            } else if (envelope?.autoGrant) {
              allowed = "envelope-grant";
            } else {
              const decision = autoMode !== undefined ? await decideAuto() : undefined;
              if (decision?.kind === "denied") return { denied: true };
              if (decision?.kind === "allow") {
                allowed = "auto";
                autoAllow = decision;
              } else {
                // Auto did not decide: the user does, told why.
                const asked =
                  decision?.kind === "prompt" && policyRisk !== undefined
                    ? {
                        ...policyRisk,
                        message: policyRisk.message !== undefined ? `${decision.note} ${policyRisk.message}` : decision.note,
                      }
                    : policyRisk;
                // The handoff goes as a sixth argument only when there is one,
                // so every other ask is called exactly as before.
                const handoff = decision?.kind === "prompt" ? decision.handoff : undefined;
                allowed = await (handoff !== undefined
                  ? options.askUser(tc.name, tc.arguments, envelope, options.askOrigin, asked, handoff)
                  : options.askUser(tc.name, tc.arguments, envelope, options.askOrigin, asked));
                if (decision !== undefined && allowed === true) autoMode!.state.recordUserApproval();
              }
            }
            if (allowed === "auto" && autoAllow !== undefined) {
              // The judge (or the read-only / write-set shortcut) allowed the
              // call. Like "posture", no `exec` grant: auto approves a call,
              // never the widened profile or a git config write.
              await audit("allow-by-classifier", autoAllow.reason, undefined, autoAllow.auto);
            } else if (allowed === "posture") {
              // The UI allowed the call without showing a prompt (an edit
              // inside the profile write set) — recorded distinctly from an
              // interactive yes (permission-spec.md §11). No `exec` grant:
              // posture is an approval of a *class* of calls, never of this
              // command, and the widened profile requires the latter.
              await audit("allow-by-posture", "allowed by the UI without a prompt (edit inside the profile write set)");
            } else if (!allowed) {
              const msg = "PERMISSION_DENIED: denied by user";
              options.onDiagnostic?.("denied");
              await audit("ask-denied", "denied by user at prompt");
              appendFreshToolResult(tc.id, tc.name, msg);
              return { denied: true };
            } else if (envelope !== undefined && (reused !== null || allowed === "envelope-grant")) {
              // The call runs under the session's approved envelope. A reuse
              // shows no prompt at all; a fresh grant is the consent the user
              // just gave. Both are one audit row, because both are the same
              // decision — the difference is which one happened, recorded in
              // `envelopeGrant` so reuse and consent stay separately countable.
              if (reused !== null) {
                await audit(
                  "allow-by-envelope-grant",
                  `session grant reused (approved ${new Date(reused.grantedAt).toISOString()})`,
                  "reuse",
                );
              } else {
                // Consent for this envelope. Any grant approved against a
                // different one was dropped above, before the prompt, so this
                // writes into a slot the user has just been asked about.
                bashEnvelopeGrants.grant({
                  sessionId: options.sessionId!,
                  tool: "run_bash",
                  profileHash: envelope.profileHash,
                  level: envelope.level,
                  trustedRoot: envelope.trustedRoot,
                  writeRoots: envelope.writeRoots,
                  sessionTempDir: envelope.sessionTempDir,
                });
                await audit(
                  "allow-by-envelope-grant",
                  envelope.autoGrant
                    ? "session grant auto-granted for the current sandbox envelope (sandbox.autoAllowBash)"
                    : "session grant granted for the current sandbox envelope",
                  "granted",
                );
              }
              // The Bash handler refuses to launch unless the profile it would
              // run under still hashes to this, so the child launch uses the
              // envelope the user approved rather than whatever the session
              // looks like now.
              exec = { ...exec, envelopeHash: envelope.profileHash };
            } else {
              // Approved via askUser. The TUI (App.tsx) writes a finer-grained
              // once/session/always row when it actually shows a prompt, but it
              // writes nothing when it short-circuits the prompt (a write-set
              // edit) — so the agent records the coarse "approved" outcome here
              // to guarantee a row exists on every approval path. On the
              // interactive path this coexists with the UI's fine-grained row
              // (see UI-side approximation note in permission-spec.md).
              await audit(
                wasUnresolved ? "unresolved-ask" : "ask-approved",
                wasUnresolved
                  ? "approved by user; bash segment was unresolved (fail-closed ask)"
                  : "approved by user at prompt",
              );
              // The approved-operation grant (permission-profile.md §8,
              // release gate 2, trusted half). Reached only by a plain
              // `true`, i.e. the user answered the prompt for *this* call:
              // the UI's "posture" and auto mode's own allow are handled above, and a persisted
              // session/always rule resolves to `action: "allow"` long before
              // this branch — so no grant can outlive the approval. App.tsx
              // marks config-writing Git calls oneTimeOnly, so a persistent
              // answer is not even offered, and isGitConfigOperation decides
              // whether this command is one the widened profile can serve.
              if (isGitConfigOperation(tc.name, tc.arguments)) {
                exec = { ...exec, approvedGitConfigWrite: true };
              }
            }
            // User-approved (or posture- or auto-allowed) asks still pass through
            // PreToolUse — a deny here routes through the permission engine
            // as deny-by-rule, indistinguishable from policy in the audit trail.
            if (await hookBlocks(tc, "PreToolUse")) {
              await audit("deny-by-rule", "deny rule matched (PreToolUse hook)");
              hookDenied(tc, "PreToolUse");
              return { denied: true };
            }
          } else {
            // Auto can still decide with no prompter: an allow runs, a block is
            // denied, and anything it would hand to a human is a denial below,
            // as it always was.
            const decision = autoMode !== undefined ? await decideAuto() : undefined;
            if (decision?.kind === "denied") return { denied: true };
            if (decision?.kind === "allow") {
              await audit("allow-by-classifier", decision.reason, undefined, decision.auto);
              if (await hookBlocks(tc, "PreToolUse")) {
                await audit("deny-by-rule", "deny rule matched (PreToolUse hook)");
                hookDenied(tc, "PreToolUse");
                return { denied: true };
              }
              return { denied: false, exec };
            }
            // No prompter: an ask is a denial, as it always was. An ask the
            // *classifier* caused carries its reason instead of the generic
            // line — the run is still going, so the model gets the sentence
            // that says how to rewrite the call rather than one that just says
            // no (docs/command-risk-classifier.md §7, §12.6).
            const deniedByClassifier = riskActed && policyRisk?.message !== undefined;
            const msg = deniedByClassifier
              ? `PERMISSION_DENIED: ${policyRisk!.message}`
              : "PERMISSION_DENIED: headless — rule resolved to ask";
            options.onDiagnostic?.("denied");
            await audit(
              "headless-deny",
              deniedByClassifier
                ? `headless: denied by the risk classifier (${riskVerdict?.reasons.join(", ")})`
                : "resolved to ask with no interactive prompter (headless)",
            );
            appendFreshToolResult(tc.id, tc.name, msg);
            return { denied: true };
          }
        } else if (action === "allow") {
          // Rule-derived allow with no prompt at all — still worth an audit
          // row so "why did this run without asking me" is answerable.
          await audit("allow-by-rule", `allow rule matched (${winningRule?.origin ?? "rule"})`);
          if (await hookBlocks(tc, "PreToolUse")) {
            await audit("deny-by-rule", "deny rule matched (PreToolUse hook)");
            hookDenied(tc, "PreToolUse");
            return { denied: true };
          }
        }
        // Set after every approval path above, so the launch drops its profile
        // only for a call the permission flow let through.
        if (unsandboxedKind !== undefined) exec = { ...exec, unsandboxed: true };
      } else if (await hookBlocks(tc, "PreToolUse")) {
        // No permission engine — the hook is the only gate.
        hookDenied(tc, "PreToolUse");
        return { denied: true };
      }
      return { denied: false, exec };
    };

    // Non-tool notes a call raises (reflection, warnings, image attachments)
    // are held here and appended once the whole batch has its results. Pushed
    // straight into `messages`, a note for a non-last call landed between the
    // batch's tool results, and the provider SDK rejected the next request with
    // "Tool result is missing for tool call …" — the turn died mid-task.
    const batchNotes: Message[] = [];

    // Shared per-call body for both execution paths — exactly the
    // sequential loop's behavior, including permission audit rows, askUser,
    // failedStreak escalation, repeat-call detection, and the reflection
    // retry. `preResult` supplies an already-executed result (a parallel
    // read) so the call is not executed twice; `gateDone` marks a call the
    // parallel path already gated before execution, so the gate never runs
    // twice. Returns true when the turn must end (tool stop, loop detected,
    // or the 5-consecutive-failure escalation).
    const processCall = async (
      tc: ToolCall,
      preResult: ToolOutput | undefined,
      gateDone = false,
    ): Promise<boolean> => {
      let exec: ToolExecOptions | undefined;
      if (!gateDone) {
        const gate = await gateCall(tc);
        if (gate.denied) return false;
        exec = gate.exec;
      }

      // Completion gate: the first attempt_completion after an unverified
      // edit becomes the reminder instead of ending the turn.
      if (completionGate && tc.name === "attempt_completion") {
        const reminder = completionGate.check();
        if (reminder) {
          options.onDiagnostic?.("completion gate: edit not verified — one reminder sent");
          appendFreshToolResult(tc.id, tc.name, reminder.content);
          return false;
        }
      }

      const result = preResult ?? await executeTool(tc, exec);
      executedAny = true;
      // A write tool that succeeded produced a file this session owns; the
      // classifier's delete rules read this to tell "the agent made it" from
      // "it was here before we were" (§4.2 preSessionTarget).
      if (!result.error) for (const path of writtenPaths(tc.name, tc.arguments)) createdThisSession.add(path);
      if (!result.error) completionGate?.observe(tc.name, tc.arguments);
      // PostToolUse / PostToolUseFailure: hook stdout appends to the result
      // (hooks-spec.md §2) before it reaches the model or the UI preview.
      if (options.hooks) {
        const postEvent = result.error ? "PostToolUseFailure" : "PostToolUse";
        const hr = await options.hooks.dispatch(postEvent, { tool_name: tc.name, tool_input: tc.arguments });
        if (hr.stdout && hr.stdout.trim() !== "") {
          const note = hr.stdout.trimEnd();
          if (result.error) {
            result.error = `${result.error}\n${note}`;
          } else {
            result.content = result.content ? `${result.content}\n${note}` : note;
          }
        }
      }
      // Post-edit language-server diagnostics: the errors in the file(s) this
      // call just wrote. Appended to the call's own result — not a separate
      // system message — so the model reads "these errors belong to that edit"
      // rather than having to infer which write a later note refers to. This
      // one hook covers every write tool (including multi-file apply_patch),
      // and reaches sub-agents because the orchestrator calls this same runAgent.
      if (options.lsp && !result.error) {
        const paths = writtenPaths(tc.name, tc.arguments);
        if (paths.length > 0) {
          try {
            const found = await options.lsp.diagnosticsFor(paths);
            for (const [path, diagnostics] of found) {
              const serverName = options.lsp.serverNameFor(path) ?? "lsp";
              const block = diagnosticsBlock(
                serverName,
                path,
                diagnostics,
                options.lsp.workspaceRoot,
              );
              if (!block) continue;
              result.content = result.content ? `${result.content}\n\n${block}` : block;
              const errors = diagnostics.filter((d) => d.severity === 1).length;
              if (errors > 0) {
                options.onDiagnostic?.(
                  `lsp: ${errors} error(s) in ${relPath(options.lsp.workspaceRoot, path)}`,
                );
              }
            }
          } catch {
            // Diagnostics are an enhancement: a language server that will not
            // start must never turn a successful edit into a failed result.
          }
        }
      }
      options.onToolResult?.(tc.name, result);
      const historyContent = toolResultForHistory(result);

      const callKey = `${tc.name}:${JSON.stringify(tc.arguments)}`;
      const callCount = (seenCalls.get(callKey) || 0) + 1;
      seenCalls.set(callKey, callCount);

      if (result.error) {
        failedStreak++;
      } else {
        failedStreak = 0;
        warnedFailures = false;
      }

      // Prevent the model from asking the same question again in a later turn.
      if (tc.name === "ask_user_question" && !result.error) {
        const qKey = JSON.stringify(tc.arguments);
        if (askedQuestions.has(qKey)) {
          batchNotes.push({
            role: "system",
            content: "You already asked this exact question and received an answer. Do not ask it again.",
          });
        }
        askedQuestions.add(qKey);
      }

      if (result.error && errorReflector?.canRetry(tc.name, result.error)) {
        appendFreshToolResult(tc.id, tc.name, historyContent);
        batchNotes.push({
          role: "user",
          content: errorReflector.formatError(tc.name, result.error),
        });
        options.onRetry?.("retrying");
        errorReflector.resetTurn();
      } else {
        // F5 delta: the bounded auto-fix loop is done — retry cap exhausted
        // (or no reflector / a permission hard-stop, which never retries).
        // Surface the escalation note so the UI can flag it.
        if (result.error && errorReflector && !result.error.includes("Permission denied")) {
          options.onDiagnostic?.("retry cap exhausted — escalating");
        }
        appendFreshToolResult(tc.id, tc.name, historyContent);
      }

      // A tool cannot return an image (ToolOutput is text-only on the wire), so
      // a tool that produces one hands it back via `attachments` and the loop
      // re-emits them here as a synthetic user message — the only message role
      // that carries image bytes (see providers/aisdk.ts mapMessages). Emitted
      // after the batch's tool results (via batchNotes), so the image follows
      // the call that produced it without splitting the batch.
      if (!result.error && result.attachments?.length) {
        batchNotes.push({
          role: "user",
          content: `Image attached by ${tc.name}.`,
          imageUrls: result.attachments,
        });
      }

      if (result.stop) {
        // attempt_completion: the tool signaled the task is done — end the
        // turn cleanly. stopReason stays "done" (it completed, not aborted).
        turnEnded = true;
        return true;
      }

      if (result.error && callCount >= 3 && !warnedRepeat) {
        batchNotes.push({
          role: "system",
          content: `You have called ${tc.name} with identical arguments ${callCount} times. All calls failed with: ${result.error}. Change your approach.`,
        });
        warnedRepeat = true;
      } else if (result.error && callCount >= 4 && warnedRepeat) {
        options.onLoopDetected?.("loop detected");
        turnEnded = true;
        return true;
      }

      if (failedStreak >= 5 && !warnedFailures) {
        batchNotes.push({
          role: "system",
          content: "5 consecutive tool calls have failed. Review your approach before continuing.",
        });
        warnedFailures = true;
        turnEnded = true;
        return true;
      }

      return false;
    };

    let tookParallelPath = false;
    // True when at least one call in the batch actually executed — a batch
    // whose calls were all denied produced no results, so the batch-level
    // hook must not fire for it (hooks only see surviving calls, spec §5).
    let executedAny = false;

    if (canRunParallel) {
      tookParallelPath = true;

      // Fire all onToolStart at once so the UI sees the batch.
      for (const tc of toolCalls) {
        options.onToolStart?.(tc.name, tc.arguments);
      }

      // Gate the parallel reads BEFORE executing them (fix 3): a PreToolUse
      // deny must prevent the read from running — not discard an
      // already-executed result — and the deny-by-rule audit row must record
      // a denial that actually happened. Denied reads get their
      // PERMISSION_DENIED message + audit row right here and never execute.
      const preDenied = new Map<string, boolean>();
      for (const tc of parallelReads) {
        if ((await gateCall(tc)).denied) preDenied.set(tc.id, true);
      }

      // Execute the allowed reads concurrently; results are collected and
      // replayed at their original positions below.
      const preResults = new Map<string, ToolOutput>();
      const toExecute = parallelReads.filter((tc) => !preDenied.get(tc.id));
      const settled = await Promise.allSettled(
        toExecute.map(tc => executeTool(tc)),
      );
      for (let i = 0; i < toExecute.length; i++) {
        const r = settled[i];
        preResults.set(
          toExecute[i].id,
          r.status === "fulfilled"
            ? r.value
            : { content: "", error: (r.reason as Error)?.message ?? "Unknown error" },
        );
      }

      // Original-order replay: walk the assistant's toolCalls and emit each
      // outcome at its position — precomputed results for the parallel
      // reads, sequential execution for the rest. Writes stay strictly
      // ordered; an ask in the batch is prompted exactly once and never
      // executed in parallel. Reads carry gateDone — their gate already ran
      // before execution.
      for (const tc of toolCalls) {
        if (preDenied.get(tc.id)) continue;
        const ended = await processCall(tc, preResults.get(tc.id), preResults.has(tc.id));
        if (ended) break;
      }
    }

    if (!tookParallelPath) {
      for (const tc of toolCalls) {
        options.onToolStart?.(tc.name, tc.arguments);
        const ended = await processCall(tc, undefined);
        if (ended) break;
      }
    }

    messages.push(...batchNotes);

    // Per-call hooks fired inside processCall; the batch-level event fires
    // once the batch is done (hooks-spec.md §2).
    if (options.hooks && executedAny) {
      await options.hooks.dispatch("PostToolBatch", { tool_calls: toolCalls.map((tc) => tc.name) });
    }

    if (diagnostics?.available) {
      const diagnosticErrors = await diagnostics.check();
      if (diagnosticErrors) {
        messages.push({
          role: "system",
          content: `Your last edit introduced these errors:\n\n${diagnosticErrors}`,
        });
        options.onDiagnostic?.("new errors detected");
      }
    }

    await maybeCompact(compactionOverheadTokens);
    } catch (err) {
      if (errorRecovery && !(err as any)?.__providerStreamError) {
        const msg = errorRecovery.handleFatalError(err instanceof Error ? err : new Error(String(err)));
        messages.push({ role: "system", content: msg });
        options.onDiagnostic?.(msg);
      } else {
        // A provider-stream failure ends the turn here, and the work already
        // done this turn — tool results, partial assistant text — would
        // otherwise be unreachable: the caller's catch sees only the error, and
        // the next turn would start without the work the user paid for. Attach
        // the delta and the live array so the caller can persist the turn
        // anyway (the TUI does; headless keeps its non-zero exit).
        if (err !== null && typeof err === "object") {
          captureNewMessages();
          (err as { newMessages?: Message[] }).newMessages = newMessages;
          (err as { messages?: Message[] }).messages = messages;
        }
        throw err;
      }
      break;
    }
  }

  if (turn >= maxTurns) {
    stopReason = "max_turns";
    // `turn` counts model requests, one per loop iteration — the number the
    // caller reports back to the user.
    options.onMaxTurns?.(messages, turn);
  }

  captureNewMessages();
  return {
    messages,
    newMessages,
    stopReason,
  };
}
