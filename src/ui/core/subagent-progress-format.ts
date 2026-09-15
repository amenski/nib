/**
 * Formats a running sub-agent's progress (start/tool/end events from
 * SubagentProgress, orchestrator/index.ts) as inline transcript lines styled
 * after Claude Code's nested agent display:
 *
 *   ⏺ Agent(review the auth module) Sonnet 5
 *     └ Bash(grep -n "^describe" src/hooks/trust.test.ts)
 *     └ Read(src/hooks/trust.test.ts)
 *     … +42 tool uses
 *     └ sub-agent finished · 1m 12s
 *
 * nib's transcript is an append-only Ink <Static> list (OutputArea.tsx)
 * — a committed line is never repainted. That rules out a live "Running…"
 * status per line and a live-toggle collapse (both need to rewrite an
 * already-printed line). What IS buildable within that model: each child
 * tool call prints once, in order, the moment it starts — and after
 * MAX_VISIBLE_CHILDREN a single static rollup line takes over, mirroring the
 * "… +N lines" convention formatToolResultPreview already uses for long tool
 * results (ToolCallFormatter.ts).
 */

import { formatToolCallHeader } from "../ToolCallFormatter.js";

/** Cap on child tool-call lines rendered per sub-agent before collapsing to a
 *  rollup line — mirrors formatToolResultPreview's "first N, then …+N" shape. */
export const MAX_VISIBLE_CHILDREN = 8;

export interface SubagentDisplayState {
  /** Child tool calls rendered so far (bounded at MAX_VISIBLE_CHILDREN). */
  shownCount: number;
  /** Total child tool calls seen, shown or not. */
  totalCount: number;
  /** Whether the "… +N tool uses" rollup line has already been printed. */
  rollupPrinted: boolean;
}

export function initSubagentDisplayState(): SubagentDisplayState {
  return { shownCount: 0, totalCount: 0, rollupPrinted: false };
}

const TREE_CONNECTOR = "└";

function indentFor(depth: number): string {
  // depth 0 = spawned by the top-level agent; each additional level of
  // nesting (a sub-agent spawning a sub-agent) indents one more step.
  return "  ".repeat(depth);
}

/**
 * "⏺ Agent(description) ModelName" — the header line printed once at spawn,
 * matching Claude Code's "Agent(<task>) <model>" shape. When the task was
 * spawned as a named, defined agent (.nib/agents/<name>.md), the name
 * rides after the model — the screenshot's own reference display has no
 * named-agent concept, so this is nib's addition, kept out of the
 * parens so the description stays the visually primary label.
 */
export function formatSubagentHeader(opts: {
  description: string;
  agentName?: string;
  model?: string;
  depth: number;
}): string {
  const { description, agentName, model, depth } = opts;
  const modelSuffix = model ? ` ${model}` : "";
  const agentSuffix = agentName ? ` (${agentName})` : "";
  return `${indentFor(depth)}⏺ Agent(${description})${modelSuffix}${agentSuffix}`;
}

/**
 * Advances a sub-agent's display state for one "tool" progress event and
 * returns the line to print, or null when the event should not print a new
 * line (already past the rollup cap — nothing more to add until "end").
 * Mutates `state` in place (per-agent state the caller holds across events).
 */
export function formatSubagentToolLine(
  state: SubagentDisplayState,
  name: string,
  args: Record<string, unknown>,
  depth: number,
): string | null {
  state.totalCount++;
  if (state.shownCount < MAX_VISIBLE_CHILDREN) {
    state.shownCount++;
    const header = formatToolCallHeader(name, args); // "⏺ Bash(grep -n …)"
    const body = header.startsWith("⏺ ") ? header.slice(2) : header;
    return `${indentFor(depth + 1)}${TREE_CONNECTOR} ${body}`;
  }
  if (!state.rollupPrinted) {
    state.rollupPrinted = true;
    const hidden = state.totalCount - state.shownCount;
    return `${indentFor(depth + 1)}… +${hidden} tool use${hidden === 1 ? "" : "s"}`;
  }
  // Rollup already printed once; later tool calls fold silently into it
  // rather than reprinting a stale count (Static cannot rewrite that line).
  return null;
}

/** "└ sub-agent finished · 1m 12s" — printed once on the "end" event. */
export function formatSubagentFinishLine(opts: {
  depth: number;
  elapsedMs: number;
}): string {
  const { depth, elapsedMs } = opts;
  const s = Math.round(elapsedMs / 1000);
  const took = s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
  return `${indentFor(depth + 1)}${TREE_CONNECTOR} sub-agent finished · ${took}`;
}
