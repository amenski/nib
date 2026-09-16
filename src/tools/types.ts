import type { ToolDef, ToolCall, ToolOutput } from "../types.js";
import type { CheckpointManager } from "../checkpoints/index.js";
import type { SessionStore } from "../sessions/store.js";
import type { TodoStore } from "./todo.js";
import type { SandboxLevel } from "../sandbox/seatbelt.js";
import type { ProfileLevel } from "../permissions/profile.js";
import type { WebSearchConfig } from "../config/loader.js";

export type ToolHandler = (
  args: Record<string, unknown>,
  ctx: ToolContext,
  exec?: ToolExecOptions,
) => Promise<ToolOutput>;

/**
 * Per-call execution options passed alongside {@link ToolContext}.
 *
 * Deliberately not a field on ToolContext: that object is a per-run module
 * singleton (src/tools/index.ts) shared by every call in a session, so it
 * cannot carry anything that must hold for *this* call only. A grant that
 * must not outlive one approved command belongs here, where it is created
 * and dropped inside a single execute call.
 */
export interface ToolExecOptions {
  /**
   * The current call is a config-writing Git command the user explicitly
   * approved at the prompt for this call alone (permission-profile.md §8,
   * release gate 2). Set only by agent.ts in the branch reached when
   * `askUser` returned a plain `true` — never on auto-approve posture
   * (`"posture"` is a distinct return), and never on a persisted rule (that
   * path resolves to `action: "allow"` and does not reach the ask branch).
   * The UI additionally marks these calls `oneTimeOnly`, so no
   * session/always answer exists to persist in the first place.
   *
   * Effects: run_bash's Seatbelt profile gains a workspace-scoped
   * `.git/config` (and hooks-directory) allow, in addition to the always-on
   * `.git` denies. Absent — the normal case — the denies stand alone.
   */
  approvedGitConfigWrite?: boolean;
}

export interface AskQuestionOption {
  label: string;
  description?: string;
}

export interface AskQuestionItem {
  question: string;
  multiSelect?: boolean;
  options: AskQuestionOption[];
}

export interface ToolContext {
  workingDir: string;
  sessionId: string;
  askUser?: (toolName: string, args: Record<string, unknown>) => Promise<boolean>;
  /** Asks the user one or more multiple-choice (optionally multi-select) questions and returns each answer text keyed by question. */
  askQuestion?: (questions: AskQuestionItem[]) => Promise<Record<string, string> | null>;
  signal: AbortSignal;
  checkpoint?: CheckpointManager;
  fileMtimes?: Map<string, number>;
  /** Per-run todo store (update_todo_list). Defaults to the module singleton;
   *  sub-agents receive a fresh store threaded through the orchestrator's
   *  per-call context. */
  todoStore?: TodoStore;
  /** Session store for persisting todo-list snapshots (update_todo_list).
   *  Absent in headless runs — appends no-op. */
  sessionStore?: SessionStore;
  /** Mode-switch callback (switch_mode tool). Resolves to the mode name, or
   *  null for an unknown slug. Absent when mode switching is not wired. */
  setMode?: (slug: string) => Promise<string | null>;
  /** commands.timeoutToBackground (config-spec.md §13, default ON): when
   *  run_bash hits its 120s cap, migrate the child to JobManager instead of
   *  killing it. Absent (undefined) means the default — ON. */
  timeoutToBackground?: boolean;
  /** OS-sandbox level for bash children (permission-profile.md §8, phase
   *  (e)): when set, run_bash and background-job spawns run under a
   *  Seatbelt profile enforcing the level's fs/network defaults. Absent =
   *  sandbox off (flag off, no profile, or unrestricted). macOS-only — on
   *  other platforms the loader emits a startup notice and spawns stay
   *  policy-only. */
  sandboxLevel?: SandboxLevel;
  /** Effective profile level, threaded to file handlers so their physical
   * containment check uses the same write-set as policy and Seatbelt. */
  writePolicyLevel?: ProfileLevel;
  /** Private, mode-0700 session scratch directory inherited by child processes. */
  sessionTempDir?: string;
  /** Additional directories writable under workspace-write, beyond
   *  `workingDir` and the carve-outs. This combines global
   *  `sandbox.writeRoots` with session-scoped `--add-dir` roots. Raw
   *  (unresolved) config paths are resolved where consumed
   *  (resolveWriteRoots, src/sandbox/write-roots.ts). Threaded to both the
   *  Seatbelt spawn path (run_bash/jobs) and the file-tool containment check
   *  (PermissionEngine) so the two layers agree on the same set. */
  writeRoots?: string[];
  /** web_search backend config (config.webSearch), resolved once at startup
   *  from the EFFECTIVE (post-TOFU-strip) config — never read via a fresh
   *  loadConfig() per call, which would bypass the trust gate for
   *  webSearch.searxngUrl. Absent = Bing-only (today's default). */
  webSearch?: WebSearchConfig;
}

export interface ToolRegistration {
  def: ToolDef;
  handler: ToolHandler;
  groups: ToolGroup[];
  always?: boolean;
}

export type ToolGroup = "read" | "edit" | "command" | "mcp" | "workflow";
