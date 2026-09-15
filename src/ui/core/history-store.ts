// Cross-session prompt history, one file per project.
//
// Before this existed, Up-arrow recall was limited to a single session: history
// lived only in React state, and slash commands never even reached the resumed
// conversation (they make no model call), so /resume could not recover them.
// This is the shell-history equivalent, keyed per project directory the way
// Claude Code keys its history — and the way this repo already keys sessions
// (same slugify, sessions/store.ts).
//
// Format is JSONL, not plain lines: entries can be multiline (Shift+Enter
// prompts), and JSON round-trips them exactly. Corrupt lines are skipped, a
// missing file is an empty history, and every append is asynchronous with
// errors swallowed — this feature must add ZERO synchronous I/O and ZERO new
// failure modes to the turn path while a main-thread stall is being hunted
// (see FOLLOWUPS §0). Privacy surface is unchanged: sessions/ already stores
// full conversations in plaintext JSONL.

import { readFileSync, writeFileSync } from "node:fs";
import { mkdir, appendFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { slugify } from "../../sessions/store.js";
import { resolveHome } from "../../config/loader.js";

/** Entries returned to the UI; also the compaction target size. */
export const HISTORY_CAP = 1000;

/** Raw line count that triggers a rewrite down to HISTORY_CAP. */
const COMPACT_THRESHOLD = 2000;

export function historyFilePath(cwd: string, baseDir?: string): string {
  const base = baseDir ?? resolveHome();
  return join(base, "prompt_history", `${slugify(cwd)}.jsonl`);
}

/**
 * Load the project's persisted history, oldest first, capped to HISTORY_CAP.
 *
 * Synchronous by design — called exactly once, at mount, before any turn runs.
 * If the raw file has grown past COMPACT_THRESHOLD lines it is rewritten down
 * to the cap here, so the append path never needs to rewrite anything.
 */
export function loadPromptHistory(cwd: string, baseDir?: string): string[] {
  const file = historyFilePath(cwd, baseDir);
  let raw: string;
  try {
    raw = readFileSync(file, "utf-8");
  } catch {
    return [];
  }
  const lines = raw.split("\n").filter((l) => l.trim() !== "");
  const entries: string[] = [];
  for (const line of lines) {
    try {
      const v = JSON.parse(line);
      if (typeof v === "string" && v.trim() !== "") entries.push(v);
    } catch {
      // A corrupt line loses one entry, never the file.
    }
  }
  const capped = entries.slice(-HISTORY_CAP);
  if (lines.length > COMPACT_THRESHOLD) {
    try {
      writeFileSync(file, capped.map((e) => JSON.stringify(e)).join("\n") + "\n");
    } catch {
      // Compaction is best-effort; failing it only means a bigger file.
    }
  }
  return capped;
}

/**
 * Append one entry. Fire-and-forget for the app (errors swallowed — a full
 * disk must not break the prompt); the returned promise exists for tests.
 * Consecutive-duplicate suppression is the caller's job, mirroring the
 * in-memory recordPromptHistory dedupe.
 */
export function appendPromptHistory(cwd: string, entry: string, baseDir?: string): Promise<void> {
  const file = historyFilePath(cwd, baseDir);
  return mkdir(dirname(file), { recursive: true })
    .then(() => appendFile(file, JSON.stringify(entry) + "\n"))
    .catch(() => {});
}
