import { ToolRegistry } from "./registry.js";
import type { ToolCall, ToolOutput } from "../types.js";
import type { ToolContext } from "./types.js";
import type { SandboxLevel } from "../sandbox/seatbelt.js";
import type { WebSearchConfig } from "../config/loader.js";
import type { CheckpointManager } from "../checkpoints/index.js";
import type { SessionStore } from "../sessions/store.js";
import { registerFiles } from "./files.js";
import { registerBash } from "./bash.js";
import { registerSearch } from "./search.js";
import { registerEdits } from "./edit.js";
import { registerAskUserQuestion } from "./ask_user_question.js";
import { registerWebSearch } from "./web-search.js";
import { registerWebFetch } from "./web-fetch.js";
import { registerViewImage } from "./view-image.js";
import { registerJobs } from "./jobs.js";
import { registerTodo, todoStore } from "./todo.js";
import { registerAttemptCompletion } from "./attempt-completion.js";
import { registerSwitchMode } from "./switch-mode.js";

const registry = new ToolRegistry();
registerFiles(registry);
registerBash(registry);
registerSearch(registry);
registerEdits(registry);
registerAskUserQuestion(registry);
registerWebSearch(registry);
registerWebFetch(registry);
registerViewImage(registry);
registerJobs(registry);
registerTodo(registry);
registerAttemptCompletion(registry);
registerSwitchMode(registry);

export { registry };
export const TOOL_DEFS = registry.getAllDefs();

const ctx: ToolContext = {
  workingDir: process.cwd(),
  sessionId: "default",
  askUser: undefined,
  askQuestion: undefined,
  signal: new AbortController().signal,
  fileMtimes: new Map(),
  // The parent run's store — the module singleton, which the TUI panel
  // subscribes to. Sub-agent runs never touch this pointer: the orchestrator
  // threads a fresh store through each per-call tool context instead.
  todoStore,
};

export function setSessionId(id: string): void {
  ctx.sessionId = id;
}

export function setAskQuestion(fn: ToolContext["askQuestion"]): void {
  ctx.askQuestion = fn;
}

export function setCheckpointManager(cpm: CheckpointManager): void {
  ctx.checkpoint = cpm;
}

export function setSignal(signal: AbortSignal): void {
  ctx.signal = signal;
}

export function setSessionStore(store: SessionStore): void {
  ctx.sessionStore = store;
}

export function setSetMode(fn: (slug: string) => Promise<string | null>): void {
  ctx.setMode = fn;
}

export function setTimeoutToBackground(v: boolean): void {
  ctx.timeoutToBackground = v;
}

/**
 * Set the OS-sandbox level for bash children (permission-profile.md §8,
 * phase (e)): `strict-sandbox` / `workspace-write` from the merged config
 * when `sandbox.enabled` and the profile level demands it; undefined
 * (default) = sandbox off. macOS-only — the Seatbelt layer no-ops on other
 * platforms (startup notice from the loader).
 */
export function setSandboxLevel(v: SandboxLevel | undefined): void {
  ctx.sandboxLevel = v;
}

/**
 * Set the GLOBAL-only `sandbox.writeRoots` config (docs/unified-write-
 * boundary.md) — additional workspace-write directories, threaded into
 * ctx.writeRoots so run_bash/background jobs and the file-tool containment
 * check resolve the same write-set. Absent = no configured roots.
 */
export function setWriteRoots(v: string[] | undefined): void {
  ctx.writeRoots = v;
}

/**
 * Set the effective web_search backend config (config.webSearch), resolved
 * once at startup from the POST-TOFU-strip config — see ToolContext.webSearch.
 * web-search.ts reads this instead of calling loadConfig() per call, which
 * would silently re-read the raw, unstripped searxngUrl on every search
 * regardless of the startup trust decision.
 */
export function setWebSearchConfig(v: WebSearchConfig | undefined): void {
  ctx.webSearch = v;
}

export async function executeTool(call: ToolCall): Promise<ToolOutput> {
  return registry.execute(call, ctx);
}
