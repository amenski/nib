import { existsSync } from "node:fs";
import { join } from "node:path";
import { projectDirPath } from "../config/paths.js";
import { appendPrivateFileSync, ensurePrivateDirectory } from "../config/state-permissions.js";
import { redactDeep } from "../sessions/redact.js";

let debugPath: string | null = null;

export function enableDebug(sessionId: string): void {
  const dir = join(projectDirPath(process.cwd()), "debug");
  ensurePrivateDirectory(dir);
  debugPath = join(dir, `${sessionId}.jsonl`);
}

export function logRequest(body: Record<string, unknown>): void {
  if (!debugPath) return;
  const entry = JSON.stringify(redactDeep({
    ts: Date.now(),
    type: "request",
    model: body.model,
    messages: body.messages,
    tools: (body.tools as any[])?.map((t: any) => t.function?.name ?? t.name),
    max_tokens: body.max_tokens,
    temperature: body.temperature,
  }));
  appendPrivateFileSync(debugPath, entry + "\n");
}

export function logResponse(usage: unknown, toolCalls: unknown[]): void {
  if (!debugPath) return;
  const entry = JSON.stringify(redactDeep({
    ts: Date.now(),
    type: "response",
    usage,
    tool_calls: (toolCalls as any[])?.map((tc: any) => ({
      name: tc.function?.name ?? tc.name,
      args: tc.function?.arguments ?? tc.args,
    })),
  }));
  appendPrivateFileSync(debugPath, entry + "\n");
}

/**
 * Records a failed stream or turn, so a stop that leaves no other trace is
 * diagnosable after the fact. `phase` names the site that caught it, which is
 * what distinguishes a provider-stream failure from a turn-level one.
 *
 * The error is unwrapped first: `Error`'s own properties are non-enumerable, so
 * an error object passed straight to `JSON.stringify` reaches the file as `{}`
 * — exactly the case this log exists to explain. Redacted like every other row
 * (provider errors echo the request back).
 */
export function logError(phase: string, err: unknown): void {
  if (!debugPath) return;
  const entry = JSON.stringify(redactDeep({
    ts: Date.now(),
    type: "error",
    phase,
    error: describeError(err),
  }));
  appendPrivateFileSync(debugPath, entry + "\n");
}

function describeError(err: unknown): unknown {
  if (!(err instanceof Error)) return err;
  return {
    name: err.name,
    message: err.message,
    stack: err.stack,
    cause: describeError(err.cause),
  };
}

export interface TimingEntry {
  /** Which phase this row measures — a turn emits one "prompt_assembly" row
   *  and one "request" row per provider call, in that order. */
  phase: "prompt_assembly" | "request";
  model?: string;
  effort?: string;
  promptBytes?: number;
  estimatedTokens?: number;
  toolCount?: number;
  cachedTokens?: number;
  /** Milliseconds from phase start to each checkpoint; absent checkpoints
   *  (e.g. no tool calls this turn) are simply omitted. */
  durationsMs: {
    total: number;
    toFirstEvent?: number;
    toFirstText?: number;
  };
}

export function logTiming(entry: TimingEntry): void {
  if (!debugPath) return;
  const record = JSON.stringify({ ts: Date.now(), type: "timing", ...entry });
  appendPrivateFileSync(debugPath, record + "\n");
}
