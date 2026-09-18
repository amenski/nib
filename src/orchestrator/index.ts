import type { Provider } from "../providers/types.js";
import type { Message, ToolCall, ToolDef, ToolOutput } from "../types.js";
import type { ToolHandler, ToolContext } from "../tools/types.js";
import { ToolRegistry } from "../tools/registry.js";
import { runAgent, type AgentResult } from "../agent.js";
import { Compactor } from "../compaction/compactor.js";
import { ModeLoader } from "../modes/loader.js";
import { AgentLoader } from "../agents/index.js";
import type { PermissionEngine, ProfileEvaluator } from "../permissions/index.js";
import type { BashEnvelope } from "../permissions/session-grant.js";
import type { HookRunner } from "../hooks/index.js";
import { subagentAuditStore } from "../sessions/store.js";
import { TodoStore } from "../tools/todo.js";
import { TaskRegistry } from "./runner.js";

/**
 * A progress event from a running sub-agent, surfaced to the parent UI so a
 * delegation reads as live work instead of a stalled turn. `depth` is the
 * sub-agent's nesting level (0 = spawned by the top-level agent), letting the
 * renderer indent nested runs.
 */
export type SubagentProgress =
  | { kind: "start"; task: string; agent?: string; depth: number }
  | { kind: "tool"; name: string; args: Record<string, unknown>; depth: number }
  | { kind: "end"; task: string; depth: number }
  | { kind: "text"; text: string; depth: number; agent?: string };

export interface OrchestratorOptions {
  /**
   * Provider factory resolved at sub-agent spawn time, so a sub-agent always
   * uses the provider/model the parent session is currently on (including
   * mid-session `/model` switches) instead of the provider captured at
   * tool-registration time. An optional "provider/model" id (a defined
   * agent's `model` override, feature-plans.md §F4) creates a provider bound
   * to that model instead; absent = the parent's current provider.
   */
  provider: (modelId?: string) => Provider;
  registry: ToolRegistry;
  modeLoader: ModeLoader;
  /**
   * Frontmatter agent definitions (.nib/agents/*.md, feature-plans.md
   * §F4): `new_task`'s `agent` parameter resolves through this loader. The
   * def supplies the mode/model/instructions — never the security envelope.
   */
  agents?: AgentLoader;
  permissions?: PermissionEngine;
  /**
   * The parent session's capability-boundary gate (permission-profile.md §6):
   * sub-agents inherit the profile together with the rule engine — same
   * object threading as today's permission inheritance, so a sub-agent can
   * never reach beyond what the parent may reach.
   */
  profile?: ProfileEvaluator;
  /**
   * Surfaces a sub-agent's ask-tier permission calls to the same prompt flow
   * the top-level agent uses, instead of auto-denying them. Without this,
   * a sub-agent spawned while the parent UI is mid-session gets
   * PERMISSION_DENIED on every ask-tier action it attempts, since agent.ts's
   * headless branch (no askUser) denies rather than asks.
   */
  askUser?: (toolName: string, args: Record<string, unknown>, envelope?: BashEnvelope) => Promise<boolean | "posture" | "envelope-grant">;
  /**
   * Surfaces a sub-agent's tool activity to the parent UI while it runs.
   * Without this the parent renders nothing between the `new_task` header and
   * the final summary — a multi-minute delegation is indistinguishable from a
   * hang. Re-pointed per turn like askUser, since the UI's callback bundle is
   * rebuilt each turn. Headless leaves it unset (nothing to render).
   */
  onSubagentProgress?: (event: SubagentProgress) => void;
  /**
   * Resolved at sub-agent spawn time. Lets Esc/Ctrl+C at the top level abort
   * an in-flight sub-agent instead of leaving it running to completion.
   */
  getSignal?: () => AbortSignal | undefined;
  /** Lifecycle hooks dispatcher (docs/hooks-spec.md) — SubagentStart/Stop
   *  fire around each sub-agent run. */
  hooks?: HookRunner;
  maxDepth?: number;
  maxSubTurns?: number;
  /**
   * Async delivery (async-subagents.md §2): called once per completed sub-run
   * (done/failed/aborted) with the formatted result message
   * (`Sub-agent result (task <id>): <summary>`). The App/exec-runner wire this
   * to their wake path — append + auto-start a turn / continue the headless
   * loop. Re-pointable via setOnTaskResult for the same per-session reason
   * setAskUser exists.
   */
  onTaskResult?: (taskId: string, message: string) => void;
}

export class Orchestrator {
  private options: Required<Pick<OrchestratorOptions, "maxDepth" | "maxSubTurns">> & {
    provider: (modelId?: string) => Provider;
    registry: ToolRegistry;
    modeLoader: ModeLoader;
    agents?: AgentLoader;
    permissions?: PermissionEngine;
    profile?: ProfileEvaluator;
    getSignal?: () => AbortSignal | undefined;
    hooks?: HookRunner;
  };
  private askUser?: (toolName: string, args: Record<string, unknown>, envelope?: BashEnvelope) => Promise<boolean | "posture" | "envelope-grant">;
  private onSubagentProgress?: (event: SubagentProgress) => void;
  private onTaskResult?: (taskId: string, message: string) => void;

  /** In-memory task registry for detached sub-runs (async-subagents.md §3).
   *  Public so the App/exec-runner can kill pending runs on exit, the headless
   *  loop can wait for completions, and the /tasks view can list + stop them. */
  readonly tasks = new TaskRegistry();
  /** Per-task abort controllers (async-subagents.md §3, Q4 — /tasks stop).
   *  Keyed by task id, created at spawn, fired by abortTask(). Each is linked
   *  to the parent signal, so Esc/Ctrl+C still aborts every sub-run. */
  private taskAborts = new Map<string, AbortController>();

  constructor(options: OrchestratorOptions) {
    this.options = {
      maxDepth: 3,
      maxSubTurns: 10,
      ...options,
    };
    this.askUser = options.askUser;
    this.onSubagentProgress = options.onSubagentProgress;
    this.onTaskResult = options.onTaskResult;
  }

  /**
   * Re-point the askUser callback. The interactive CLI's prompt bridge is
   * recreated every turn, so the orchestrator (registered once at startup)
   * must be told about the current turn's bridge rather than holding a stale
   * closure. Headless mode leaves this unset, which auto-denies.
   */
  setAskUser(askUser: ((toolName: string, args: Record<string, unknown>, envelope?: BashEnvelope) => Promise<boolean | "posture" | "envelope-grant">) | undefined): void {
    this.askUser = askUser;
  }

  /**
   * Re-point the progress sink, for the same reason setAskUser exists: the
   * interactive CLI rebuilds its callback bundle every turn, so a closure
   * captured at startup would render into a dead turn's output stream.
   */
  setOnSubagentProgress(onSubagentProgress: ((event: SubagentProgress) => void) | undefined): void {
    this.onSubagentProgress = onSubagentProgress;
  }

  /**
   * Re-point the async result delivery sink. The App/exec-runner register their
   * wake handler once per session (it touches only refs); headless leaves it
   * wired to its pending-results queue. Unlike askUser/progress it is NOT
   * turn-scoped — delivery happens between turns by design.
   */
  setOnTaskResult(onTaskResult: ((taskId: string, message: string) => void) | undefined): void {
    this.onTaskResult = onTaskResult;
  }

  /**
   * Abort ONE running sub-run — the /tasks stop action (async-subagents.md
   * §3, Q4). Fires that task's abort signal so runAgent stops at its next
   * turn boundary, and marks the record aborted so the late delivery is
   * suppressed (the same rule abortAll uses on exit). Siblings keep running.
   */
  abortTask(taskId: string): void {
    this.taskAborts.get(taskId)?.abort();
    this.tasks.abortTask(taskId);
  }

  register(registry: ToolRegistry): void {
    registry.register({
      def: this.buildDef(),
      handler: this.createHandler(0),
      groups: ["workflow"],
    });
  }

  /** The new_task tool def, rebuilt at register time so the `agent` parameter
   *  description can list the names that were loaded at startup. */
  private buildDef(): ToolDef {
    const agentNames = (this.options.agents?.list() ?? [])
      .map((a) => a.name)
      .sort();
    const agentList =
      agentNames.length > 0 ? ` Available agents: ${agentNames.join(", ")}.` : "";
    return {
      name: "new_task",
      description:
        "Spawn a sub-agent to handle a discrete, isolated task. The sub-agent runs in a " +
        "fresh context with its own message history and tool access. The call returns " +
        "immediately with a task id; the sub-agent runs in the background and its summary " +
        "arrives as a separate message ('Sub-agent result (task <id>): …') — you do not see " +
        "raw file diffs or tool outputs from the sub-agent.\n\n" +
        "Use this to delegate implementation work, research, or analysis to a specialized " +
        "mode or a defined agent. End your turn after spawning and await the results; never " +
        "poll for a result and never re-spawn a task that is still running. At most 3 " +
        "sub-agents run concurrently — spawning beyond that returns a queue-full error. " +
        "Each sub-agent can itself spawn sub-agents up to a maximum depth of 3.",
      parameters: {
        type: "object",
        properties: {
          description: {
            type: "string",
            description:
              "A clear, self-contained description of what the sub-agent should accomplish. " +
              "Include all necessary context since the sub-agent cannot see your conversation.",
          },
          mode: {
            type: "string",
            description:
              "The mode to run the sub-agent in. Available: 'code' (implementation), " +
              "'architect' (planning/design), 'debug' (investigation), 'ask' (research). " +
              "Defaults to 'code'.",
          },
          agent: {
            type: "string",
            description:
              "Optional: the name of a defined agent (.nib/agents/<name>.md) to run " +
              "this task as. The agent's mode, model, and instructions override the mode " +
              "parameter and the parent's model." +
              agentList,
          },
        },
        required: ["description"],
      },
    };
  }

  private createHandler(depth: number): ToolHandler {
    return async (
      args: Record<string, unknown>,
      ctx: ToolContext,
    ): Promise<ToolOutput> => {
      if (depth >= this.options.maxDepth) {
        return {
          content: `Maximum task nesting depth reached (${this.options.maxDepth}). Cannot spawn further sub-tasks.`,
          error: "MAX_DEPTH",
        };
      }

      const description = args.description as string;
      const agentName = args.agent as string | undefined;

      // An `agent` parameter resolves the sub-run's persona/toolset/model from
      // the definition (feature-plans.md §F4); absent, today's behavior is
      // unchanged (call-provided mode, parent model).
      let modeSlug = (args.mode as string) || "code";
      let agentInstructions: string | undefined;
      let modelId: string | undefined;

      if (agentName !== undefined) {
        const agents = this.options.agents;
        const def = agents?.get(agentName);
        if (!def) {
          const available =
            agents && agents.list().length > 0
              ? ` Available agents: ${agents.list().map((a) => a.name).sort().join(", ")}`
              : "";
          return {
            content: `Unknown agent: "${agentName}".${available}`,
            error: "UNKNOWN_AGENT",
          };
        }
        modeSlug = def.mode;
        agentInstructions = def.instructions;
        modelId = def.model;
      }

      const subMode = await this.options.modeLoader.load(modeSlug);
      if (!subMode) {
        return {
          content: `Unknown mode: "${modeSlug}". Available built-in modes: general, code.`,
          error: "UNKNOWN_MODE",
        };
      }

      const subModeGroups = subMode.groups || [];
      const subTools: ToolDef[] = [
        ...this.options.registry.getByMode(subModeGroups),
        this.buildDef(),
      ];

      // A defined agent's model override binds the sub-provider to that
      // "provider/model"; an unknown/unconfigured provider must fail the spawn
      // cleanly as a tool error, not crash the parent turn.
      let provider: Provider;
      try {
        provider = modelId ? this.options.provider(modelId) : this.options.provider();
      } catch (err) {
        return {
          content: `Cannot spawn sub-task: ${(err as Error).message}`,
          error: `SUBTASK_PROVIDER: ${(err as Error).message}`,
        };
      }
      const subCompactor = new Compactor(provider);

      // The sub-agent gets its own todo store: its update_todo_list calls must
      // not clobber the parent's checklist panel, and its own model context
      // should see its own plan (getTodos below). The store is threaded
      // explicitly through each per-call tool context below — no shared
      // global pointer is mutated — so nested sub-runs isolate purely by
      // context, and a tool call can never see another run's store.
      const subStore = new TodoStore();

      // Decision H (feature-plans.md §10): the sub-agent's permission and
      // token rows land in the PARENT session's JSONL, tagged
      // `source: "subagent"`, through a restricted audit-only view of the
      // parent's store. Messages and todo snapshots can never pass through
      // the view, so the parent transcript stays clean and todoStore
      // isolation is unchanged. When the parent itself has no store wired
      // (headless run), there is nothing to audit into and the sub-agent
      // stays audit-silent, exactly like the parent.
      const subAuditStore = ctx.sessionStore ? subagentAuditStore(ctx.sessionStore) : undefined;

      const subExecuteTool = (call: ToolCall): Promise<ToolOutput> => {
        if (call.name === "new_task") {
          return this.createHandler(depth + 1)(call.arguments, { ...ctx, todoStore: subStore, sessionStore: subAuditStore });
        }
        // sessionStore: subAuditStore — only permission/token rows may pass
        // through to the parent session; sub-agent plans stay ephemeral.
        return this.options.registry.execute(call, { ...ctx, todoStore: subStore, sessionStore: subAuditStore });
      };

      // Async contract (async-subagents.md §1-3): spawn returns immediately and
      // the sub-run executes detached through the in-memory task registry. The
      // run inherits everything today's synchronous run did — provider
      // resolution, mode/model/instructions, permission/profile inheritance,
      // audit-only store, isolated todo store — plus the parent signal captured
      // at spawn (Esc/Ctrl+C aborts, as today).
      //
      // Per-task abort (async-subagents.md §3, Q4 — /tasks stop): every spawned
      // run gets its own controller linked to the parent signal, so abortTask()
      // can kill exactly one sub-run while Esc/Ctrl+C still kills them all. The
      // controller is registered under the task id as soon as spawn returns
      // (the detached run starts asynchronously, so the registration always
      // lands before it can be aborted).
      const taskAbort = new AbortController();
      const parentSignal = this.options.getSignal?.();
      if (parentSignal) {
        if (parentSignal.aborted) {
          taskAbort.abort();
        } else {
          parentSignal.addEventListener("abort", () => taskAbort.abort(), { once: true });
        }
      }

      const spawned = this.tasks.spawn({
        description,
        depth,
        agentName,
        run: async () => {
          try {
            const result = await runAgent(description, {
              provider,
              tools: subTools,
              executeTool: subExecuteTool,
              compactor: subCompactor,
              permissions: this.options.permissions,
              permissionProfile: this.options.profile,
              askUser: this.askUser,
              maxTurns: this.options.maxSubTurns,
              mode: subMode,
              // The defined agent's instructions prepend the sub-agent's system
              // prompt (prompt.ts prepends agentInstructions to the preamble).
              agentInstructions,
              hooks: this.options.hooks,
              // Parent session identity behind the audit-only view: permission
              // and token rows land in the parent's JSONL tagged "subagent";
              // every other write is blocked by the view (subsystems.md §7).
              sessionStore: subAuditStore,
              sessionId: ctx.sessionId,
              signal: taskAbort.signal,
              getTodos: () => subStore.getTodos(),
              // Live tool activity for the parent UI. args travel alongside the
              // name so the renderer can show e.g. "Bash(grep -n …)" the same
              // way the top-level transcript does (ToolCallFormatter's
              // describeToolCall already truncates to short, specific fields —
              // it never dumps a raw arg like file `content` verbatim).
              // Read at fire time (not captured): the progress sink is
              // re-pointed per turn, and an async sub-run's tool/end events may
              // land in a later turn's live stream.
              onToolStart: (name: string, args: Record<string, unknown>) =>
                this.onSubagentProgress?.({ kind: "tool", name, args, depth }),
              // Live sub-run text (async-subagents.md §4): streamed text deltas
              // flow to the parent UI as progress events — the App's mount-time
              // sink renders them as dim `[agent <name>]` transcript rows,
              // regardless of turn state.
              onText: (c: string) =>
                this.onSubagentProgress?.({ kind: "text", text: c, depth, agent: agentName }),
            });
            const summary = summarizeMessages(result.messages, description, result.stopReason);
            return {
              status: result.stopReason === "aborted" ? "aborted" : "done",
              summary,
            };
          } finally {
            this.onSubagentProgress?.({ kind: "end", task: description, depth });
            await this.options.hooks?.dispatch("SubagentStop", { task: description });
          }
        },
        deliver: (taskId, message) => this.onTaskResult?.(taskId, message),
      });
      if ("error" in spawned) {
        return {
          content: spawned.error,
          error: "QUEUE_FULL",
        };
      }
      this.taskAborts.set(spawned.taskId, taskAbort);

      // SubagentStart + the live "start" event fire at spawn (hooks-spec.md §2,
      // async-subagents.md §3); SubagentStop + "end" fire at completion inside
      // the detached run above. Depth/mode/cap failures never spawn, so no
      // hooks fire for them.
      await this.options.hooks?.dispatch("SubagentStart", { task: description });
      this.onSubagentProgress?.({ kind: "start", task: description, agent: agentName, depth });
      const running = this.tasks.runningCount();
      return {
        content: `task ${spawned.taskId} spawned — result will follow (depth ${depth}, ${running}/${this.tasks.maxConcurrent} sub-agents running)`,
      };
    };
  }
}

function summarizeMessages(
  messages: Message[],
  task: string,
  stopReason?: AgentResult["stopReason"],
): string {
  // Three message shapes share role "assistant" but are not the sub-agent's
  // answer: a tool-calling turn (content is usually null, agent.ts), a
  // reasoning-only turn (meta.asThinking), and a parse-error correction turn.
  // Picking the newest assistant message blindly lands on one of those
  // whenever the run ends on a tool call, reporting "no final message" for a
  // run that did produce findings. Take the newest *answer* instead.
  const lastAnswer = [...messages]
    .reverse()
    .find(
      (m) =>
        m.role === "assistant" &&
        !m.meta?.asThinking &&
        !m.toolCalls?.length &&
        typeof m.content === "string" &&
        m.content.trim() !== "",
    )?.content;

  const toolCount = messages.filter((m) => m.role === "tool").length;

  const parts: string[] = [];
  parts.push(`**Task**: ${task}`);
  parts.push(`**Tools executed**: ${toolCount}`);

  if (lastAnswer) {
    parts.push(`**Result**: ${lastAnswer.slice(0, 500)}`);
  } else if (stopReason === "max_turns") {
    // Distinguishable from a silent finish: the parent (and the model) can
    // tell the sub-agent ran out of turns mid-work rather than choosing to
    // say nothing, and can re-delegate a narrower slice.
    parts.push(
      `**Result**: incomplete — sub-agent hit its turn limit before answering`,
    );
  } else if (stopReason === "aborted") {
    parts.push(`**Result**: aborted before the sub-agent answered`);
  } else {
    parts.push(`**Result**: completed (no final message from sub-agent)`);
  }

  return parts.join("\n");
}
