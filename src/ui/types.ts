import type { Provider } from "../providers/types.js";
import type { Message } from "../types.js";
import type { CommandDef } from "../commands/index.js";
import type { ThemeContextValue, ThemeDefinition } from "./theme.js";
import type { KeybindingMap, KeybindingConfig, KeybindingAction } from "./keybindings.js";
import type { StatusLineManager } from "./statusline/index.js";
import type { HookRunner } from "../hooks/index.js";
import type { ProfileEvaluator } from "../permissions/index.js";
import type { TaskRecord } from "../orchestrator/runner.js";
import type { SubagentProgress } from "../orchestrator/index.js";

export interface ModelEntry {
  provider: string;
  model: string;
  contextWindow?: number;
  /** Pretty model name (e.g. "DeepSeek V4 Pro"), falls back to `model` when absent. */
  displayName?: string;
  /** Pretty provider name (e.g. "DeepSeek"), falls back to `provider` when absent. */
  providerLabel?: string;
  /** Whether this model is free to use — renders a "Free" tag in the picker. */
  free?: boolean;
}

// ── State ──

export interface MutableState {
  conversationHistory: Message[];
  sessionInput: number;
  sessionOutput: number;
  lastContextTokens: number;
  sessionUserInputs: string[];
  modelUsage?: Record<string, { input: number; output: number; cached: number }>;
  posture?: "normal" | "autoApprove" | "plan";
}

// ── Status Bar ──

/** A single segment of the status bar, rendered as an Ink <Text> with these props. */
export interface StatusSegment {
  id?: string;
  text: string;
  bold?: boolean;
  dimColor?: boolean;
  color?: string;
  backgroundColor?: string;
  newLine?: boolean;
  /**
   * `text` already contains its own ANSI (a chip, a meter). StatusBar passes it
   * through untouched instead of wrapping it in another colour, which would
   * nest escapes and clobber the embedded background runs.
   */
  raw?: boolean;
}

// ── Tab / Multiplex ──

export interface TabDefinition {
  id: string;
  title: string;
  type: "chat" | "output" | "terminal" | "log" | "custom";
  icon?: string;
  /** Whether this tab can be closed by the user */
  closable: boolean;
  /** Custom metadata */
  meta?: Record<string, unknown>;
}

export interface PaneDefinition {
  id: string;
  direction: "horizontal" | "vertical";
  splitPosition: number; // 0-1 ratio
  tabs: TabDefinition[];
  activeTabId: string;
}

// ── Theme ──

export interface ThemeConfig {
  mode: "dark" | "light" | "auto";
  name?: string;
  overrides?: Partial<ThemeDefinition>;
}

// ── Workflow Integration ──

export interface GitStatus {
  branch: string;
  ahead: number;
  behind: number;
  modified: number;
  added: number;
  deleted: number;
  staged: number;
  conflicts: number;
  dirty: boolean;
}

export interface WorkflowIntegrationConfig {
  /** Show git status in the status bar */
  gitStatus: boolean;
  /** Check git status interval in ms (0 = on demand only) */
  gitPollInterval: number;
  /** Show current branch first in status bar */
  gitBranchFirst?: boolean;
  /** Enable git workflow commands (/git) */
  gitCommands: boolean;
  /** Detect build tools from cwd */
  detectBuildTools: boolean;
}

// ── App Context ──

export interface AppContext {
  mutable: MutableState;

  getProvider: () => Provider;
  sessionId: string;
  /** Lifecycle hooks dispatcher (docs/hooks-spec.md). Undefined when the
   *  session has no hooks configured. */
  hooks?: HookRunner;
  activeMode: any;
  permissions: any;
  /** The capability-boundary gate (permission-profile.md). Undefined when no
   *  `permissionProfile` config — layer 1 absent, today's behavior unchanged. */
  permissionProfile?: ProfileEvaluator;
  toolRegistry: any;
  compactor: any;
  diagnostics: any;
  skills: any[];
  /** Custom slash commands from `.nib/commands/*.md` (project > global). */
  commands: CommandDef[];
  memoryInjection: string | undefined;
  memoryStore: any;
  sessionStore: any;
  checkpoints: any;
  modeLoader: any;
  skillLoader: any;
  providerName: string;
  activeModel: string | undefined;
  activeEffort?: string;
  /** Valid reasoning-effort values for the active model; empty when it has no effort knob. */
  effortValues: () => string[];

  provideAbortController: () => AbortController;
  renewAbortController: () => void;

  completer: (line: string) => [string[], string];

  buildStatusBar: () => StatusSegment[];
  /** Pre-rendered model chip for the input box's right edge. */
  buildModelPill?: () => string;
  /** Active model's display name, with the provider-default fallback applied. */
  modelDisplayName?: () => string;
  /** Config-driven status line providers (command/module). Undefined when no `statusline` config. */
  statusLineManager?: StatusLineManager;
  getPromptStr: () => string;
  getColorEnabled: () => boolean;

  /** Ends the session; resolves with the stall-watchdog report line (or null). */
  logSessionEnd: () => Promise<string | null>;
  onExit: () => void;

  handleSlash: (input: string) => Promise<string[]>;
  getModelEntries: () => ModelEntry[];
  /** Provider name -> whether an API key resolves. Booleans only, never the key. */
  getConfiguredProviders?: () => Record<string, boolean>;
  /** Provider name -> display label (deepseek -> DeepSeek). */
  getProviderLabels?: () => Record<string, string>;
  /** Provider name -> the env var its API key comes from (deepseek -> DEEPSEEK_API_KEY). */
  getKeyEnvByProvider?: () => Record<string, string>;
  /** Favorited models in the /model picker, as "provider/model" ids. */
  getFavoriteModels?: () => string[];
  /** Toggle a model's favorite status, persist it, and return the new list. */
  toggleFavoriteModel?: (id: string) => string[];
  /** Recently-switched-to models for the /model picker, newest first. */
  getRecentModels?: () => { id: string; at: number }[];
  /**
   * Save an API key for `provider` from the picker's inline "Connect
   * provider" prompt. Returns ok:false with a message on failure; never
   * throws the key itself into an error string.
   */
  saveProviderKey?: (provider: string, key: string) => Promise<{ ok: boolean; error?: string }>;
  runAgentTurnCore: (input: string, callbacks: AgentBridgeCallbacks, imageUrls?: string[], planMode?: boolean) => Promise<any>;
  /**
   * Register the async sub-agent result delivery handler (async-subagents.md
   * §2): the orchestrator calls it once per completed sub-run with the
   * formatted result message. The App appends it to the conversation and wakes
   * the parent (idle → new turn, active turn → steering mailbox, mid-typing →
   * queued behind the submission).
   */
  setSubagentResultHandler?: (handler: (taskId: string, message: string) => void) => void;
  /** Kill pending sub-runs on exit (async-subagents.md §3, Q3 — in-memory,
   *  die on exit, where background jobs get killed). */
  abortRunningTasks?: () => void;
  /** Live snapshot of the in-memory task registry (async-subagents.md §3-4):
   *  the /tasks view renders it. */
  getTasks?: () => TaskRecord[];
  /** Abort ONE running sub-run (async-subagents.md §3, Q4 — the /tasks stop
   *  action). Siblings keep running; the aborted run never delivers. */
  abortTask?: (taskId: string) => void;
  /** Register the App's mount-time sub-run progress sink (async-subagents.md
   *  §4): every progress event routes through it AND the per-turn callback,
   *  so streamed text deltas render into the transcript regardless of turn
   *  state (the parent turn has ended while sub-runs work). */
  setSubagentProgress?: (handler: ((event: SubagentProgress) => void) | undefined) => void;
  resumeSession?: (sessionId: string) => Promise<Message[] | null>;
  showResumeOnStart?: boolean;
  /** One-time notice (e.g. "Resumed <id>") shown in the scrollback on mount. */
  initialNotice?: string;
  /**
   * Prior transcript of a resumed session (from the store), replayed into the
   * scrollback on mount. Empty/undefined for a fresh session. The model already
   * sees these via `mutable.conversationHistory`; this is purely for display.
   */
  initialMessages?: Message[];
  /**
   * Compact the resumed transcript on demand (user picks "Compact" at the
   * resume chooser). Runs the summarizer, persists a non-destructive compaction
   * overlay to the session store (raw log is kept), updates the in-memory
   * history, and returns the compacted messages to replay. Returns null if
   * there was nothing to compact.
   */
  compactResumed?: () => Promise<Message[] | null>;
  restoreCheckpoint?: (hash: string, restoreCode: boolean) => Promise<{ restored: boolean; promptDraft: string }>;

  // ── New: Theme & Keybinding support ──
  theme?: ThemeContextValue;
  keybindings?: KeybindingMap;
  keybindingConfig?: KeybindingConfig;

  // ── New: Multiplex support ──
  tabState?: {
    tabs: TabDefinition[];
    activeTabId: string;
    setActiveTab: (id: string) => void;
    addTab: (tab: TabDefinition) => void;
    closeTab: (id: string) => void;
  };

  // ── New: Workflow integration ──
  workflowConfig?: WorkflowIntegrationConfig;
  gitStatus?: GitStatus | null;
  refreshGitStatus?: () => Promise<void>;
}

// ── Agent Bridge Callbacks ──

export interface AgentBridgeCallbacks {
  onText: (c: string) => void;
  onReasoning?: (c: string) => void;
  onToolStart: (name: string, args: Record<string, unknown>) => void;
  onToolResult: (name: string, result: { content: string; error?: string }) => void;
  onDiagnostic: (m: string) => void;
  onRetry: (m: string) => void;
  onCompacted: (m: string) => void;
  onLoopDetected: (m: string) => void;
  onMaxTurns: () => void;
  onUsage: (input: number, output: number) => void;
  onNewMessages: (userInput: string, newMessages: Message[]) => Promise<void>;
  onHistoryUpdate: (messages: Message[]) => void;
  /** Resolves "posture" when an auto-approve posture upgraded the ask without showing a prompt (recorded as allow-by-posture). */
  askUser: (toolName: string, args: Record<string, unknown>) => Promise<boolean | "posture">;
  /** Mid-turn steering mailbox: polled once per decision point by the agent
   *  loop; returns the next queued message or null (the queue head is consumed). */
  pollSteeringMessage?: () => string | null;
}
