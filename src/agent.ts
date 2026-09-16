import type { Provider } from "./providers/types.js";
import type { Message, ToolCall, ToolDef, ToolOutput } from "./types.js";
import type { PermissionEngine, ResolveResult } from "./permissions/index.js";
import { authorize, type ProfileEvaluator } from "./permissions/index.js";
import type { ModeConfig } from "./modes/loader.js";
import type { Compactor } from "./compaction/compactor.js";
import type { DiagnosticRunner } from "./diagnostics/index.js";
import type { ErrorReflector } from "./selfreflection/index.js";
import type { ErrorRecovery } from "./errorrecovery/index.js";
import type { SkillDef } from "./skills/index.js";
import type { AgentDef } from "./agents/index.js";
import type { MemoryStore } from "./memory/store.js";
import type { HookRunner } from "./hooks/index.js";
import type { SessionStore, CompactionSummary, PermissionDecision } from "./sessions/store.js";
import { buildStablePreamble, buildVolatileContext, type PromptContext } from "./prompt.js";
import { estimateTokens, estimateOverheadTokens } from "./compaction/budget.js";
import { editToolResultsForRequest } from "./compaction/context-editing.js";
import { formatTodoBlock } from "./tools/todo.js";
import type { TodoItem } from "./tools/todo.js";
import { logTiming } from "./debug/logger.js";
import { extractCapabilityPlan } from "./permissions/capabilities.js";
import { isGitConfigOperation } from "./permissions/git-config-operations.js";
import type { ToolExecOptions } from "./tools/types.js";

export type ToolExecutor = (call: ToolCall, exec?: ToolExecOptions) => Promise<ToolOutput>;

import { extractToolSubject } from "./permissions/rules.js";

function permissionSubjectText(toolName: string, args: Record<string, unknown>): string {
  return extractToolSubject(toolName, args);
}

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
  mode?: ModeConfig;
  compactor?: Compactor;
  diagnostics?: DiagnosticRunner;
  errorReflector?: ErrorReflector;
  errorRecovery?: ErrorRecovery;
  maxTurns?: number;
  /** Context-window ceiling used as budgetMax for per-turn token rows. Defaults to 128000, the codebase-wide fallback. */
  contextWindow?: number;
  skills?: SkillDef[];
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
  onMaxTurns?: (messages: Message[]) => void;
  onUsage?: (input: number, output: number, cached?: number) => void;
  /**
   * Interactive approval bridge for ask-tier calls. Resolves true (approved)
   * or false (denied); resolves "posture" when an auto-approve posture
   * upgraded the ask to allow without showing a prompt — recorded as
   * allow-by-posture in the audit trail (permission-spec.md §11).
   */
  askUser?: (toolName: string, args: Record<string, unknown>) => Promise<boolean | "posture">;
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

export async function runAgent(
  userMessage: string,
  options: AgentOptions,
): Promise<AgentResult> {
  const { provider, tools, executeTool, permissions, permissionProfile, compactor, diagnostics, errorReflector, errorRecovery, maxTurns = 100, effort, thinkingEnabled } = options;

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
  };
  const promptAssemblyStart = Date.now();
  const stablePreamble = getStablePreamble(promptCtx);
  const volatileContext = await buildVolatileContext(promptCtx);

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
  // (RepoMap, plan-mode instruction, env/git) is attached to the user turn
  // only in the request sent to the provider (see withVolatilePrefix below),
  // never stored on `messages`, so it reaches the model every turn without
  // ever mutating the cached system prefix or polluting history.
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
  // Reattach it each sub-turn to the last user-role message (the turn's
  // opening user message stays last-user as assistant/tool messages append
  // after it), so it reaches the model on every streamChat call this turn.
  function withVolatilePrefix(msgs: Message[], prefix: string): Message[] {
    let idx = -1;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === "user") {
        idx = i;
        break;
      }
    }
    if (idx === -1) return msgs;
    const copy = [...msgs];
    const target = copy[idx] as Message & { role: "user" };
    copy[idx] = { ...target, content: `${prefix}\n\n${target.content}` };
    return copy;
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
    // Live todo block: volatileContext is session-stable (computed once above),
    // but the todo list changes mid-turn, so it is re-read and appended here per
    // sub-turn — same withVolatilePrefix mechanism, one extra section.
    const todoBlock = options.getTodos ? formatTodoBlock(options.getTodos()) : "";
    // Mid-turn steering mailbox: poll once per decision point; a hit joins the
    // volatile assembly below AND is pushed to `messages` as a real user
    // message. Pushed at the poll site (not flushed after the turn) so the
    // conversation order stays honest — the message sits before the
    // assistant/tool messages that respond to it — and newMessages/
    // onNewMessages persistence picks it up automatically.
    const steering = options.pollSteeringMessage?.() ?? null;
    if (steering) messages.push({ role: "user", content: steering });
    const prefix = [volatileContext, todoBlock, steering ? `User message (typed mid-turn): ${steering}` : ""].filter(Boolean).join("\n\n");
    const orphaned = repairOrphanedToolCalls(messages);
    if (orphaned > 0) {
      options.onDiagnostic?.(`backfilled ${orphaned} unanswered tool result${orphaned === 1 ? "" : "s"}`);
    }
    const assembledMessages = prefix ? withVolatilePrefix(messages, prefix) : messages;
    // The volatile prefix is already present in assembledMessages, so only
    // tool-schema overhead is added here. This request-only copy deliberately
    // leaves messages/newMessages/session history complete and unedited.
    const requestMessages = editToolResultsForRequest(
      assembledMessages,
      estimateOverheadTokens(tools),
      freshToolResults,
    );
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
          options.onUsage?.(event.inputTokens, event.outputTokens, event.cachedInputTokens);
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
    // (estimateTokens of the live message set) so remaining = budgetMax -
    // totalUsed agrees with the compaction headroom; budgetMax is the context
    // window. remaining is derived on read, never stored.
    const recordTokens = async (): Promise<void> => {
      if (!options.sessionStore || !options.sessionId) return;
      await options.sessionStore.appendToken(options.sessionId, {
        turnTokens,
        totalUsed: estimateTokens(messages),
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
        const { action, winningRule, wasUnresolved, reason } = authorize(
          { tool: tc.name, arguments: tc.arguments },
          permissions,
          permissionProfile,
        );
        const subject = permissionSubjectText(tc.name, tc.arguments);
        const audit = async (
          decision: PermissionDecision,
          reason: string,
        ): Promise<void> => {
          if (!options.sessionStore || !options.sessionId) return;
          const capabilityPlan = extractCapabilityPlan(tc.name, tc.arguments, process.cwd());
          await options.sessionStore.appendPermission(options.sessionId, {
            toolCallId: tc.id, tool: tc.name, subject, decision, winningRule, reason,
            ...(capabilityPlan.commandClassification
              ? { commandClassification: capabilityPlan.commandClassification }
              : {}),
          });
        };

        if (action === "deny") {
          const msg = `Permission denied for ${tc.name}`;
          options.onDiagnostic?.("denied");
          // Layer 1 (profile) and layer 2 (rule) denies share the same tool
          // message; the audit row names the winning layer so the trail stays
          // one-directional (permission-spec.md §11).
          if (reason === "deny-by-profile") {
            await audit("deny-by-profile", "deny by profile (layer 1)");
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
            const allowed = await options.askUser(tc.name, tc.arguments);
            if (allowed === "posture") {
              // Auto-approve posture upgraded the ask to allow without
              // showing a prompt — recorded distinctly from an interactive
              // yes (permission-spec.md §11). No `exec` grant: posture is an
              // approval of a *class* of calls, never of this command, and
              // the widened profile requires the latter.
              await audit("allow-by-posture", "auto-approve posture upgraded an ordinary ask");
            } else if (!allowed) {
              const msg = "PERMISSION_DENIED: denied by user";
              options.onDiagnostic?.("denied");
              await audit("ask-denied", "denied by user at prompt");
              appendFreshToolResult(tc.id, tc.name, msg);
              return { denied: true };
            } else {
              // Approved via askUser. The TUI (App.tsx) writes a finer-grained
              // once/session/always row when it actually shows a prompt, but it
              // writes nothing when an auto-approve posture short-circuits the
              // prompt — so the agent records the coarse "approved" outcome here
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
              // auto-approve posture returns "posture" above, and a persisted
              // session/always rule resolves to `action: "allow"` long before
              // this branch — so no grant can outlive the approval. App.tsx
              // marks config-writing Git calls oneTimeOnly, so a persistent
              // answer is not even offered, and isGitConfigOperation decides
              // whether this command is one the widened profile can serve.
              if (isGitConfigOperation(tc.name, tc.arguments)) {
                exec = { approvedGitConfigWrite: true };
              }
            }
            // User-approved (or posture-upgraded) asks still pass through
            // PreToolUse — a deny here routes through the permission engine
            // as deny-by-rule, indistinguishable from policy in the audit trail.
            if (await hookBlocks(tc, "PreToolUse")) {
              await audit("deny-by-rule", "deny rule matched (PreToolUse hook)");
              hookDenied(tc, "PreToolUse");
              return { denied: true };
            }
          } else {
            const msg = "PERMISSION_DENIED: headless — rule resolved to ask";
            options.onDiagnostic?.("denied");
            await audit("headless-deny", "resolved to ask with no interactive prompter (headless)");
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
      } else if (await hookBlocks(tc, "PreToolUse")) {
        // No permission engine — the hook is the only gate.
        hookDenied(tc, "PreToolUse");
        return { denied: true };
      }
      return { denied: false, exec };
    };

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

      const result = preResult ?? await executeTool(tc, exec);
      executedAny = true;
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
      options.onToolResult?.(tc.name, result);
      const historyContent = result.error ? `Error: ${result.error}` : result.content;

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
          messages.push({
            role: "system",
            content: "You already asked this exact question and received an answer. Do not ask it again.",
          });
        }
        askedQuestions.add(qKey);
      }

      if (result.error && errorReflector?.canRetry(tc.name, result.error)) {
        appendFreshToolResult(tc.id, tc.name, historyContent);
        messages.push({
          role: "user",
          content: errorReflector.formatError(tc.name, result.error, result.content),
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
      // after the tool result so the image follows the call that produced it.
      if (!result.error && result.attachments?.length) {
        messages.push({
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
        messages.push({
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
        messages.push({
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
        throw err;
      }
      break;
    }
  }

  if (turn >= maxTurns) {
    stopReason = "max_turns";
    options.onMaxTurns?.(messages);
  }

  captureNewMessages();
  return {
    messages,
    newMessages,
    stopReason,
  };
}
