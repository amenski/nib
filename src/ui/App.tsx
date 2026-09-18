import React, {
  useState,
  useEffect,
  useCallback,
  useRef,
  useMemo,
} from "react";
import { Box, Text, useInput, useApp } from "ink";
import { previewEdit } from "../permissions/diffpreview.js";
import type { AppContext, StatusSegment, GitStatus } from "./types.js";
import type { PermissionRule } from "../permissions/index.js";
import type { HookEntry } from "../hooks/types.js";
import { extractToolSubject } from "../permissions/rules.js";
import type { KeybindingConfig } from "./keybindings.js";

import {
  ThemeProvider,
  type ThemeProviderOptions,
  useTheme,
  useThemeController,
  KeybindingProvider,
  useKeybindings,
  TerminalProvider,
  useTerminalInfo,
  AccessibilityProvider,
  useAccessibility,
  RawModeProvider,
  useRawMode,
  RefreshProvider,
  useRefresh,
} from "./contexts.js";
import ErrorBoundary from "./ErrorBoundary.js";
import HelpOverlay from "./HelpOverlay.js";
import CommandPalette, {
  type CommandPaletteAction,
} from "./CommandPalette.js";

import OutputArea from "./OutputArea.js";
import {
  streamTextChunk,
  createStreamBlockState,
  type StreamBlockState,
} from "./core/stream-blocks.js";
import { JobOutputCoalescer } from "./core/job-stream.js";
import { jobManager } from "../tools/jobs.js";
import HintBar from "./HintBar.js";
import TodoPanel from "./TodoPanel.js";
import { todoStore } from "../tools/todo.js";
import type { TodoItem } from "../tools/todo.js";
import StatusBar from "./StatusBar.js";
import PermissionPrompt, { DestructiveConfirmPrompt, ScopeChoicePrompt, ExternalScopeChoicePrompt, permissionOptions, type PermissionDecision, type PermissionRequest } from "./PermissionPrompt.js";
import { extractCapabilityPlan } from "../permissions/capabilities.js";
import { isGitConfigOperation } from "../permissions/git-config-operations.js";
import { isEligibleForGrant, type BashEnvelope } from "../permissions/session-grant.js";
import { explainToolAction } from "./explain-action.js";
import { buildWelcomeLines } from "./views/WelcomeScreen.js";
import PromptInput from "./views/PromptInput.js";
import AskUserQuestionPrompt from "./views/AskUserQuestionPrompt.js";
import HookTrustPrompt from "./views/HookTrustPrompt.js";
import SkillTrustPrompt from "./views/SkillTrustPrompt.js";
import type { SkillDef } from "../skills/index.js";
import PlanImplementationPrompt from "./views/PlanImplementationPrompt.js";
import SessionList from "./views/SessionList.js";
import SkillList from "./views/SkillList.js";
import ModeList from "./views/ModeList.js";
import UndoSelector from "./views/UndoSelector.js";
import McpStatusList from "./views/McpStatusList.js";
import TaskList from "./views/TaskList.js";
import PermissionHistoryList from "./views/PermissionHistoryList.js";
import UsageView from "./views/UsageView.js";
import ResumeChooser from "./views/ResumeChooser.js";
import { buildReplayLines } from "./core/replay.js";
import { opensModal } from "./core/modal-commands.js";
import { parseSkillLoadCommand, SKILL_APPLY_PROMPT } from "./core/skill-load.js";
import { findCommand, expandCommand } from "../commands/index.js";
import type { Message } from "../types.js";
import type { AskQuestionItem } from "../tools/types.js";
import { setAskQuestion } from "../tools/index.js";
import { ModelsDropdown, EffortSelector } from "./components/index.js";
import ThemeDropdown, { persistThemeChoice } from "./components/ThemeDropdown/index.js";
import { USER_ECHO_TAG, COMMAND_ECHO_TAG, BULLET_TAG, ANSI_CLEAR_SCREEN } from "./constants.js";
import { seedPromptHistory } from "./core/prompt-history.js";
import { loadPromptHistory, appendPromptHistory } from "./core/history-store.js";
import { summarizeReasoning } from "./core/reasoning-echo.js";
import { resolveRefreshProfile, type ResolvedRefresh } from "./core/refresh-rates.js";
import {
  formatSubagentHeader,
  formatSubagentToolLine,
  formatSubagentFinishLine,
  initSubagentDisplayState,
  type SubagentDisplayState,
} from "./core/subagent-progress-format.js";
import { groupTableLines, splitCommittable } from "./core/table-group.js";
import {
  formatToolCallHeader,
  formatToolResultPreview,
} from "./ToolCallFormatter.js";
import {
  lookupAction,
} from "./keybindings.js";
import { announceToScreenReader } from "./Accessibility.js";

// Display label for a queued item in the above-input stack. A large paste is
// collapsed to a bracket summary ("[Pasted N lines]") rather than dumping the
// whole block into the stack; short messages are shown inline (newlines
// flattened). The stored queue text is unchanged — this is display only.
function queuedLabel(text: string): string {
  const lineCount = text.split("\n").length;
  if (lineCount >= 4 || text.length > 240) {
    return `[Pasted ${lineCount} line${lineCount === 1 ? "" : "s"}]`;
  }
  return text.replace(/\n/g, " ");
}

// The "time capsule" shown in front of a queued line: the local wall-clock time
// (HH:MM) the item was queued, e.g. "[19:24]".
function formatQueueTime(at: number): string {
  const d = new Date(at);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `[${hh}:${mm}]`;
}

// Session tally of finished background jobs, folded into ONE status segment.
// Per-job detail (id, exit code, per-job line count) already streams into the
// transcript as `[job e63e]` rows and check_job results, so the status bar
// only carries the aggregate — one segment regardless of how many jobs ran.
interface JobSummary {
  total: number;
  done: number;
  failed: number;
  killed: number;
  lines: number;
}

// Collapse a JobSummary into its status segment. All-clean reads as a plain
// count (`● 5 jobs done · 247 lines`); any failed/killed job switches the
// segment to red and spells out the outcomes (`● 4 done · 1 killed · 247
// lines`) so the failure is scannable without reading the transcript.
function jobSummaryToSegment(s: JobSummary): StatusSegment {
  const bad = s.failed + s.killed;
  let countText: string;
  if (bad === 0) {
    countText = s.total === 1 ? "1 job done" : `${s.total} jobs done`;
  } else {
    const parts: string[] = [];
    if (s.done > 0) parts.push(`${s.done} done`);
    if (s.failed > 0) parts.push(`${s.failed} failed`);
    if (s.killed > 0) parts.push(`${s.killed} killed`);
    countText = parts.join(" · ");
  }
  const lineText = s.lines === 1 ? "1 line" : `${s.lines} lines`;
  return {
    text: `● ${countText} · ${lineText}`,
    dimColor: bad === 0,
    color: bad > 0 ? "red" : undefined,
  };
}

function InnerApp({ ctx }: { ctx: AppContext }) {
  const { exit, waitUntilRenderFlush } = useApp();
  const theme = useTheme();
  const themeController = useThemeController();
  const accessibility = useAccessibility();
  const bindings = useKeybindings();
  const rawMode = useRawMode();
  // Repaint cadence, from settings.json / env. See core/refresh-rates.
  const REFRESH = useRefresh();

  // Seeded with the welcome banner so it's the first thing ever committed to
  // scrollback — with committed output flushing through <Static> (see
  // OutputArea.tsx), there is no more separate pinned banner region above it;
  // the banner is just ordinary transcript content. The initializer runs once
  // at mount, so this freezes model/thinking/cwd at their mount-time values —
  // matching the old pinned WelcomeScreen, which never live-updated either.
  // The replay/initialNotice effects (below) APPEND to this state, so seeding
  // here preserves "banner first" ordering on resume.
  const [outputLines, setOutputLines] = useState<string[]>(() =>
    buildWelcomeLines(theme, {
      model: ctx.modelDisplayName?.() ?? ctx.activeModel ?? ctx.providerName,
      thinkingEnabled: true,
      reasoningEffort: undefined,
      cwd: process.cwd(),
    }),
  );
  // Bumped whenever the scrollback is wiped (setOutputLines([])) — remounts
  // OutputArea's <Static> so it forgets what it already flushed. Static
  // content is written straight to the terminal's own scrollback and can't be
  // un-printed, so clearing the array alone would leave stale rows on screen;
  // the actual clear-screen escape is written at each wipe site alongside
  // this bump (see /new, /resume, /undo below).
  const [staticEpoch, setStaticEpoch] = useState(0);
  const [activeLine, setActiveLine] = useState("");
  const [busy, setBusy] = useState(false);
  // Set while exiting: the whole frame collapses to this one line (the resume
  // hint) before ink unmounts, so no input/menu/footer junk lingers on screen.
  const [exitHint, setExitHint] = useState<string | null>(null);
  // Shell-style ↑/↓ recall of what the user has typed. Kept in React state
  // (rather than read off ctx.mutable) because a plain mutation wouldn't
  // re-render PromptInput. Oldest first — useHistoryNavigation walks backwards
  // from the end. Seeded from a resumed session's user turns so recall survives
  // --resume; `sessionUserInputs` can't serve here since it starts empty on
  // resume and is only appended at runtime.
  // Persisted per-project history is the source of truth (like shell history —
  // it survives sessions and includes slash commands, which never enter
  // conversationHistory at all). Seeding from the resumed conversation remains
  // ONLY as the fallback for projects that predate the history file; merging
  // both would duplicate every resumed prompt the file already recorded.
  const [promptHistory, setPromptHistory] = useState<string[]>(() => {
    const persisted = loadPromptHistory(process.cwd());
    if (persisted.length > 0) return persisted;
    return seedPromptHistory(ctx.mutable.conversationHistory);
  });
  // Tail of what was last recorded — dedupes BOTH the in-memory list and the
  // file with one comparison, and survives the setter's async timing.
  const lastRecordedRef = useRef<string | null>(null);
  if (lastRecordedRef.current === null && promptHistory.length > 0) {
    lastRecordedRef.current = promptHistory[promptHistory.length - 1];
  }
  // A turn-scoped "working" indicator, distinct from `busy` (which flips false at
  // the first streamed token so the input unlocks mid-turn). `turnActive` stays
  // true for the whole turn — including the silent stretches during tool calls
  // and follow-up model turns — so progress is always visible while working.
  //
  // This is the ONLY spinner state App owns. The animation frame and elapsed
  // clock live inside <Spinner> so their 80ms/1s ticks don't re-render the
  // transcript — see the comment there.
  const [turnActive, setTurnActive] = useState(false);
  const [statusLine, setStatusLine] = useState<StatusSegment[]>(() =>
    ctx.buildStatusBar(),
  );
  // Segments from config-driven statusline providers (command/module). These
  // refresh asynchronously outside render; the manager pushes fresh segments
  // here via its listener. Appended after the built-in segments in StatusBar.
  const [statusLineProviderSegments, setStatusLineProviderSegments] = useState<
    StatusSegment[]
  >(() => ctx.statusLineManager?.segments ?? []);
  // Aggregate tally of finished background jobs (plan §3). Separate state
  // because buildStatusBar rewrites statusLine wholesale; combined at render
  // like the provider segments. The tally never grows the row — it collapses
  // to one segment however many jobs completed (see jobSummaryToSegment).
  const [jobSummary, setJobSummary] = useState<JobSummary>({
    total: 0,
    done: 0,
    failed: 0,
    killed: 0,
    lines: 0,
  });
  // Todo checklist state, mirrored from the shared store so the panel
  // re-renders on every update_todo_list call. Initialized from the store
  // (empty at mount).
  const [todos, setTodos] = useState<TodoItem[]>(() => todoStore.getTodos());
  const [askPrompt, setAskPrompt] = useState<{
    resolve: (v: boolean | "envelope-grant") => void;
    toolName: string;
    args: Record<string, unknown>;
    winningRule?: PermissionRule;
    /** The rule buildDefaultRule would create — used to show the approval scope. */
    defaultRule?: PermissionRule;
    /** Recursive folder-glob rule offered when a sibling read/write is already approved. */
    folderRule?: PermissionRule;
    /** Recursive tree-glob rule offered when an external read is approved (default rule covers one level only). */
    externalTreeRule?: PermissionRule;
    /** True when this tool does not yet have a safe persistent approval scope. */
    oneTimeOnly?: boolean;
    /** The containment a session grant would cover (docs/permission-ux-redesign.md). */
    envelope?: BashEnvelope;
    /** True once the user picked session/always and is choosing file-vs-folder scope. */
    scopeStage?: boolean;
    /** The session/always decision carried into the scope stage. */
    scopeDecision?: "session" | "always";
    /** Ctrl+E AI explanation state — informational only, never gates the decision. */
    explain?: { status: "loading" | "done" | "error"; text: string };
    /** Canonical, data-only effect declaration shown by the permission prompt. */
    capabilityPlan?: ReturnType<typeof extractCapabilityPlan>;
    workingDir?: string;
    cursor: number;
  } | null>(null);
  // AbortController for an in-flight Ctrl+E explanation stream, so a new
  // request or prompt teardown cancels the previous one.
  const explainAbortRef = useRef<AbortController | null>(null);
  const [showModelDropdown, setShowModelDropdown] = useState(false);
  const [showThemeDropdown, setShowThemeDropdown] = useState(false);
  const [showEffortSelector, setShowEffortSelector] = useState(false);
  // The theme name active when the /theme picker opened — the revert target if
  // the user presses Esc after live-previewing other themes.
  const themeBeforePreviewRef = useRef<string>("dark");
  const [askQuestionPrompt, setAskQuestionPrompt] = useState<{
    questions: AskQuestionItem[];
    resolve: (answers: Record<string, string> | null) => void;
  } | null>(null);
  // TOFU trust confirmation for an unseen project hook (hooks-spec.md §6).
  // Same ask-tier pattern as askUser: a Promise resolved by a modal.
  const [hookTrustPrompt, setHookTrustPrompt] = useState<{
    entry: HookEntry;
    resolve: (trusted: boolean) => void;
  } | null>(null);
  // TOFU trust confirmation for an unseen or changed project skill
  // (skill-spec.md §6, security-spec T4). Same ask-tier pattern; the mount
  // effect below drives one modal per pending skill and applies the decision
  // via loader.acceptTrust before any turn can start.
  const [skillTrustPrompt, setSkillTrustPrompt] = useState<{
    skill: SkillDef;
    status: "new" | "changed";
    resolve: (trusted: boolean) => void;
  } | null>(null);

  // Permission/execution posture, cycled by Shift+Tab: normal → autoApprove → plan.
  // - normal: permissions ask per policy.
  // - autoApprove: non-denied tool calls run without prompting.
  // - plan: model proposes a <proposed_plan> instead of executing.
  type Posture = "normal" | "autoApprove" | "plan";
  const [posture, setPosture] = useState<Posture>("normal");
  const planMode = posture === "plan";
  const [planPrompt, setPlanPrompt] = useState<{
    planText: string;
    followUpPrompt: string;
  } | null>(null);
  const [showSessionList, setShowSessionList] = useState(false);
  const [showSkillList, setShowSkillList] = useState(false);
  const [showModeList, setShowModeList] = useState(false);
  const [showUndoSelector, setShowUndoSelector] = useState(false);
  // Checkpoint entries for the /undo selector. list() went async when the
  // checkpoint manager dropped execSync (the 475ms main-thread block the stall
  // profile caught) — and ctx.checkpoints is typed `any`, so WITHOUT this state
  // hop TypeScript would happily pass the Promise straight into UndoSelector
  // and /undo would silently show nothing. Loaded when the selector opens.
  const [undoCheckpoints, setUndoCheckpoints] = useState<{ hash: string; message: string; timestamp: string }[]>([]);
  useEffect(() => {
    if (!showUndoSelector) return;
    let live = true;
    Promise.resolve(ctx.checkpoints?.list?.() ?? [])
      .then((l) => { if (live) setUndoCheckpoints(l ?? []); })
      .catch(() => { if (live) setUndoCheckpoints([]); });
    return () => { live = false; };
  }, [showUndoSelector]);
  const [showMcpStatus, setShowMcpStatus] = useState(false);
  const [showTasks, setShowTasks] = useState(false);
  const [showPermissionHistory, setShowPermissionHistory] = useState(false);
  const [showUsage, setShowUsage] = useState(false);
  // Startup resume chooser: null until a resumed session offers the load/compact
  // choice, then holds the message count for the prompt. Set in the mount effect.
  const [resumeChoice, setResumeChoice] = useState<{ count: number } | null>(null);
  const [compactingResume, setCompactingResume] = useState(false);
  // Messages from an in-app /resume pick, awaiting the load/compact choice. Null
  // when the chooser is driven by the startup path (which uses ctx.initialMessages).
  const pendingResumeRef = useRef<Message[] | null>(null);
  // Last persisted todo plan of a resumed session, restored on the first turn.
  const resumedTodosRef = useRef<TodoItem[] | null>(null);
  const [promptDraft, setPromptDraft] = useState<{ nonce: number; text: string } | null>(null);
  const draftNonceRef = useRef(0);

  const [showHelp, setShowHelp] = useState(false);
  const [showCommandPalette, setShowCommandPalette] = useState(false);

  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null);

  // Queue of user submissions (messages or slash commands) entered while a turn
  // is in flight. Drained FIFO, one turn at a time, when the active turn ends.
  // `at` is the wall-clock time the item was queued (ms epoch), shown as a
  // "time capsule" in front of each stacked line.
  type QueuedItem =
    | { kind: "message"; text: string; at: number; imageUrls?: string[] }
    | { kind: "slash"; text: string; at: number };
  const messageQueueRef = useRef<QueuedItem[]>([]);
  // Text + queue time of each item in arrival order, shown stacked above the input.
  const [queuedItems, setQueuedItems] = useState<Array<{ text: string; at: number }>>([]);
  // Mirror the queue's current contents into render state; called from every
  // enqueue/drain site so the stack stays in sync.
  const syncQueueState = () => {
    setQueuedItems(messageQueueRef.current.map((q) => ({ text: q.text, at: q.at })));
  };
  // Mirrors "any modal footer view is open" for the queue drain, which runs
  // outside React's render cycle and can't read the latest state directly.
  const modalOpenRef = useRef(false);
  // True from the moment a turn starts until its `finally` runs. Distinct from
  // `busy` (the UI flag), which flips false on the first streamed token so the
  // input becomes interactive mid-turn — the queue must drain on real turn
  // completion, not on that first-token signal.
  const turnActiveRef = useRef(false);
  // Current text in the input box, mirrored from PromptInput's onDraftChange.
  // Lets the sub-agent result wake tell "user is mid-typing" apart from "idle"
  // so the result queues behind the pending submission instead of preempting
  // it (async-subagents.md §2, Q1). Stable identity so PromptInput's memo
  // keeps skipping re-renders (the handler touches only the ref).
  const draftTextRef = useRef("");
  const onPromptDraftChange = useCallback((text: string) => {
    draftTextRef.current = text;
  }, []);

  useEffect(() => {
    if (ctx.showResumeOnStart) {
      setShowSessionList(true);
      ctx.showResumeOnStart = false;
    }
    if (ctx.initialNotice) {
      const lines = ctx.initialNotice.split("\n");
      setOutputLines((prev) => [...prev, ...lines.map((l) => (theme.colorEnabled ? `\x1b[2m${l}\x1b[0m` : l))]);
    }
    // A resumed session with prior turns offers a load/compact choice before its
    // transcript is replayed into the scrollback. The chooser handlers do the
    // actual replay (see handleResumeLoad / handleResumeCompact).
    if (ctx.initialMessages && ctx.initialMessages.length > 0) {
      setResumeChoice({ count: ctx.initialMessages.length });
    }
  }, []);

  // Async sub-agent delivery (async-subagents.md §2, Q1). Registered once at
  // mount — the handler touches only refs, so it never goes stale across
  // turns. Wake rule: a completed sub-run's result is queued like a mid-turn
  // submission, then
  //   - idle (no turn, no draft) → the drain starts a turn with the result as
  //     its prompt right away;
  //   - a turn is active → the existing steering mailbox (pollSteeringMessage)
  //     consumes the queue head at the next decision point;
  //   - the user is mid-typing → it stays queued behind the pending submission
  //     (submitted first, result drains after — the simplest correct version of
  //     the race the design leaves to us).
  // In every case the message runs through the normal turn path, so it is
  // echoed and persisted exactly once, like any user message.
  useEffect(() => {
    ctx.setSubagentResultHandler?.((_taskId, message) => {
      // The completed run just left the registry — refresh the bar so the
      // `● task <id> running` segment (or the wake turn's own rebuild) can
      // drop it without waiting for the next turn to end.
      setStatusLine(ctx.buildStatusBar());
      messageQueueRef.current.push({ kind: "message", text: message, at: Date.now() });
      setQueuedItems(messageQueueRef.current.map((q) => ({ text: q.text, at: q.at })));
      if (
        !turnActiveRef.current &&
        !modalOpenRef.current &&
        draftTextRef.current.trim() === ""
      ) {
        drainQueueRef.current();
      }
    });
  }, [ctx]);

  // Lifecycle hooks (hooks-spec.md): SessionStart fires once at session
  // startup, after the TOFU trust check, before the first turn. The App owns
  // the ask-tier trust confirmation (same Promise+modal pattern as askUser):
  // an unseen project hook prompts exactly once per session until trusted.
  useEffect(() => {
    if (!ctx.hooks) return;
    ctx.hooks.confirmTrust = (entry) =>
      new Promise<boolean>((resolve) => {
        setHookTrustPrompt({ entry, resolve });
      });
    void ctx.hooks.dispatch("SessionStart", {});
  }, [ctx.hooks]);

  // Skill TOFU (security-spec T4): skills load before Ink mounts, so
  // untrusted project skills are deferred (loader.pendingTrust) and asked
  // here, one modal per skill, in load order. The modal blocks input until
  // answered, so no turn — and no system prompt containing the skill's index
  // line — can start before every decision lands. Same Promise+modal pattern
  // as the hook trust ask.
  useEffect(() => {
    const loader = ctx.skillLoader;
    if (!loader || loader.pendingTrust.length === 0) return;
    let cancelled = false;
    void (async () => {
      for (const pending of [...loader.pendingTrust]) {
        if (cancelled) return;
        const trusted = await new Promise<boolean>((resolve) => {
          setSkillTrustPrompt({ skill: pending.skill, status: pending.status, resolve });
        });
        if (cancelled) return;
        loader.acceptTrust(pending.skill, trusted);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ctx.skillLoader]);

  // Config-driven statusline providers: subscribe and run the async refresh
  // loop. Segments are pushed in from outside render; the loop never blocks or
  // crashes the render (each provider is isolated in the manager).
  useEffect(() => {
    const mgr = ctx.statusLineManager;
    if (!mgr) return;
    mgr.onUpdate(setStatusLineProviderSegments);
    mgr.start();
    return () => mgr.stop();
  }, []);

  // Background-job completion (plan §3): a finished job folds into the
  // aggregate jobSummary — one status segment no matter how many jobs ran.
  // Subscribed once at mount; cleanup unsubscribes.
  useEffect(() => {
    const offCompleted = jobManager.onCompleted((report) => {
      setJobSummary((prev) => {
        const lineCount = (report.stdout + report.stderr)
          .split("\n")
          .filter((l) => l.trim() !== "").length;
        return {
          total: prev.total + 1,
          done: prev.done + (report.status === "done" ? 1 : 0),
          failed: prev.failed + (report.status === "failed" ? 1 : 0),
          killed: prev.killed + (report.status === "killed" ? 1 : 0),
          lines: prev.lines + lineCount,
        };
      });
    });
    return offCompleted;
  }, []);

  // Background-job live output (plan §3, decision E): JobManager emits output
  // events only for jobs started via the run_bash_background tool, so this
  // streams exactly those — no global job telemetry. Chunks are coalesced per
  // job at ~200ms and committed as dim transcript rows; <Static> renders each
  // row once, so the cadence costs a single row per flush, never a repaint
  // storm. A completing job flushes its buffered tail immediately.
  useEffect(() => {
    const coalescers = new Map<string, JobOutputCoalescer>();
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const flushJob = (jobId: string) => {
      const timer = timers.get(jobId);
      if (timer) clearTimeout(timer);
      timers.delete(jobId);
      const coalescer = coalescers.get(jobId);
      if (!coalescer) return;
      coalescer.flush();
      if (!coalescer.hasPending) coalescers.delete(jobId);
    };
    const appendJobRows = (jobId: string, text: string) => {
      const body = text.replace(/\n$/, "");
      if (!body) return;
      const shortId = jobId.slice(0, 4);
      const rows = body.split("\n").map((l) => `[job ${shortId}] ${l}`);
      setOutputLines((prev) => [
        ...prev,
        ...rows.map((l) => (theme.colorEnabled ? `\x1b[2m${l}\x1b[0m` : l)),
      ]);
    };
    const offOutput = jobManager.onOutput((jobId, chunk) => {
      let coalescer = coalescers.get(jobId);
      if (!coalescer) {
        coalescer = new JobOutputCoalescer((text) => appendJobRows(jobId, text));
        coalescers.set(jobId, coalescer);
      }
      coalescer.push(chunk);
      if (!timers.has(jobId)) {
        timers.set(jobId, setTimeout(() => {
          timers.delete(jobId);
          flushJob(jobId);
        }, 200));
      }
    });
    const offCompleted = jobManager.onCompleted((report) => flushJob(report.id));
    return () => {
      offOutput();
      offCompleted();
      for (const t of timers.values()) clearTimeout(t);
    };
  }, []);

  // Async sub-run live text (async-subagents.md §4): a running sub-agent's
  // streamed text renders as dim `[agent <name>]` transcript rows — coalesced
  // per agent at ~200ms exactly like background-job output above. The sink is
  // registered ONCE at mount: the per-turn progress sink is re-pointed every
  // turn, but sub-runs work BETWEEN turns, so this subscription must survive
  // turn boundaries (cli.tsx's runAgentTurnCore routes every progress event
  // through both). A finishing run ("end") flushes its buffered tail
  // immediately.
  useEffect(() => {
    const coalescers = new Map<string, JobOutputCoalescer>();
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const flushAgent = (key: string) => {
      const timer = timers.get(key);
      if (timer) clearTimeout(timer);
      timers.delete(key);
      const coalescer = coalescers.get(key);
      if (!coalescer) return;
      coalescer.flush();
      if (!coalescer.hasPending) coalescers.delete(key);
    };
    const appendAgentRows = (label: string, text: string) => {
      const body = text.replace(/\n$/, "");
      if (!body) return;
      const rows = body.split("\n").map((l) => `[${label}] ${l}`);
      setOutputLines((prev) => [
        ...prev,
        ...rows.map((l) => (theme.colorEnabled ? `\x1b[2m${l}\x1b[0m` : l)),
      ]);
    };
    ctx.setSubagentProgress?.((event) => {
      if (event.kind === "text") {
        const label = `agent ${event.agent ?? "sub"}`;
        const key = `${label}:${event.depth}`;
        let coalescer = coalescers.get(key);
        if (!coalescer) {
          coalescer = new JobOutputCoalescer((text) => appendAgentRows(label, text));
          coalescers.set(key, coalescer);
        }
        coalescer.push(event.text);
        if (!timers.has(key)) {
          timers.set(key, setTimeout(() => {
            timers.delete(key);
            flushAgent(key);
          }, 200));
        }
      } else if (event.kind === "end") {
        // The run finished: flush every live coalescer so its tail renders
        // without waiting for the cadence.
        for (const key of [...coalescers.keys()]) flushAgent(key);
      }
    });
    return () => {
      for (const t of timers.values()) clearTimeout(t);
    };
  }, [ctx]);

  // Mirror the shared todo store into React state. The store pushes a new array
  // per update_todo_list call; event-driven, so no timers repaint the panel.
  useEffect(() => todoStore.subscribe(setTodos), []);

  useEffect(() => {
    // Gate + interval come from config (workflow.gitStatus / gitPollInterval).
    const wf = ctx.workflowConfig;
    if (wf && wf.gitStatus === false) {
      setGitStatus(null);
      return;
    }
    const pollInterval = wf?.gitPollInterval ?? 30000;
    let cancelled = false;
    async function refreshGit() {
      try {
        // MUST stay async. These ran under execSync, which blocks the main
        // thread for as long as git takes — measured at 100-670ms on real
        // repos (it scales with worktree size, and the @{upstream} rev-list
        // can touch the network). On a 30s timer that freezes the spinner AND
        // the elapsed clock together, which reads as a recurring "Working…"
        // hang. See docs/input-stall-diagnosis.md for the freeze taxonomy.
        const { exec } = await import("node:child_process");
        const { promisify } = await import("node:util");
        const run = promisify(exec);
        const git = async (cmd: string): Promise<string> => {
          try {
            const { stdout } = await run(cmd, { encoding: "utf-8", timeout: 3000 });
            return stdout.trim();
          } catch {
            return "";
          }
        };

        const branch = await git("git rev-parse --abbrev-ref HEAD 2>/dev/null");
        if (!branch || cancelled) {
          if (!branch) setGitStatus(null);
          return;
        }
        // Independent reads — run concurrently rather than serially.
        const [status, aheadBehind] = await Promise.all([
          git("git status --porcelain=v1 2>/dev/null"),
          git("git rev-list --count --left-right HEAD...@{upstream} 2>/dev/null"),
        ]);
        if (cancelled) return;

        const modified = status
          ? status.split("\n").filter((l) => l.startsWith(" M") || l.startsWith("M ")).length
          : 0;
        const added = status
          ? status.split("\n").filter((l) => l.startsWith("??")).length
          : 0;
        const deleted = status
          ? status.split("\n").filter((l) => l.startsWith(" D") || l.startsWith("D ")).length
          : 0;
        let ahead = 0;
        let behind = 0;
        if (aheadBehind) {
          const parts = aheadBehind.split("\t");
          if (parts.length >= 2) {
            ahead = parseInt(parts[0], 10) || 0;
            behind = parseInt(parts[1], 10) || 0;
          }
        }

        if (!cancelled) {
          setGitStatus({
            branch,
            ahead,
            behind,
            modified,
            added,
            deleted,
            staged: 0,
            conflicts: 0,
            dirty: modified > 0 || added > 0 || deleted > 0,
          });
        }
      } catch {
        if (!cancelled) setGitStatus(null);
      }
    }
    refreshGit();
    // gitPollInterval of 0 = on-demand only: run once, no recurring poll.
    if (pollInterval <= 0) {
      return () => {
        cancelled = true;
      };
    }
    const interval = setInterval(refreshGit, pollInterval);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [ctx.workflowConfig]);

  const activeLineRef = useRef("");
  const firstTokenRef = useRef(false);
  const cancelled = useRef(false);

  const outputQueueRef = useRef<string[]>([]);
  const flushTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Streaming line/paragraph state (core/stream-blocks.ts): the unconsumed
  // chunk tail, the held paragraph (open span or list block), and any open
  // fence. Survives across onText calls within a turn; reset at turn end.
  const streamStateRef = useRef<StreamBlockState>(createStreamBlockState());

  const reasoningRef = useRef<{ buffer: string; flushed: boolean }>({ buffer: "", flushed: false });

  // Throttle the RENDERED active line to one commit per interval. Every
  // streamed chunk used to call setActiveLine directly, so a fast model could
  // trigger dozens of Ink frame writes per second — each one repainting the
  // terminal (visible flicker in Terminal.app). `activeLineRef` always holds
  // the freshest text for the places that read it synchronously (tool-start
  // flush, turn-end commit); only the rendered value lags by up to one
  // interval. The interval comes from the active refresh profile, so a slow
  // terminal can trade streaming smoothness for a stable frame.
  const activeLineFlushRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function setActiveLineBoth(v: string) {
    activeLineRef.current = v;
    if (activeLineFlushRef.current) return;
    activeLineFlushRef.current = setTimeout(() => {
      activeLineFlushRef.current = null;
      setActiveLine(activeLineRef.current);
    }, REFRESH.activeLineMs);
  }

  function setFirstTokenBoth(v: boolean) {
    firstTokenRef.current = v;
  }

  // Commit queued output lines into the transcript.
  //
  // On a non-final (timer) flush, an open table run — a suffix of the queue
  // where every line is still `|`-prefixed — is held back rather than
  // committed: it may still be mid-stream, and once a line is committed it
  // flushes to Ink's <Static> and can never be retroactively merged with rows
  // that arrive later (see core/table-group.ts). `final` (turn end, or the
  // unmount cleanup) commits everything regardless, since no more rows are
  // coming.
  function flushOutputQueue(final = false) {
    const queue = outputQueueRef.current;
    if (queue.length === 0) return;

    const { commit, hold } = splitCommittable(queue, final);
    if (commit.length === 0) return;

    outputQueueRef.current = hold;
    setOutputLines((prev) => [...prev, ...groupTableLines(commit)]);
  }

  function startFlushTimer() {
    stopFlushTimer();
    flushTimerRef.current = setInterval(flushOutputQueue, REFRESH.flushMs);
  }

  function stopFlushTimer() {
    if (flushTimerRef.current) {
      clearInterval(flushTimerRef.current);
      flushTimerRef.current = null;
    }
  }

  // The spinner animation and elapsed clock own their own timers inside
  // <Spinner>, driven by `turnActive`. Starting/stopping them here would
  // reintroduce the per-tick re-render of the whole transcript.

  useEffect(() => {
    return () => {
      stopFlushTimer();
      flushOutputQueue(true);
      if (activeLineFlushRef.current) {
        clearTimeout(activeLineFlushRef.current);
        activeLineFlushRef.current = null;
      }
    };
  }, []);

  function pushOutput(line: string) {
    if (rawMode.mode === "raw") {
      process.stdout.write(line + "\n");
    } else {
      setOutputLines((prev) => [...prev, line]);
    }
  }

  /**
   * Wipe the scrollback: write the clear-screen escape, remount <Static> (so
   * it forgets what it already flushed to the real terminal scrollback — that
   * content can't be un-printed, only visually cleared), then reset the lines
   * array to `next`. Static content is already in the terminal's own
   * scrollback, not just this array, so clearing the array alone would leave
   * stale rows on screen; the escape + remount is what actually erases them.
   */
  function wipeScrollback(next: string[]) {
    process.stdout.write(ANSI_CLEAR_SCREEN);
    setStaticEpoch((e) => e + 1);
    setOutputLines(next);
  }

  // Batched append — one state update for many lines (used by resume replay so a
  // long transcript doesn't trigger a re-render per line).
  function pushOutputLines(lines: string[]) {
    if (lines.length === 0) return;
    if (rawMode.mode === "raw") {
      for (const l of lines) process.stdout.write(l + "\n");
    } else {
      setOutputLines((prev) => [...prev, ...groupTableLines(lines)]);
    }
  }

  // Resume chooser handlers. "Load" replays the raw transcript; "Compact" runs
  // the summarizer (persisted as a non-destructive overlay by the host), then
  // replays the shorter result. Both close the chooser and drop the "N messages"
  // notice, which the replay supersedes.
  const replayResumed = useCallback((messages: Message[]) => {
    const lines = buildReplayLines(messages, theme.colorEnabled);
    pushOutputLines(lines);
    setResumeChoice(null);
    pendingResumeRef.current = null;
  }, [theme.colorEnabled]);

  // Restore the previous session's last todo plan (persisted by
  // update_todo_list) so the panel and the model's first turn see it. The
  // single choke point for both startup and in-app /resume replays.
  useEffect(() => {
    const store = ctx.sessionStore as { queryTodos?: (id: string) => Promise<{ todos: { content: string; status: string }[] }[]> } | undefined;
    if (!store || typeof store.queryTodos !== "function") return;
    store.queryTodos(ctx.sessionId).then((rows) => {
      if (rows.length > 0) resumedTodosRef.current = rows[rows.length - 1].todos as TodoItem[];
    }).catch(() => {});
  }, [ctx.sessionStore, ctx.sessionId]);

  // The chooser is fed either by an in-app /resume pick (pendingResumeRef) or by
  // the startup path (ctx.initialMessages). Compaction operates on shared history
  // in both cases, so this fallback only matters for the "Load entirely" branch.
  const resumeSource = useCallback(
    () => pendingResumeRef.current ?? ctx.initialMessages ?? [],
    [ctx.initialMessages],
  );

  const handleResumeLoad = useCallback(() => {
    replayResumed(resumeSource());
  }, [resumeSource, replayResumed]);

  const handleResumeCompact = useCallback(async () => {
    if (!ctx.compactResumed) {
      replayResumed(resumeSource());
      return;
    }
    setCompactingResume(true);
    try {
      const compacted = await ctx.compactResumed();
      replayResumed(compacted ?? resumeSource());
    } catch (err) {
      pushOutput(`Compaction failed: ${(err as Error).message}. Loading full transcript.`);
      replayResumed(resumeSource());
    } finally {
      setCompactingResume(false);
    }
  }, [ctx.compactResumed, resumeSource, replayResumed]);

  const runAgentTurn = useCallback(
    async (input: string, imageUrls?: string[], options?: { echo?: boolean }) => {
      if (!input.trim()) return;

      // The turn gate closes before the (potentially slow) hook dispatch so a
      // submission typed while a UserPromptSubmit hook runs cannot start a
      // second concurrent turn; a block reopens the gate.
      turnActiveRef.current = true;

      // UserPromptSubmit fires before a top-level submitted message enters the
      // agent (hooks-spec.md §2). Mid-turn steered injections never pass
      // through here (they go via pollSteeringMessage inside the loop), so
      // they are skipped by construction. Block = message not sent, user
      // notified; exit-0 stdout is appended to the prompt as context.
      if (ctx.hooks) {
        const ups = await ctx.hooks.dispatch("UserPromptSubmit", { prompt: input });
        if (ups.blocked) {
          turnActiveRef.current = false;
          pushOutput("[UserPromptSubmit hook blocked the message]");
          return;
        }
        if (ups.stdout.trim() !== "") {
          input = `${input}\n\n${ups.stdout.trimEnd()}`;
        }
      }

      // Fresh checklist per turn: clear the previous turn's (dimmed) list. The
      // store subscriber above clears the panel synchronously. After the turn
      // ends the last state stays on screen — dimmed — until the next turn.
      todoStore.reset();
      // A resumed session restores its last plan (queryTodos ran at mount);
      // the first post-resume turn carries it into the model's context via
      // the existing getTodos volatile injection.
      if (resumedTodosRef.current) {
        todoStore.setTodos(resumedTodosRef.current);
        resumedTodosRef.current = null;
      }

      const scheduleOutput = (line: string) => {
        if (rawMode.mode === "raw") {
          process.stdout.write(line + "\n");
        } else {
          outputQueueRef.current.push(line);
        }
      };

      setActiveLineBoth("");
      setBusy(true);
      setTurnActive(true);
      setFirstTokenBoth(false);
      startFlushTimer();
      cancelled.current = false;
      reasoningRef.current = { buffer: "", flushed: false };
      const turnStart = Date.now();
      // Set on each sub-agent "start" event so the "finished" line can report
      // that sub-run's own duration rather than the whole turn's.
      let subagentStart = turnStart;
      // Per-depth child-tool-call bookkeeping for the inline sub-agent display
      // (subagent-progress-format.ts): how many "└ Tool(args)" lines have
      // printed at this depth so far, so the rollup line only prints once the
      // cap is crossed. Keyed by depth like the rest of this renderer — two
      // sub-agents at the same depth already share one line prefix today, so
      // this introduces no new ambiguity. Reset every turn, same lifetime as
      // subagentStart.
      const subagentDisplay = new Map<number, SubagentDisplayState>();

      announceToScreenReader("Nib is processing your request", "polite");

      // Echo the user's message as a full-width highlighted bar with a "›"
      // chevron (Claude Code style) — the background fill makes input
      // unmistakable, so the assistant reply below can stay plain flush-left
      // text marked only by a leading "●" bullet.
      //
      // A synthetic turn (the one `/skill` starts) suppresses this: the user
      // did not type that text, and a "› …" bar for it would read as if they
      // had.
      if (options?.echo !== false) {
        scheduleOutput("");
        scheduleOutput(USER_ECHO_TAG + input);
        scheduleOutput("");
      }

      // The assistant's answer opens with a dim "●" bullet on the first line of
      // a fresh answer block; continuation lines stay plain. `atBlockStart` is
      // true until the first non-empty text line of the current block is
      // emitted, then resets after each tool call so the next answer re-bullets.
      // The bullet is a TAG, not a string prefix on the markdown itself — a
      // prepended "● " would defeat block-level markdown regexes anchored at
      // the start of the line (e.g. "● ## Plan" no longer looks like a
      // heading). OutputArea strips the tag and renders the bullet as a
      // separate element beside <MarkdownText>.
      let atBlockStart = true;
      const withBullet = (line: string): string =>
        atBlockStart && line !== "" ? BULLET_TAG + line : line;

      // Feed for the streaming state machine (core/stream-blocks.ts): the
      // chunk stream is buffered into complete lines, held while a span or
      // list block may still rejoin, and committed as whole entries (a span
      // closed across newlines renders bold; a wrapped list item stays one
      // bullet). The machine's own `activeLine` is the live preview.
      const consumeStream = (c: string) => {
        const { lines: emitted, activeLine, state: next } = streamTextChunk(
          streamStateRef.current,
          c,
        );
        // streamTextChunk is pure: it copies the input state and returns the
        // advanced one. Without storing it back, every chunk restarts from the
        // empty state and held paragraphs (open span, list block, fence) are
        // silently dropped — the closing marker or continuation never joins
        // the line it belongs to.
        streamStateRef.current = next;
        for (const l of emitted) {
          scheduleOutput(withBullet(l));
          // Per line, not per batch. One chunk often commits a paragraph AND
          // the blank line that ends it (stream-blocks passes the blank
          // through for spacing); flipping only after the loop bulleted every
          // entry in the batch, and a bulleted "" renders as a bare "●" row.
          if (l !== "") atBlockStart = false;
        }
        return activeLine;
      };
      const flushStream = () => {
        // A flush site (tool boundary, turn end, blank line inside the chunk
        // stream, error path) commits any held paragraph — its lines are
        // complete, only their closing marker/continuation may have been
        // pending. Unclosed spans render as literal markers (MAX_HELD_LINES
        // bounds how long a literal "**kwargs" can stall a turn).
        const s = streamStateRef.current;
        if (s.buffer !== "" || s.pending.length > 0 || s.fence) {
          const { lines: emitted, state: next } = streamTextChunk(s, "\n");
          streamStateRef.current = next;
          if (emitted.length > 0) {
            for (const l of emitted) {
              scheduleOutput(withBullet(l));
              if (l !== "") atBlockStart = false;
            }
            // The committed lines are exactly what the active-line preview was
            // showing (held paragraph + partial tail), so the preview is now in
            // the transcript. Clear it — otherwise the flush site's own
            // `if (activeLineRef.current)` would schedule the same content a
            // second time. An OPEN FENCE emits nothing, so its preview is left
            // in place for the turn-end path to commit it as a code block.
            activeLineRef.current = "";
          }
        }
      };

      let needTextSeparator = false;
      let textBuffer = "";
      // True while the machine holds a paragraph (span/list) or an open fence
      // — the active line is live-previewed rather than committed yet.
      let holding = false;

      // The echo is a marker that reasoning happened, not a transcript of it —
      // the full text is already in the model's context and is not addressed to
      // the user. Emitting the whole buffer produced one ~1500-char line that
      // wrapped to seven or more rows in a single commit, shifting every row
      // below it at once; the incremental renderer can only reuse rows that keep
      // their index, so the lower frame repainted in one jolt. Both modes now
      // collapse to the same single row.
      function flushReasoning() {
        const { buffer, flushed } = reasoningRef.current;
        if (flushed) return;
        const summary = summarizeReasoning(buffer);
        if (summary === null) return;
        reasoningRef.current.flushed = true;
        scheduleOutput(theme.colorEnabled ? `\x1b[2m✱ ${summary}\x1b[0m` : `✱ ${summary}`);
      }

      const callbacks = {
        onReasoning: (c: string) => {
          if (!firstTokenRef.current) {
            setFirstTokenBoth(true);
            setBusy(false);
          }
          reasoningRef.current.buffer += c;
        },
        onText: (c: string) => {
          flushReasoning();
          if (!firstTokenRef.current) {
            setFirstTokenBoth(true);
            setBusy(false);
          }
          // Feed the chunk through the stream state machine. Complete lines
          // are committed (whole paragraphs, completed fences, blanks); the
          // machine's activeLine is the live preview of what is still held.
          const prevHolding = holding;
          const active = consumeStream(c);
          holding = active !== "";
          if (active !== "" && !prevHolding) {
            setActiveLineBoth(withBullet(active));
          } else if (active !== "" && prevHolding) {
            // A line already on screen (held) is being extended — update the
            // rendered line in place rather than committing the older text.
            setActiveLineBoth(withBullet(active));
          } else if (active === "") {
            setActiveLineBoth("");
          }
          if (
            needTextSeparator &&
            streamStateRef.current.buffer === "" &&
            streamStateRef.current.pending.length === 0
          ) {
            needTextSeparator = false;
            scheduleOutput("");
          }
          textBuffer = "";
        },
        onToolStart: (name: string, args: Record<string, unknown>) => {
          flushReasoning();
          // Commit any held paragraph — its lines are complete, only their
          // closing marker/continuation may have been pending.
          flushStream();
          if (activeLineRef.current) scheduleOutput(activeLineRef.current);
          setActiveLineBoth("");
          holding = false;
          textBuffer = "";
          atBlockStart = true; // next answer block re-bullets after this tool call
          scheduleOutput("");
          const header = formatToolCallHeader(name, args);
          scheduleOutput(header);
        },
        onToolResult: (
          _name: string,
          result: { content: string; error?: string },
        ) => {
          const content = result.error
            ? `Error: ${result.error}`
            : (result.content ?? "");
          // The TodoPanel renders todo state live; echoing the whole list as a
          // dim preview is noise (the list can be 12 lines). Keep the ⏺ header.
          if (content.trim() !== "" && _name !== "update_todo_list") {
            const isError = !!result.error || content.startsWith("PERMISSION_DENIED") || content.startsWith("COMMAND_FAILED");
            for (const line of formatToolResultPreview(content)) {
              if (theme.colorEnabled) {
                scheduleOutput(isError ? `\x1b[31m${line}\x1b[0m` : `\x1b[2m${line}\x1b[0m`);
              } else {
                scheduleOutput(line);
              }
            }
          }
          needTextSeparator = true;
        },
        onDiagnostic: () => {},
        onRetry: () => {},
        onCompacted: () => {},
        // Live sub-agent activity, styled after Claude Code's inline agent
        // display (Agent(desc) header + nested "└ Tool(args)" child lines).
        // Without these lines the parent renders nothing between the
        // new_task header and the final summary, so a long delegation is
        // indistinguishable from a hang. Indented and dimmed so a sub-agent's
        // tools never read as the parent's own.
        //
        // Static's append-only contract (OutputArea.tsx: a committed line is
        // never repainted) rules out a live "Running…" status per line and a
        // live-toggle collapse — both need to rewrite an already-printed
        // line. subagent-progress-format.ts's rollup ("… +N tool uses")
        // mirrors formatToolResultPreview's own "first N, then …+N" shape
        // instead of inventing a new convention.
        onSubagentProgress: (event: {
          kind: "start" | "tool" | "end";
          task?: string;
          name?: string;
          args?: Record<string, unknown>;
          agent?: string;
          depth: number;
        }) => {
          flushReasoning();
          flushStream();
          let line: string | null;
          if (event.kind === "start") {
            subagentStart = Date.now();
            subagentDisplay.set(event.depth, initSubagentDisplayState());
            line = formatSubagentHeader({
              description: event.task ?? "",
              agentName: event.agent,
              model: ctx.modelDisplayName?.(),
              depth: event.depth,
            });
          } else if (event.kind === "tool") {
            const state =
              subagentDisplay.get(event.depth) ?? initSubagentDisplayState();
            subagentDisplay.set(event.depth, state);
            line = formatSubagentToolLine(
              state,
              event.name ?? "",
              event.args ?? {},
              event.depth,
            );
          } else {
            const took = Date.now() - subagentStart;
            line = formatSubagentFinishLine({ depth: event.depth, elapsedMs: took });
          }
          if (line === null) return;
          scheduleOutput(theme.colorEnabled ? `\x1b[2m${line}\x1b[0m` : line);
        },
        onLoopDetected: (m: string) => {
          scheduleOutput(`[${m}]`);
        },
        onMaxTurns: () => {
          scheduleOutput("[max turns reached. Session saved.]");
        },
        onUsage: () => {
          // Usage totals live on ctx.mutable (sessionInput/sessionOutput) and
          // feed the context meter and `getCostStr()`. Nothing needs to be
          // mirrored into React state — this only refreshes the bar so the ctx
          // meter reflects the new totals.
          setStatusLine(ctx.buildStatusBar());
        },
        onNewMessages: async (userInput: string, newMessages: any[]) => {
          await ctx.sessionStore.appendMessage(ctx.sessionId, {
            role: "user",
            content: userInput,
          });
          for (const msg of newMessages) {
            if (msg.role !== "system") {
              await ctx.sessionStore.appendMessage(ctx.sessionId, msg);
            }
          }
        },
        onHistoryUpdate: (messages: any[]) => {
          ctx.mutable.conversationHistory = messages;
        },
        askUser: async (
          toolName: string,
          args: Record<string, unknown>,
          envelope?: BashEnvelope,
        ) => {
          if (
            [
              "edit",
              "edit_file",
              "write_to_file",
              "write",
              "search_replace",
              "apply_diff",
              "apply_patch",
            ].includes(toolName)
          ) {
            const preview = previewEdit(toolName, args);
            if (preview) scheduleOutput(preview);
          }

          const { action, winningRule, wasUnresolved, isGuarded } = ctx.permissions.resolve(toolName, args);

          // deny should never reach askUser (agent.ts only calls it for "ask"),
          // but handle defensively rather than assume the caller's invariant.
          if (action === "deny") return false;

          // Consolidation M.1 (permission-profile.md §5): the overlay's
          // edit-in-workspace condition is profile-derived — with a profile
          // configured, an edit-group call whose target is inside the
          // profile's effective write-set auto-allows without a prompt.
          // workspace-write's default write-set is the workspace roots (the
          // old isEditToolInWorkspace containment, generalized); strict-sandbox
          // has no write-set, so no edit is overlay-auto-allowed there.
          // Resolves "posture" so the agent records allow-by-posture, the same
          // "allowed without showing a prompt" row the auto-approve bypass
          // uses. Layer 1 already denied any out-of-write-set edit, so an
          // edit that reaches this point is always inside the write-set.
          if (ctx.permissionProfile?.editTargetInWriteSet(toolName, args)) {
            return "posture";
          }

          // These tools do not yet expose their actual command/file targets to
          // the permission layer, so only an interactive one-time approval is
          // safe until capability extraction exists.
          //
          // Config-writing Git commands join them (release gate 2): approving
          // one grants the widened Seatbelt variant for that single command
          // (see ToolExecOptions.approvedGitConfigWrite), so the answer must
          // never become a persisted rule — offering only once/deny is what
          // makes agent.ts's plain `true` an unambiguous per-call grant.
          const oneTimeOnly = toolName === "run_bash_background" || toolName === "apply_patch"
            || isGitConfigOperation(toolName, args);

          // Auto-approve posture bypasses an ordinary rule-derived ask, but
          // never a result the bash normalizer couldn't safely classify, and
          // never a secret-adjacent path guard — both must always surface the
          // real prompt, regardless of posture. "posture" (not true) tells
          // agent.ts to record allow-by-posture instead of ask-approved.
          //
          // Bash is excluded outright (docs/permission-ux-redesign.md): the
          // session grant is the way a Bash ask stops recurring, and consent for
          // it can only come from a prompt. Approving the class silently would
          // keep the prompt count where it is while never creating the grant.
          if (ctx.autoApproveAllowed && ctx.mutable.posture === "autoApprove" && !wasUnresolved && !isGuarded && !oneTimeOnly && toolName !== "run_bash") {
            return "posture";
          }

          // The session grant is offered only where the gate would honor it —
          // the same single predicate agent.ts consults, applied here to the
          // envelope the run handed over, so the option cannot appear on a call
          // the grant would not cover.
          const grantEnvelope = isEligibleForGrant({
            toolName,
            args,
            isGuarded,
            winningRuleOrigin: winningRule?.origin,
            envelope,
          })
            ? envelope
            : undefined;

          return new Promise<boolean | "envelope-grant">((resolve) => {
            const defaultRule = ctx.permissions.buildDefaultRule(toolName, args);
            const folderRule = ctx.permissions.folderScopeRule(toolName, args);
            const externalTreeRule = ctx.permissions.externalTreeRule(toolName, args);
            setAskPrompt({
              resolve,
              toolName,
              args,
              winningRule,
              defaultRule,
              folderRule,
              externalTreeRule,
              oneTimeOnly,
              envelope: grantEnvelope,
              capabilityPlan: extractCapabilityPlan(toolName, args, process.cwd()),
              workingDir: process.cwd(),
              cursor: 0,
            });
          });
        },
        // Mid-turn steering mailbox: the agent loop polls this once per
        // decision point (before each provider call) and injects the message
        // at the next decision point — never mid-stream. Consumes only
        // message-kind items; slash commands stay queued for the drain so
        // FIFO order holds. Esc/abort never touches the queue (decision B),
        // so anything not consumed mid-turn still drains at turn end.
        pollSteeringMessage: () => {
          const head = messageQueueRef.current[0];
          if (!head || head.kind !== "message") return null;
          messageQueueRef.current.shift();
          syncQueueState();
          // Echo the injected message like a normal submission, so the
          // transcript shows what the user typed mid-turn.
          scheduleOutput("");
          scheduleOutput(USER_ECHO_TAG + head.text);
          scheduleOutput("");
          return head.text;
        },
      };

      setAskQuestion(async (questions) => {
        return new Promise<Record<string, string> | null>((resolve) => {
          setAskQuestionPrompt({ questions, resolve });
        });
      });

      try {
        const result = await ctx.runAgentTurnCore(input, callbacks, imageUrls, planMode);

        // A reasoning-only turn (no text, no tool calls) never hits the
        // onText/onToolStart flush sites — surface its ✱ summary here so the
        // turn doesn't end with just the footer.
        flushReasoning();
        flushStream();
        flushOutputQueue(true);

        if (activeLineRef.current) pushOutput(activeLineRef.current);
        setActiveLineBoth("");
        holding = false;
        textBuffer = "";

        // Per-turn completion footer: "✳ Worked for Ns" (dim), mirroring Claude
        // Code — a subtle marker that closes each response block. Padded with a
        // blank line on each side so it isn't crammed against the reply above or
        // the next turn below.
        const elapsedS = Math.max(1, Math.round((Date.now() - turnStart) / 1000));
        const footer = `✳ Worked for ${elapsedS}s`;
        pushOutput("");
        pushOutput(theme.colorEnabled ? `\x1b[2m${footer}\x1b[0m` : footer);
        pushOutput("");

        // Persist on both completion and abort. The agent's messages are only
        // ever built from complete exchanges (partial stream text is held in
        // locals and never pushed), so an aborted turn's `messages` is a valid
        // transcript — and without it, an interrupt left the user's request and
        // the tool calls already made OUT of the session record, while their
        // file edits stayed on disk. On "continue" the model then saw only the
        // dirty tree and assumed the uncommitted work was its own.
        if (result.stopReason === "done" || result.stopReason === "aborted") {
          ctx.mutable.conversationHistory = result.messages;
          await callbacks.onNewMessages(input, result.newMessages);
        }

        if (planMode) {
          const lastAssistant = result.newMessages
            ? [...result.newMessages].reverse().find((m: any) => m.role === "assistant")
            : undefined;
          const replyText: string = lastAssistant?.content ?? "";
          const planMatch = replyText.match(/<proposed_plan>([\s\S]+?)<\/proposed_plan>/);
          if (planMatch && planMatch[1].trim()) {
            setPlanPrompt({ planText: planMatch[1].trim(), followUpPrompt: "" });
          }
        }

        // MessageDisplay (TUI-only): fires when an assistant message renders
        // (hooks-spec.md §2).
        if (ctx.hooks && result.newMessages) {
          const lastAssistant = [...result.newMessages]
            .reverse()
            .find((m: any) => m.role === "assistant");
          if (lastAssistant?.content) {
            await ctx.hooks.dispatch("MessageDisplay", { message: lastAssistant.content });
          }
        }

        announceToScreenReader("Nib has finished processing", "polite");
      } catch (err) {
        flushStream();
        flushOutputQueue(true);
        pushOutput(`Error: ${(err as Error).message}`);
        announceToScreenReader(
          `Error: ${(err as Error).message}`,
          "assertive",
        );
      } finally {
        setAskQuestion(undefined);
        setAskQuestionPrompt(null);
        stopFlushTimer();
        setBusy(false);
        setTurnActive(false);
        // The stream state is turn-scoped: reset so the next turn starts clean
        // (a leftover buffer/pending/fence must never leak across turns).
        streamStateRef.current = createStreamBlockState();
        ctx.renewAbortController();
        setStatusLine(ctx.buildStatusBar());
        turnActiveRef.current = false;
        drainQueueRef.current();
      }
    },
    [ctx, theme, rawMode, planMode],
  );

  // Drain the next queued submission (message or slash command) after a turn
  // ends. Held in a ref so `runAgentTurn`'s `finally` can call the latest
  // version without listing it as a useCallback dependency.
  const drainQueueRef = useRef<() => void>(() => {});
  drainQueueRef.current = () => {
    if (turnActiveRef.current) return;
    // Run queued slash commands synchronously in order; stop at the first
    // message, which starts an async turn that re-triggers this drain from its
    // `finally` when it completes. A modal-opening slash command (e.g. /model,
    // /resume) also stops the drain — the modal owns the screen until dismissed,
    // and the remaining queue drains when the turn/modal flow next completes.
    while (!turnActiveRef.current) {
      const next = messageQueueRef.current.shift();
      syncQueueState();
      if (!next) return;
      if (next.kind === "slash") {
        handleSlashCommand(next.text);
        if (modalOpenRef.current) return;
      } else {
        runAgentTurn(next.text, next.imageUrls);
        return;
      }
    }
  };

  /**
   * Append a submitted prompt for ↑/↓ recall. Skips blanks and collapses an
   * immediate repeat (same as a shell's ignoredups) so holding Enter doesn't
   * fill the history with duplicates.
   */
  function recordPromptHistory(entry: string): void {
    const text = entry.trim();
    if (!text) return;
    // One dedupe for both destinations: the consecutive-repeat check used to
    // live inside the setter, which the persistent file could not see.
    if (text === lastRecordedRef.current) return;
    lastRecordedRef.current = text;
    setPromptHistory((prev) => [...prev, text]);
    // Fire-and-forget by contract: zero synchronous I/O and zero new failure
    // modes on the turn path while a main-thread stall is being hunted.
    void appendPromptHistory(process.cwd(), text);
  }

  // Handles a submission from the input box: runs it now if idle, otherwise
  // enqueues it to drain after the in-flight turn(s) complete.
  function submitFromInput({ text, command, imageUrls }: { text: string; command?: string; imageUrls?: string[] }) {
    // Record for ↑/↓ recall before any early return, so queued and modal
    // submissions land in history too — the user typed them either way.
    recordPromptHistory(command ? `/${command}` : text);
    if (command) {
      if (command === "exit") { handleExit(); return; }
      if (turnActiveRef.current && !opensModal(command)) {
        messageQueueRef.current.push({ kind: "slash", text: `/${command}`, at: Date.now() });
        syncQueueState();
        return;
      }
      handleSlashCommand(`/${command}`);
      return;
    }
    const isSlash = text.startsWith("/");
    if (turnActiveRef.current && !(isSlash && opensModal(text))) {
      messageQueueRef.current.push(isSlash ? { kind: "slash", text, at: Date.now() } : { kind: "message", text, at: Date.now(), imageUrls });
      syncQueueState();
      return;
    }
    if (isSlash) {
      handleSlashCommand(text);
    } else {
      runAgentTurn(text, imageUrls);
    }
  }

  function applyPosture(next: Posture) {
    setPosture(next);
    setPlanPrompt(null);
    // Posture is UI-only state now: the permission engine has no session-wide
    // auto-approve flag. askUser reads ctx.mutable.posture directly and
    // bypasses only ordinary rule-derived asks — deny and unresolved-ask
    // results are never bypassed regardless of posture.
    ctx.mutable.posture = next;
    setStatusLine(ctx.buildStatusBar());
  }

  function cyclePosture() {
    const order: Posture[] = ["normal", "autoApprove", "plan"];
    const idx = order.indexOf(posture);
    applyPosture(order[(idx + 1) % order.length]);
  }

  function handleSlashCommand(trimmed: string) {
    // Echo the command into scrollback as a lightweight dim line, so there's a
    // visible record of what was typed. Commands make no model call, so this is
    // never counted toward context usage.
    pushOutput(COMMAND_ECHO_TAG + trimmed);
    if (trimmed === "/exit") {
      handleExit();
      return;
    }
    if (trimmed === "/model") {
      setShowModelDropdown(true);
      return;
    }
    if (trimmed === "/theme") {
      themeBeforePreviewRef.current = themeController.current;
      setShowThemeDropdown(true);
      return;
    }
    if (trimmed === "/effort") {
      // Only open the picker for models that declare an effort knob; otherwise
      // fall through to the CLI handler, which prints the informative message.
      if (ctx.effortValues().length > 0) {
        setShowEffortSelector(true);
        return;
      }
    }
    if (trimmed === "/new") {
      // Start a fresh conversation: drop the model-visible history and wipe the
      // scrollback so the session reads as new. Same history reset as /clear,
      // plus a visible-transcript clear the bare /clear doesn't do. Re-seeds
      // with the welcome banner so it reappears at the top of the fresh
      // screen — parity with the old pinned WelcomeScreen, which survived
      // clears because it lived outside the transcript entirely.
      ctx.mutable.conversationHistory = [];
      wipeScrollback(
        buildWelcomeLines(theme, {
          model: ctx.modelDisplayName?.() ?? ctx.activeModel ?? ctx.providerName,
          thinkingEnabled: true,
          reasoningEffort: undefined,
          cwd: process.cwd(),
        }),
      );
      pushOutput("[started a fresh conversation]");
      return;
    }
    if (trimmed === "/plan") {
      // Toggle the plan posture on/off — the same posture Shift+Tab cycles to.
      applyPosture(posture === "plan" ? "normal" : "plan");
      pushOutput(posture === "plan" ? "[plan mode off]" : "[plan mode on]");
      return;
    }
    if (trimmed === "/resume" || trimmed === "/continue" || trimmed === "/sessions") {
      setShowSessionList(true);
      return;
    }
    if (trimmed === "/skills") {
      setShowSkillList(true);
      return;
    }
    if (trimmed === "/modes") {
      setShowModeList(true);
      return;
    }
    if (trimmed === "/undo") {
      setShowUndoSelector(true);
      return;
    }
    if (trimmed === "/mcp") {
      setShowMcpStatus(true);
      return;
    }
    if (trimmed === "/tasks") {
      setShowTasks(true);
      return;
    }
    if (trimmed === "/permissions" || trimmed === "/permissions history") {
      setShowPermissionHistory(true);
      return;
    }
    if (trimmed === "/usage") {
      setShowUsage(true);
      return;
    }
    if (trimmed.startsWith("/raw")) {
      const arg = trimmed.slice(4).trim();
      if (arg === "normal") rawMode.setMode("normal");
      else if (arg === "raw" || arg === "raw-scrollback") rawMode.setMode("raw");
      else {
        const next = rawMode.mode === "lite" ? "normal" : rawMode.mode === "normal" ? "raw" : "lite";
        rawMode.setMode(next);
        pushOutput(`Display mode: ${next}`);
      }
      setStatusLine(ctx.buildStatusBar());
      return;
    }
    // Custom slash command (`.nib/commands/*.md`): run the file body as a
    // user prompt, with `$ARGUMENTS` replaced by the trailing args. Builtins
    // win name collisions (this branch sits after every builtin above). The
    // command line is already echoed above, so the turn suppresses its own echo
    // — the expansion can be large and is not what the user typed.
    const customMatch = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(trimmed);
    const customCommand = customMatch ? findCommand(ctx.commands ?? [], customMatch[1]) : undefined;
    if (customCommand) {
      void runAgentTurn(expandCommand(customCommand, customMatch?.[2] ?? ""), undefined, { echo: false });
      return;
    }
    const skillName = parseSkillLoadCommand(trimmed);
    if (skillName) {
      const known = (ctx.skills ?? []).some((s) => s.name === skillName);
      // Claim the turn gate synchronously: the CLI load below is async, and the
      // queue drain loops while this gate is open, so without claiming it here
      // the drain would start the next queued submission and race this turn.
      if (known) turnActiveRef.current = true;
      ctx.handleSlash(trimmed).then((lines) => {
        for (const line of lines) pushOutput(line);
        setStatusLine(ctx.buildStatusBar());
        if (!known) return;
        // Force-load means "start using it now" (skill-spec.md §7). Pushing the
        // skill into history alone left it inert until the user asked again,
        // because no turn was running for it to apply to.
        turnActiveRef.current = false;
        void runAgentTurn(SKILL_APPLY_PROMPT, undefined, { echo: false });
      });
      return;
    }
    ctx.handleSlash(trimmed).then((lines) => {
      for (const line of lines) pushOutput(line);
      setStatusLine(ctx.buildStatusBar());
    });
  }

  const paletteActions: CommandPaletteAction[] = useMemo(
    () => [
      {
        id: "cmd-help",
        label: "/help",
        description: "Show help and keyboard shortcuts",
        category: "command",
        execute: () => setShowHelp(true),
      },
      {
        id: "cmd-clear",
        label: "/clear",
        description: "Clear conversation history",
        category: "command",
        execute: () => handleSlashCommand("/clear"),
      },
      {
        id: "cmd-exit",
        label: "/exit",
        description: "Exit the CLI",
        category: "command",
        execute: () => handleExit(),
      },
      {
        id: "cmd-cost",
        label: "/cost",
        description: "Show session token totals and cost",
        category: "command",
        execute: () => handleSlashCommand("/cost"),
      },
      {
        id: "cmd-usage",
        label: "/usage",
        description: "Show account balance and token usage",
        category: "command",
        execute: () => handleSlashCommand("/usage"),
      },
      {
        id: "cmd-context",
        label: "/context",
        description: "Show context budget breakdown",
        category: "command",
        execute: () => handleSlashCommand("/context"),
      },
      {
        id: "cmd-mode",
        label: "/mode",
        description: "Switch persona (general/code)",
        category: "command",
        execute: () => handleSlashCommand("/modes"),
      },
      {
        id: "cmd-model",
        label: "/model",
        description: "Switch model",
        category: "command",
        execute: () =>
          setShowModelDropdown(true),
      },
      {
        id: "cmd-sessions",
        label: "/sessions",
        description: "List sessions",
        category: "command",
        execute: () => handleSlashCommand("/sessions"),
      },
      {
        id: "cmd-new",
        label: "/new",
        description: "Start a fresh conversation",
        category: "command",
        execute: () => handleSlashCommand("/new"),
      },
      {
        id: "cmd-plan",
        label: "/plan",
        description: "Toggle plan mode",
        category: "command",
        execute: () => handleSlashCommand("/plan"),
      },
      {
        id: "cmd-skills",
        label: "/skills",
        description: "List available skills",
        category: "command",
        execute: () => handleSlashCommand("/skills"),
      },
      {
        id: "action-help",
        label: "Keyboard Shortcuts",
        description: "Show keyboard shortcuts overlay",
        category: "action",
        execute: () => setShowHelp(true),
      },
      {
        id: "action-palette",
        label: "Command Palette",
        description: "Open command palette",
        category: "action",
        execute: () => setShowCommandPalette(true),
      },
      {
        id: "action-model-picker",
        label: "Open Model Picker",
        description: "Select a different AI model",
        category: "action",
        execute: () =>
          setShowModelDropdown(true),
      },
    ],
    [ctx, exit],
  );

  function resolveAskPrompt(allowed: boolean | "envelope-grant"): void {
    // Cancel any in-flight Ctrl+E explanation — its prompt is going away.
    explainAbortRef.current?.abort();
    explainAbortRef.current = null;
    setAskPrompt((prev) => {
      if (!prev) return null;
      const { resolve } = prev;
      setTimeout(() => resolve(allowed), 0);
      return null;
    });
    // No spinner restart needed: the turn never ended while the prompt was up,
    // so `turnActive` stayed true and <Spinner>'s own timers kept running.
    setBusy(true);
  }

  /**
   * Ctrl+E handler: stream an AI explanation of the pending action into the
   * prompt. Purely informational — it never changes the allow/ask/deny
   * decision or the options; the deterministic engine already decided this is
   * an "ask". The model describes the action, it never gates it.
   */
  function requestExplanation(): void {
    if (!askPrompt) return;
    // Already loaded or loading — don't refire.
    if (askPrompt.explain?.status === "loading" || askPrompt.explain?.status === "done") return;

    const { toolName, args } = askPrompt;
    const subject = extractToolSubject(toolName, args);
    const controller = new AbortController();
    explainAbortRef.current?.abort();
    explainAbortRef.current = controller;

    setAskPrompt((prev) => prev ? { ...prev, explain: { status: "loading", text: "" } } : null);

    void (async () => {
      try {
        let acc = "";
        for await (const chunk of explainToolAction(ctx.getProvider(), toolName, subject, controller.signal)) {
          acc += chunk;
          setAskPrompt((prev) =>
            prev && prev.explain ? { ...prev, explain: { status: "loading", text: acc } } : prev,
          );
        }
        setAskPrompt((prev) =>
          prev && prev.explain ? { ...prev, explain: { status: "done", text: acc } } : prev,
        );
      } catch (err) {
        if (controller.signal.aborted) return;
        setAskPrompt((prev) =>
          prev && prev.explain
            ? { ...prev, explain: { status: "error", text: "Couldn't generate an explanation." } }
            : prev,
        );
      } finally {
        if (explainAbortRef.current === controller) explainAbortRef.current = null;
      }
    })();
  }

  /**
   * The pending ask as a PermissionRequest — the one shape the mounted prompt
   * and the key handler's option list are both built from, so the digits the
   * user sees and the digits that select are never two lists that can drift.
   */
  function askPromptRequest(prompt: NonNullable<typeof askPrompt>): PermissionRequest {
    return {
      toolName: prompt.toolName,
      command: extractToolSubject(prompt.toolName, prompt.args),
      winningRule: prompt.winningRule,
      defaultRule: prompt.defaultRule,
      capabilityPlan: prompt.capabilityPlan,
      workingDir: prompt.workingDir,
      allowPersistentApproval: !prompt.oneTimeOnly,
      envelope: prompt.envelope,
      explain: prompt.explain,
    };
  }

  function handlePermissionDecision(decision: PermissionDecision): void {
    if (!askPrompt) return;

    if (askPrompt.oneTimeOnly && decision !== "once" && decision !== "deny") return;

    // The session grant is consent for the containment envelope, not a rule
    // about this command: it stores no rule, has no scope to choose, and is
    // recorded by agent.ts (the canonical `allow-by-envelope-grant` row) — so
    // there is deliberately no UI-side row here.
    if (decision === "envelope-grant") {
      resolveAskPrompt("envelope-grant");
      return;
    }

    const rawSubject = askPrompt.args?.command ?? askPrompt.args?.path ?? askPrompt.args?.filePath ?? askPrompt.args?.url;
    const subject = typeof rawSubject === "string" ? rawSubject : "";
    void ctx.sessionStore.appendPermission(ctx.sessionId, {
      tool: askPrompt.toolName,
      subject,
      decision,
      winningRule: askPrompt.winningRule,
    });

    if (decision === "deny") {
      resolveAskPrompt(false);
      return;
    }

    // A broader grant is on offer (a folder with a sibling exact approval, or
    // an external read whose default rule covers one directory level only):
    // defer to a second prompt asking which scope to store.
    if ((decision === "session" || decision === "always") && scopeBroadeningRule()) {
      setAskPrompt((prev) => prev ? { ...prev, scopeStage: true, scopeDecision: decision, cursor: 0 } : null);
      return;
    }

    if (decision === "session" || decision === "always") {
      approveAskPrompt(decision, null);
    }

    resolveAskPrompt(true);
  }

  /**
   * Approves the pending askPrompt for `decision`. When `scopedRule` is
   * provided (the whole-folder glob chosen at the scope stage) it is stored
   * instead of the exact default rule.
   */
  function approveAskPrompt(decision: "session" | "always", scopedRule: PermissionRule | null): void {
    if (!askPrompt) return;
    // When a builtin rule (guarded or destructive) triggered the prompt, use
    // buildDefaultRule for the specific path/command — NOT the winningRule's
    // glob/prefix pattern. Otherwise the stored exact-match rule would carry
    // a pattern like "**/.env*" that never matches a real path (the original
    // kind is switched to "exact", but the pattern was left as the glob).
    // buildDefaultRule already sets kind "exact" on the canonical form, so
    // narrowToExact becomes a safety no-op rather than a bug-fix requirement.
    const isBuiltinOrigin = askPrompt.winningRule?.origin === "builtin-destructive" || askPrompt.winningRule?.origin === "builtin-guarded";
    const matchedBuiltin = isBuiltinOrigin ? askPrompt.winningRule : undefined;
    // A prompt only ever surfaces for a match that resolved to "ask" — so
    // askPrompt.winningRule, when present, is itself an ask-action rule
    // (builtin or a user-authored one). Reusing it verbatim would store an
    // action:"ask" rule that never changes anything on approval, re-prompting
    // the same call forever. Always build the narrow allow rule for the
    // specific call instead; matchedBuiltin still forces exact narrowing
    // below when the winner was a builtin guarded/destructive rule.
    const rule = scopedRule ?? ctx.permissions.buildDefaultRule(askPrompt.toolName, askPrompt.args);
    if (decision === "session") {
      ctx.permissions.approveForSession(rule, matchedBuiltin);
    } else {
      ctx.permissions.approveAlways(rule, matchedBuiltin);
    }
  }

  /**
   * The broadening rule the stage-two scope prompt offers for the pending
   * askPrompt, or undefined when there is no offer. The internal
   * sibling-folder rule wins when both are somehow present (they are mutually
   * exclusive by construction — folderScopeRule returns undefined for
   * external paths and externalTreeRule for internal ones).
   *
   * A builtin guarded/destructive match never gets the external tree offer:
   * approvals for those are narrowed to the exact subject (see
   * PermissionEngine.narrowToExact), so nothing broader could actually be
   * stored — the offer would be a lie.
   */
  function scopeBroadeningRule(): PermissionRule | undefined {
    if (!askPrompt) return undefined;
    if (askPrompt.folderRule) return askPrompt.folderRule;
    const origin = askPrompt.winningRule?.origin;
    if (origin === "builtin-destructive" || origin === "builtin-guarded") return undefined;
    return askPrompt.externalTreeRule;
  }

  /** Stage-two handler: user chose the narrow or the broadened scope for an approval. */
  function handleScopeDecision(scope: "file" | "folder"): void {
    if (!askPrompt || !askPrompt.scopeDecision) return;
    const scopedRule = scope === "folder" ? (scopeBroadeningRule() ?? null) : null;
    approveAskPrompt(askPrompt.scopeDecision, scopedRule);
    resolveAskPrompt(true);
  }

  useInput((value: string, key: any) => {
    if (rawMode.mode === "raw") {
      if (key.escape) {
        rawMode.setMode("lite");
        pushOutput("[exited raw mode]");
        return;
      }
      if (key.ctrl && key.name === "c") {
        ctx.provideAbortController().abort();
        return;
      }
      return;
    }

    // The startup resume chooser owns input until dismissed (it has its own
    // useInput); block the main handler while it — or its compaction — is up.
    if (resumeChoice || compactingResume) return;

    if (showHelp) return;
    if (showCommandPalette) return;
    if (showModelDropdown) return;
    if (showThemeDropdown) return;
    if (showEffortSelector) return;

    if (planPrompt) {
      return;
    }

    if (showSessionList) {
      return;
    }

    if (showSkillList) {
      return;
    }

    if (showModeList) {
      return;
    }

    if (showUndoSelector) {
      return;
    }

    if (showMcpStatus) {
      return;
    }

    if (showTasks) {
      return;
    }

    if (showPermissionHistory) {
      return;
    }

    if (showUsage) {
      return;
    }

    if (askQuestionPrompt) {
      return;
    }

    if (askPrompt) {
      const lower = value.toLowerCase();
      // Stage two (file-vs-folder scope) has two options; the main prompt's
      // options come from the same function the prompt renders (three with the
      // session grant on offer, two for one-time-only, four otherwise).
      const scopeChoices: ("file" | "folder")[] = ["file", "folder"];
      const decisions: PermissionDecision[] = permissionOptions(askPromptRequest(askPrompt)).map((opt) => opt.decision);
      const optionCount = askPrompt.scopeStage ? scopeChoices.length : decisions.length;

      if (key.escape) {
        resolveAskPrompt(false);
        return;
      }

      // Ctrl+E: request an AI explanation of the pending action (informational).
      if (key.ctrl && (key.name === "e" || value === "\x05")) {
        requestExplanation();
        return;
      }

      if (key.upArrow) {
        setAskPrompt((prev) => prev ? { ...prev, cursor: Math.max(0, prev.cursor - 1) } : null);
        return;
      }
      if (key.downArrow) {
        setAskPrompt((prev) => prev ? { ...prev, cursor: Math.min(optionCount - 1, prev.cursor + 1) } : null);
        return;
      }

      if (askPrompt.scopeStage) {
        if (lower === "1" || lower === "2") {
          handleScopeDecision(scopeChoices[Number(lower) - 1]);
          return;
        }
        if (key.return) {
          handleScopeDecision(scopeChoices[askPrompt.cursor]);
          return;
        }
        return;
      }

      if (lower === "1" || lower === "2" || lower === "3" || lower === "4") {
        handlePermissionDecision(decisions[Number(lower) - 1]);
        return;
      }

      if (key.return) {
        handlePermissionDecision(decisions[askPrompt.cursor]);
        return;
      }
      return;
    }

    // No modal view is active, so PromptInput is the focused input surface and
    // owns typing, submission/queuing, and Esc/Ctrl+C interrupt (whether idle or
    // busy). This top-level handler only governs modal views (handled above) and
    // global chord shortcuts below — it must NOT consume plain keys or re-handle
    // interrupt here, or it would double-fire against PromptInput.
    const actions = lookupAction(key, bindings);

    if (actions.includes("openModelPicker")) {
      setShowModelDropdown(true);
      return;
    }

    if (actions.includes("openCommandPalette")) {
      setShowCommandPalette(true);
      accessibility.announce("Command palette opened", "polite");
      return;
    }
  });

  async function handleExit() {
    // Collapse the whole frame (header, input, menu, hint bar) to a single
    // resume-hint line, flush it to the terminal, then unmount and hand off to
    // ctx.onExit() — the CLI-side handler that logs session end and calls
    // process.exit(0). Without that hand-off, Ink unmounts but the process keeps
    // running on its open handles (git poll, statusline, stdin) and the CLI
    // hangs at a blank prompt. The transcript stays in scrollback untouched —
    // only the interactive frame goes away.
    setExitHint(`Resume: nib --resume ${ctx.sessionId}`);
    // Die on exit (async-subagents.md §3, Q3): kill pending sub-runs where
    // background jobs get killed. In-memory only — nothing to restore on
    // resume; the process exit is the actual kill.
    ctx.abortRunningTasks?.();
    // Stop fires on /exit; SessionEnd immediately after, before teardown
    // (hooks-spec.md §2).
    if (ctx.hooks) {
      await ctx.hooks.dispatch("Stop", {});
      await ctx.hooks.dispatch("SessionEnd", {});
    }
    await waitUntilRenderFlush().catch(() => {});
    exit();
    ctx.onExit();
  }

  const promptStr = ctx.getPromptStr();
  const colorEnabled = theme.colorEnabled;
  const term = useTerminalInfo();

  const modalOpen =
    !!askPrompt || !!askQuestionPrompt || !!hookTrustPrompt || !!skillTrustPrompt || !!planPrompt || showSessionList || showSkillList || showModeList ||
    showUndoSelector || showMcpStatus || showTasks || showPermissionHistory || showUsage || showModelDropdown || showThemeDropdown || showEffortSelector || showHelp || showCommandPalette ||
    !!resumeChoice || compactingResume;
  const prevModalOpenRef = useRef(modalOpen);
  modalOpenRef.current = modalOpen;

  // When a modal closes and no turn is running, drain any commands/messages
  // that were queued behind it. The drain itself stops at a modal-opening slash
  // (see drainQueueRef), so without this re-trigger the tail of the queue would
  // be stranded until the next turn.
  useEffect(() => {
    if (prevModalOpenRef.current && !modalOpen && !turnActiveRef.current) {
      drainQueueRef.current();
    }
    prevModalOpenRef.current = modalOpen;
  }, [modalOpen]);

  if (exitHint) {
    // Final frame: a single dim line. Ink erases the old frame rows and
    // redraws only this, leaving the transcript scrollback intact above it.
    return <Text dimColor>{exitHint}</Text>;
  }

  return (
    <Box flexDirection="column" width={term.columns}>
      <OutputArea
        lines={outputLines}
        activeLine={activeLine}
        busy={busy}
        staticEpoch={staticEpoch}
      />

      {/* Live checklist for the agent's update_todo_list plan (src/tools/todo.ts). */}
      <TodoPanel todos={todos} active={turnActive} />

      {showHelp && <HelpOverlay onClose={() => setShowHelp(false)} />}

      {showCommandPalette && (
        <CommandPalette
          actions={paletteActions}
          onClose={() => setShowCommandPalette(false)}
        />
      )}

      {askQuestionPrompt && (
        <AskUserQuestionPrompt
          questions={askQuestionPrompt.questions}
          resolve={(answers) => {
            setAskQuestionPrompt(null);
            askQuestionPrompt.resolve(answers);
          }}
          width={term.columns}
        />
      )}

      {hookTrustPrompt && (
        <HookTrustPrompt
          entry={hookTrustPrompt.entry}
          resolve={(trusted) => {
            setHookTrustPrompt(null);
            hookTrustPrompt.resolve(trusted);
          }}
        />
      )}

      {skillTrustPrompt && (
        <SkillTrustPrompt
          skill={skillTrustPrompt.skill}
          status={skillTrustPrompt.status}
          resolve={(trusted) => {
            setSkillTrustPrompt(null);
            skillTrustPrompt.resolve(trusted);
          }}
        />
      )}

      {askPrompt && askPrompt.scopeStage ? (askPrompt.folderRule ? (
        <ScopeChoicePrompt
          folderPattern={askPrompt.folderRule.pattern}
          toolName={askPrompt.toolName}
          cursor={askPrompt.cursor}
          onChoose={handleScopeDecision}
          onCancel={() => resolveAskPrompt(false)}
        />
      ) : (
        <ExternalScopeChoicePrompt
          treePattern={askPrompt.externalTreeRule?.pattern ?? ""}
          cursor={askPrompt.cursor}
          onChoose={handleScopeDecision}
          onCancel={() => resolveAskPrompt(false)}
        />
      )) : askPrompt && (askPrompt.winningRule?.origin === "builtin-destructive" ? (
        <DestructiveConfirmPrompt
          request={askPromptRequest(askPrompt)}
          cursor={askPrompt.cursor}
          onChoose={handlePermissionDecision}
          onCancel={() => resolveAskPrompt(false)}
        />
      ) : (
        <PermissionPrompt
          request={askPromptRequest(askPrompt)}
          cursor={askPrompt.cursor}
          onChoose={handlePermissionDecision}
          onCancel={() => resolveAskPrompt(false)}
        />
      ))}

      {planPrompt && (
        <PlanImplementationPrompt
          planText={planPrompt.planText}
          onImplement={(followUpPrompt) => {
            setPlanPrompt(null);
            applyPosture("normal");
            runAgentTurn(followUpPrompt);
          }}
          onStayInPlan={() => {
            setPlanPrompt(null);
          }}
          onSwitchToDefault={() => {
            setPlanPrompt(null);
            applyPosture("normal");
          }}
        />
      )}

      {showSessionList && (
        <SessionList
          sessionStore={ctx.sessionStore}
          onResume={async (sessionId) => {
            if (ctx.resumeSession) {
              const messages = await ctx.resumeSession(sessionId);
              if (messages) {
                setShowSessionList(false);
                // Wipes the current scrollback (not a re-seed — the resumed
                // session's own transcript is about to replace it via the
                // load/compact chooser below).
                wipeScrollback([]);
                // Route into the same load/compact chooser the startup path uses.
                pendingResumeRef.current = messages;
                setResumeChoice({ count: messages.length });
              }
            }
          }}
          onClose={() => setShowSessionList(false)}
          width={term.columns}
          height={term.rows}
        />
      )}

      {showSkillList && (
        <SkillList
          skills={ctx.skills ?? []}
          onSelect={(name) => {
            setShowSkillList(false);
            handleSlashCommand(`/skill ${name}`);
          }}
          onClose={() => setShowSkillList(false)}
          width={term.columns}
          height={term.rows}
        />
      )}

      {showModeList && (
        <ModeList
          modeLoader={ctx.modeLoader}
          currentSlug={ctx.activeMode?.slug}
          onSelect={(slug) => {
            setShowModeList(false);
            handleSlashCommand(`/mode ${slug}`);
          }}
          onClose={() => setShowModeList(false)}
          width={term.columns}
        />
      )}

      {showUndoSelector && (
        <UndoSelector
          checkpoints={undoCheckpoints}
          onRestore={async (hash, restoreCode) => {
            if (ctx.restoreCheckpoint) {
              const result = await ctx.restoreCheckpoint(hash, restoreCode);
              if (result.restored) {
                setShowUndoSelector(false);
                // Unlike /new and /resume, /undo deliberately leaves the
                // visible transcript alone — the user needs to see the
                // conversation they just rewound into, not a blanked
                // screen. Append a confirmation instead of wiping.
                const shortHash = hash.slice(0, 7);
                const confirmation = restoreCode
                  ? `Restored checkpoint ${shortHash} — files and conversation`
                  : `Restored checkpoint ${shortHash} — conversation only`;
                pushOutput(theme.colorEnabled ? `\x1b[2m${confirmation}\x1b[0m` : confirmation);
                if (result.promptDraft) {
                  draftNonceRef.current += 1;
                  setPromptDraft({ nonce: draftNonceRef.current, text: result.promptDraft });
                }
              }
              return result;
            }
            return { restored: false, promptDraft: "" };
          }}
          onClose={() => setShowUndoSelector(false)}
          width={term.columns}
          height={term.rows}
        />
      )}

      {showMcpStatus && (
        <McpStatusList
          onClose={() => setShowMcpStatus(false)}
          width={term.columns}
        />
      )}

      {showTasks && (
        <TaskList
          getTasks={ctx.getTasks ?? (() => [])}
          abortTask={(id) => {
            ctx.abortTask?.(id);
            // The status bar's task segment derives from registry state —
            // refresh it so the stop is visible on the row immediately.
            setStatusLine(ctx.buildStatusBar());
          }}
          onClose={() => setShowTasks(false)}
          width={term.columns}
        />
      )}

      {showPermissionHistory && (
        <PermissionHistoryList
          sessionStore={ctx.sessionStore}
          sessionId={ctx.sessionId}
          onClose={() => setShowPermissionHistory(false)}
          width={term.columns}
        />
      )}

      {showUsage && (
        <UsageView
          providerName={ctx.providerName}
          getBalance={async () => {
            // Live query on every open (decision I — no caching). A provider
            // that can't be constructed or lacks getBalance reads as null.
            try {
              return (await ctx.getProvider().getBalance?.()) ?? null;
            } catch {
              return null;
            }
          }}
          modelUsage={ctx.mutable.modelUsage}
          sessionInput={ctx.mutable.sessionInput}
          sessionOutput={ctx.mutable.sessionOutput}
          onClose={() => setShowUsage(false)}
          width={term.columns}
        />
      )}

      {showModelDropdown && (
        <ModelsDropdown
          open={showModelDropdown}
          providerName={ctx.providerName}
          currentModel={ctx.activeModel}
          entries={ctx.getModelEntries()}
          configured={ctx.getConfiguredProviders?.()}
          getConfigured={ctx.getConfiguredProviders}
          labels={ctx.getProviderLabels?.()}
          keyEnvByProvider={ctx.getKeyEnvByProvider?.()}
          getFavoriteModels={ctx.getFavoriteModels}
          onToggleFavorite={ctx.toggleFavoriteModel}
          getRecentModels={ctx.getRecentModels}
          onSaveProviderKey={ctx.saveProviderKey}
          width={term.columns}
          height={term.rows}
          onClose={() => setShowModelDropdown(false)}
          onSelect={async (provider, model) => {
            const lines = await ctx.handleSlash(`/model ${provider}/${model}`);
            for (const line of lines) pushOutput(line);
            setStatusLine(ctx.buildStatusBar());
          }}
        />
      )}

      {showThemeDropdown && (
        <ThemeDropdown
          open={showThemeDropdown}
          currentName={themeBeforePreviewRef.current}
          width={term.columns}
          onPreview={(name) => themeController.setThemeName(name)}
          onConfirm={(name) => {
            themeController.setThemeName(name);
            try {
              persistThemeChoice(name);
              pushOutput(`Theme set to ${name}.`);
            } catch (err) {
              pushOutput(`Failed to save theme: ${(err as Error).message}`);
            }
            setShowThemeDropdown(false);
          }}
          onCancel={() => {
            // Revert the live preview to the theme active when the picker opened.
            themeController.setThemeName(themeBeforePreviewRef.current);
            setShowThemeDropdown(false);
          }}
        />
      )}

      {showEffortSelector && (
        <EffortSelector
          open={showEffortSelector}
          currentEffort={ctx.activeEffort}
          values={ctx.effortValues()}
          width={term.columns}
          onClose={() => setShowEffortSelector(false)}
          onSelect={(effort) => {
            ctx.handleSlash(`/effort ${effort}`).then((lines) => {
              for (const line of lines) pushOutput(line);
              setStatusLine(ctx.buildStatusBar());
            });
          }}
        />
      )}

      {resumeChoice && !compactingResume && (
        <ResumeChooser
          messageCount={resumeChoice.count}
          onLoad={handleResumeLoad}
          onCompact={handleResumeCompact}
          width={term.columns}
        />
      )}

      {compactingResume && (
        <Box marginY={1}>
          <Text color="cyan">✳ </Text>
          <Text dimColor>Compacting resumed session…</Text>
        </Box>
      )}

      {/* Queued follow-ups entered mid-turn, stacked one per line in arrival
          order just above the input, so the user sees what's lined up to run
          when the current turn finishes. */}
      {queuedItems.length > 0 && (
        <Box flexDirection="column">
          {queuedItems.map((item, i) => (
            <Text key={i} color="magenta" dimColor>
              {`${formatQueueTime(item.at)} ${queuedLabel(item.text)}`}
            </Text>
          ))}
        </Box>
      )}

      {!askPrompt && !askQuestionPrompt && !hookTrustPrompt && !skillTrustPrompt && !planPrompt && !showSessionList && !showSkillList && !showModeList && !showUndoSelector && !showMcpStatus && !showTasks && !showPermissionHistory && !showUsage && !showModelDropdown && !showThemeDropdown && !showEffortSelector && !showHelp && !showCommandPalette && !resumeChoice && !compactingResume && (
        <PromptInput
          screenWidth={term.columns}
          promptHistory={promptHistory}
          busy={busy}
          placeholder="Type your message..."
          promptDraft={promptDraft}
          onSubmit={submitFromInput}
          onInterrupt={() => ctx.provideAbortController().abort()}
          onExitShortcut={() => handleExit()}
          onModelPickerOpen={() => setShowModelDropdown(true)}
          onCyclePosture={() => cyclePosture()}
          onOpenModePicker={() => setShowModeList(true)}
          completer={ctx.completer}
          onDraftChange={onPromptDraftChange}
          modelPill={ctx.buildModelPill?.()}
          statusLine={
            <StatusBar
              segments={
                statusLineProviderSegments.length > 0 || jobSummary.total > 0
                  ? [
                      ...statusLine,
                      ...(jobSummary.total > 0
                        ? [jobSummaryToSegment(jobSummary)]
                        : []),
                      ...statusLineProviderSegments,
                    ]
                  : statusLine
              }
              gitStatus={gitStatus}
            />
          }
        />
      )}

      {/* The hint bar is deliberately the LAST row of the frame, and carries the
          only continuously-changing element (the working indicator). Ink
          repaints a changed line by walking the cursor UP from the bottom, so
          anything rendered BELOW an 80ms animation gets rewritten 12.5x/second
          — which is what made the prompt box tear while streaming. With nothing
          under it, a tick rewrites just this row. */}
      <HintBar
        working={turnActive}
        left={
          turnActive
            ? [{ key: "esc", label: "interrupt" }]
            : [
                { key: "⇧ Tab", label: posture === "normal" ? "auto-approve" : "normal" },
                { key: "⌃O", label: "mode" },
              ]
        }
        // Only chords that actually reach a handler. "^⇧P commands" was dead
        // twice over: a terminal sends the same byte (0x10) for ctrl+p and
        // ctrl+shift+p, so the shift-qualified binding can never match, and
        // PromptInput claims ctrl+p for history navigation before App's
        // useInput would see it anyway. "/" already lists the same commands
        // with fuzzy filtering, and is discoverable without a hint.
        right={[
          // "/" is the honest router — the slash menu reaches everything,
          // matching Claude Code. Rendered without the key-cap chip: "/" is a
          // literal character you type, not a key chord, so chipping it like
          // "esc" looked wrong. (A "^M model" hint lived here once: dead on
          // arrival, since Ctrl+M is byte-identical to Enter in a terminal.)
          { key: "", label: "/ commands" },
        ]}
      />
    </Box>
  );
}

interface AppProps {
  ctx: AppContext;
  themeConfig?: ThemeProviderOptions;
  keybindingConfig?: KeybindingConfig;
  /** Resolved repaint cadence (settings.json > NIB_REFRESH > default). */
  refresh?: ResolvedRefresh;
}

export default function App({
  ctx,
  themeConfig,
  keybindingConfig,
  refresh,
}: AppProps) {
  const colorEnabled = ctx.getColorEnabled();

  return (
    <ErrorBoundary colorEnabled={colorEnabled}>
      <ThemeProvider
        config={{
          mode: themeConfig?.mode ?? "dark",
          name: themeConfig?.name,
          overrides: themeConfig?.overrides,
          colorEnabled,
        }}
      >
        <KeybindingProvider config={keybindingConfig}>
          <TerminalProvider>
            <AccessibilityProvider>
              <RawModeProvider>
              <RefreshProvider value={refresh ?? resolveRefreshProfile()}>
                <InnerApp ctx={ctx} />
              </RefreshProvider>
              </RawModeProvider>
            </AccessibilityProvider>
          </TerminalProvider>
        </KeybindingProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}
