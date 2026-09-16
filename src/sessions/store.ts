import { readFile, readdir, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { Message } from "../types.js";
import { redactSecrets } from "./redact.js";
import { resolveHome, type RetentionConfig } from "../config/loader.js";
import {
  appendPrivateFile,
  ensurePrivateStateDirectoryAsync,
  writePrivateFile,
} from "../config/state-permissions.js";

const KNOWN_VERSION = 1;

/** Filename of the per-project sessions index (a cache over the JSONL files). */
const INDEX_FILENAME = "sessions-index.json";
const INDEX_VERSION = 1;
const TITLE_MAX = 100;

export interface SessionMeta {
  version: 1;
  id: string;
  cwd: string;
  createdAt: string;
  provider: string;
  model: string;
  mode: string;
  /** True when the user explicitly selected the model, rather than a mode default. */
  modelExplicit?: boolean;
  /** Last explicitly selected reasoning effort, when one was persisted. */
  effort?: string;
  /** True when the user explicitly selected the reasoning effort. */
  effortExplicit?: boolean;
}

export interface CompactionSummary {
  task: string;
  decisions: string[];
  files: string[];
  errors_resolved: string[];
}

/**
 * Canonical agent-emitted decision vocabulary (one per resolution path in
 * src/agent.ts). Each value names exactly how a tool call was resolved:
 *   allow-by-rule    — a user/config allow rule matched, no prompt shown
 *   allow-by-posture — an auto-approve posture upgraded an ask without showing a prompt
 *   ask-approved     — an interactive prompt was answered yes
 *   ask-denied       — an interactive prompt was answered no
 *   deny-by-rule     — a deny rule matched (destructive/guarded/config)
 *   deny-by-profile  — the profile gate (layer 1) denied the call before rule
 *                      resolution; terminal, never promptable (permission-profile.md §4)
 *   headless-deny    — resolved to ask but no interactive prompter was available
 *   unresolved-ask   — a bash segment couldn't be safely classified (fail-closed ask)
 *
 * The four legacy values ("once" | "session" | "always" | "deny") are still
 * accepted for backward compatibility: the TUI (src/ui/App.tsx) writes those
 * finer-grained values for interactively-answered prompts, and old sessions on
 * disk carry them. Readers must tolerate both sets.
 */
export type PermissionDecision =
  | "allow-by-rule"
  | "allow-by-posture"
  | "ask-approved"
  | "ask-denied"
  | "deny-by-rule"
  | "deny-by-profile"
  | "headless-deny"
  | "unresolved-ask"
  // legacy / UI-side fine-grained values, still valid on read + write:
  | "deny"
  | "once"
  | "session"
  | "always";

/**
 * Who produced an audit row. Absent for top-level (parent) writes; sub-agents
 * spawned via `new_task` tag their rows `"subagent"` (decision H —
 * feature-plans.md §10; subsystems.md §7).
 */
export type AuditSource = "subagent";

export interface PermissionAuditRecord {
  toolCallId?: string;
  tool: string;
  /** The literal command/path text the decision was made against, redacted. */
  subject: string;
  decision: PermissionDecision;
  /** The rule that produced this outcome, if any (absent for a fallthrough-to-defaultMode ask/allow). */
  winningRule?: { tool: string; kind: string; pattern: string; action: string; origin: string };
  /** Human-readable note on why this decision was reached (e.g. "denied by user at prompt"). */
  reason?: string;
  /** Who produced this row — absent for top-level (parent) writes. */
  source?: AuditSource;
}

export interface TokenUsageRecord {
  /** Tokens attributable to this turn (input + output from the provider usage event). */
  turnTokens: number;
  /** Current context occupancy, matching what compaction measures (estimateTokens of live messages). */
  totalUsed: number;
  /** The context-window ceiling this session is budgeted against. */
  budgetMax: number;
  /** Who produced this row — absent for top-level (parent) writes. */
  source?: AuditSource;
}

export interface SessionRecord {
  type: "meta" | "message" | "state" | "compaction" | "permission" | "token" | "todo";
  at: string;
  [key: string]: unknown;
}

/** A todo list snapshot as persisted by update_todo_list (tool-spec.md). */
export interface TodoSnapshotRecord {
  /** The full list at the time of the update (content redacted per item). */
  todos: { content: string; status: string }[];
}

export interface LoadedSession {
  meta: SessionMeta;
  messages: Message[];
}

/**
 * Session lifecycle status, derived honestly from what the JSONL can tell us:
 *   completed   — the last recorded message is an assistant reply (the last
 *                 turn resolved cleanly).
 *   interrupted — the transcript ends on a user message with no assistant
 *                 reply, i.e. a turn was started but never finished (crash,
 *                 quit mid-turn, or still in progress).
 *   failed      — the JSONL has a torn/incomplete final line, i.e. a write was
 *                 cut off. The one signal of an unclean stop the store can see.
 * A session with no messages at all is reported as `interrupted`.
 */
export type SessionStatus = "completed" | "interrupted" | "failed";

/** One entry in `sessions-index.json`. The index is a cache; JSONL is truth. */
export interface SessionIndexEntry {
  id: string;
  /** First user prompt, secret-redacted, truncated to ≤100 chars. */
  title: string;
  createdAt: string;
  /** Timestamp of the last record on disk (falls back to createdAt). */
  updatedAt: string;
  status: SessionStatus;
  messageCount: number;
  /** Last observed token totals, if any `token` rows exist. */
  totalUsed?: number;
  budgetMax?: number;
}

interface SessionsIndex {
  version: number;
  sessions: SessionIndexEntry[];
}

export interface SessionListItem {
  id: string;
  firstMessage: string;
  messageCount: number;
  createdAt: string;
  /** Renamable title (defaults to the first-user-message excerpt). */
  title: string;
  updatedAt: string;
  status: SessionStatus;
  totalUsed?: number;
  budgetMax?: number;
}

function generateId(): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "").slice(0, 15);
  const hex = Math.random().toString(16).slice(2, 6);
  return `${ts}-${hex}`;
}

export function slugify(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-").replace(/-+/g, "-");
}

/**
 * Full-width reverse solidus (＼, U+FF5C). Tool-using models asked to
 * summarize a conversation sometimes leak their own tool-call markup into the
 * summary — deepseek-family models render it escaped (`<\＼\＼DSML\＼\＼tool_calls>`),
 * others emit plain `<tool_calls>` blocks. That markup is agent plumbing, not
 * conversation content: it must never surface in `[Earlier in this
 * conversation]` on resume, be sent back to the model, or be re-summarized.
 */
export function stripToolCallMarkup(text: string): string {
  // One or more ASCII backslashes and/or U+FF5C (models escape with either).
  const esc = "[\\\\\uFF5C]+";
  const tag = (name: string) => `<${esc}DSML${esc}${name}`;
  let out = text;
  // Escaped DSML blocks: <\＼\＼DSML\＼\＼tool_calls> … </\＼\＼DSML\＼\＼tool_calls>
  out = out.replace(
    new RegExp(`${tag("tool_calls")}>[\\s\\S]*?<\\/${esc}DSML${esc}tool_calls>`, "g"),
    "",
  );
  // Plain DSML blocks: <tool_calls> … </tool_calls>
  out = out.replace(/<tool_calls>[\s\S]*?<\/tool_calls>/g, "");
  // Standalone invoke blocks, escaped or plain, with or without a wrapper.
  out = out.replace(
    new RegExp(`<(?:${esc}DSML${esc})?invoke\\b[^>]*>[\\s\\S]*?<\\/(?:${esc}DSML${esc})?invoke>`, "g"),
    "",
  );
  // Leftover parameter tags, escaped or plain.
  out = out.replace(
    new RegExp(`<(?:${esc}DSML${esc})?parameter\\b[^>]*>[\\s\\S]*?<\\/(?:${esc}DSML${esc})?parameter>`, "g"),
    "",
  );
  // Any remaining bare tags (opening or closing).
  out = out.replace(
    new RegExp(`<\\/?(?:${esc}DSML${esc})?(?:tool_calls|invoke|parameter)\\b[^>]*>`, "g"),
    "",
  );
  // Collapse the blank lines a removed block leaves behind.
  return out.replace(/[ \t]*\n{3,}/g, "\n\n").trim();
}

function formatCompactionText(summary: CompactionSummary): string {
  const parts: string[] = [];
  parts.push(`[Earlier in this conversation]\nTask: ${stripToolCallMarkup(summary.task)}`);
  if (summary.decisions.length > 0) {
    parts.push(
      `\nDecisions:\n${summary.decisions.map((d) => "- " + stripToolCallMarkup(d)).join("\n")}`,
    );
  }
  if (summary.files.length > 0) {
    parts.push(
      `\nFiles:\n${summary.files.map((f) => "- " + stripToolCallMarkup(f)).join("\n")}`,
    );
  }
  if (summary.errors_resolved.length > 0) {
    parts.push(
      `\nErrors resolved:\n${summary.errors_resolved
        .map((e) => "- " + stripToolCallMarkup(e))
        .join("\n")}`,
    );
  }
  return parts.join("\n");
}

export class SessionStore {
  private _cwd: string;
  private readonly sessionDir: string;
  private readonly retention: Pick<RetentionConfig, "maxSessions" | "maxAgeDays">;

  constructor(
    home: string = resolveHome(),
    retention: Pick<RetentionConfig, "maxSessions" | "maxAgeDays"> = {},
  ) {
    this._cwd = process.cwd();
    this.sessionDir = join(home, "sessions", slugify(this._cwd));
    this.retention = retention;
  }

  private get slug(): string {
    return slugify(this._cwd);
  }

  private filePath(sessionId: string): string {
    return join(this.sessionDir, `${sessionId}.jsonl`);
  }

  private get indexPath(): string {
    return join(this.sessionDir, INDEX_FILENAME);
  }

  async create(
    meta: Omit<SessionMeta, "id" | "createdAt" | "version">,
  ): Promise<string> {
    const id = generateId();
    const createdAt = new Date().toISOString();
    await ensurePrivateStateDirectoryAsync(dirname(dirname(this.sessionDir)), "sessions", basename(this.sessionDir));
    const record = { type: "meta" as const, version: 1, id, createdAt, ...meta };
    await appendPrivateFile(this.filePath(id), JSON.stringify(record) + "\n");
    await this.updateIndexEntry(id);
    return id;
  }

  async append(
    sessionId: string,
    record: Omit<SessionRecord, "at">,
  ): Promise<void> {
    await ensurePrivateStateDirectoryAsync(dirname(dirname(this.sessionDir)), "sessions", basename(this.sessionDir));
    const full: SessionRecord = {
      ...record,
      at: new Date().toISOString(),
    } as SessionRecord;
    await appendPrivateFile(this.filePath(sessionId), JSON.stringify(full) + "\n");
    await this.updateIndexEntry(sessionId);
  }

  async appendMessage(sessionId: string, message: Message): Promise<void> {
    const safeContent =
      typeof message.content === "string"
        ? redactSecrets(message.content)
        : message.content;
    const safeMessage = { ...message, content: safeContent };
    await this.append(sessionId, { type: "message", message: safeMessage });
  }

  async appendState(
    sessionId: string,
    state: Record<string, unknown>,
  ): Promise<void> {
    await this.append(sessionId, { type: "state", ...state });
  }

  async appendCompaction(
    sessionId: string,
    replacesThrough: number,
    summary: CompactionSummary,
  ): Promise<void> {
    const safeSummary: CompactionSummary = {
      task: stripToolCallMarkup(redactSecrets(summary.task)),
      decisions: summary.decisions.map((d) => stripToolCallMarkup(redactSecrets(d))),
      files: summary.files.map((f) => stripToolCallMarkup(redactSecrets(f))),
      errors_resolved: summary.errors_resolved.map((e) => stripToolCallMarkup(redactSecrets(e))),
    };
    await this.append(sessionId, {
      type: "compaction",
      replacesThrough,
      summary: safeSummary,
    });
  }

  async appendPermission(sessionId: string, record: PermissionAuditRecord): Promise<void> {
    await this.append(sessionId, {
      type: "permission",
      ...record,
      subject: redactSecrets(record.subject),
      ...(record.reason !== undefined ? { reason: redactSecrets(record.reason) } : {}),
    });
  }

  /** Returns every permission decision recorded for a session, in chronological order. */
  async queryPermissionHistory(sessionId: string): Promise<(PermissionAuditRecord & { at: string })[]> {
    const records = await this.readRecords(sessionId);
    if (!records) return [];
    return records
      .filter((r) => r.type === "permission")
      .map((r) => r as unknown as PermissionAuditRecord & { at: string });
  }

  async appendToken(sessionId: string, record: TokenUsageRecord): Promise<void> {
    await this.append(sessionId, { type: "token", ...record });
  }

  async appendTodo(sessionId: string, todos: TodoSnapshotRecord["todos"]): Promise<void> {
    await this.append(sessionId, {
      type: "todo",
      todos: todos.map((t) => ({ content: redactSecrets(t.content), status: t.status })),
    });
  }

  /** Returns every todo-list snapshot recorded for a session, in chronological order. */
  async queryTodos(sessionId: string): Promise<(TodoSnapshotRecord & { at: string })[]> {
    const records = await this.readRecords(sessionId);
    if (!records) return [];
    return records
      .filter((r) => r.type === "todo")
      .map((r) => r as unknown as TodoSnapshotRecord & { at: string });
  }

  /**
   * Returns every per-turn token-usage row for a session, in chronological
   * order. `remaining` is computed here (budgetMax - totalUsed), never stored.
   */
  async queryTokenUsage(
    sessionId: string,
  ): Promise<(TokenUsageRecord & { at: string; remaining: number })[]> {
    const records = await this.readRecords(sessionId);
    if (!records) return [];
    return records
      .filter((r) => r.type === "token")
      .map((r) => {
        const rec = r as unknown as TokenUsageRecord & { at: string };
        return { ...rec, remaining: rec.budgetMax - rec.totalUsed };
      });
  }

  private async readRecords(sessionId: string): Promise<SessionRecord[] | null> {
    const fp = this.filePath(sessionId);
    let raw: string;
    try {
      raw = await readFile(fp, "utf-8");
    } catch {
      return null;
    }

    const lines = raw.split("\n").filter((l) => l.trim() !== "");
    if (lines.length === 0) return null;

    const records: SessionRecord[] = [];
    for (let i = 0; i < lines.length; i++) {
      try {
        records.push(JSON.parse(lines[i]));
      } catch {
        if (i === lines.length - 1) {
          console.warn(
            `[session] Torn final line in ${sessionId}, dropping`,
          );
        }
      }
    }

    return records.length > 0 ? records : null;
  }

  async load(sessionId: string): Promise<LoadedSession | null> {
    const records = await this.readRecords(sessionId);
    if (!records) return null;

    const first = records[0];
    if (first.type !== "meta") {
      console.error(
        `[session] ${sessionId}: first record is not meta, got ${first.type}`,
      );
      return null;
    }

    if (first.version !== KNOWN_VERSION) {
      console.error(
        `[session] ${sessionId}: unknown version ${first.version} (known: ${KNOWN_VERSION})`,
      );
      return null;
    }

    let meta: SessionMeta = {
      version: first.version as 1,
      id: first.id as string,
      cwd: first.cwd as string,
      createdAt: first.createdAt as string,
      provider: first.provider as string,
      model: first.model as string,
      mode: first.mode as string,
      modelExplicit: first.modelExplicit as boolean | undefined,
      effort: first.effort as string | undefined,
      effortExplicit: first.effortExplicit as boolean | undefined,
    };

    for (const rec of records) {
      if (rec.type === "state") {
        if (rec.mode !== undefined) meta = { ...meta, mode: rec.mode as string };
        if (rec.model !== undefined)
          meta = { ...meta, model: rec.model as string };
        if (rec.provider !== undefined)
          meta = { ...meta, provider: rec.provider as string };
        if (rec.modelExplicit !== undefined)
          meta = { ...meta, modelExplicit: rec.modelExplicit as boolean };
        if (rec.effort !== undefined)
          meta = { ...meta, effort: rec.effort as string };
        if (rec.effortExplicit !== undefined)
          meta = { ...meta, effortExplicit: rec.effortExplicit as boolean };
      }
    }

    const messages: Message[] = [];
    for (const rec of records) {
      if (rec.type === "message" && rec.message) {
        messages.push(rec.message as Message);
      }
    }

    return { meta, messages };
  }

  async loadEffective(
    sessionId: string,
  ): Promise<{ meta: SessionMeta; messages: Message[] }> {
    const loaded = await this.load(sessionId);
    if (!loaded) throw new Error(`Session not found: ${sessionId}`);

    const records = await this.readRecords(sessionId);
    if (!records) throw new Error(`Session not found: ${sessionId}`);

    let lastCompaction: {
      replacesThrough: number;
      summary: CompactionSummary;
    } | null = null;
    for (const rec of records) {
      if (rec.type === "compaction") {
        lastCompaction = rec as unknown as {
          replacesThrough: number;
          summary: CompactionSummary;
        };
      }
    }

    if (!lastCompaction) {
      return loaded;
    }

    const summaryMsg: Message = {
      role: "user",
      content: formatCompactionText(lastCompaction.summary),
    };

    const effectiveMessages = [
      summaryMsg,
      ...loaded.messages.slice(lastCompaction.replacesThrough + 1),
    ];

    return { meta: loaded.meta, messages: effectiveMessages };
  }

  async getMessageCount(sessionId: string): Promise<number> {
    const records = await this.readRecords(sessionId);
    if (!records) return 0;
    let count = 0;
    for (const rec of records) {
      if (rec.type === "message") count++;
    }
    return count;
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    try {
      await unlink(this.filePath(sessionId));
    } catch {
      return false;
    }
    // Prune the index entry too (best-effort; a stale entry is repaired on the
    // next `list()` rebuild regardless).
    try {
      const index = await this.readIndex();
      if (index) {
        const next = index.sessions.filter((s) => s.id !== sessionId);
        if (next.length !== index.sessions.length) {
          await this.writeIndex({ ...index, sessions: next });
        }
      }
    } catch {
      // ignore
    }
    return true;
  }

  /**
   * Remove old session transcripts for this project, never touching anything
   * except explicit `*.jsonl` files in the private session directory. The
   * current session is excluded because callers invoke this after selecting or
   * creating it. With no retention settings this is a no-op, preserving the
   * historical keep-everything behavior.
   */
  async pruneRetention(excludeSessionId?: string): Promise<number> {
    const { maxSessions, maxAgeDays } = this.retention;
    if (maxSessions === undefined && maxAgeDays === undefined) return 0;

    let entries: SessionIndexEntry[] = [];
    for (const id of await this.diskSessionIds()) {
      const derived = await this.deriveEntry(id);
      if (derived) entries.push(derived);
    }

    const remove = new Set<string>();
    if (maxAgeDays !== undefined) {
      const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
      for (const entry of entries) {
        if (entry.id === excludeSessionId) continue;
        const updated = Date.parse(entry.updatedAt || entry.createdAt);
        if (Number.isFinite(updated) && updated < cutoff) remove.add(entry.id);
      }
    }

    if (maxSessions !== undefined && entries.length > maxSessions) {
      const ordered = [...entries].sort((a, b) =>
        Date.parse(b.updatedAt || b.createdAt) - Date.parse(a.updatedAt || a.createdAt),
      );
      const others = ordered.filter((entry) => entry.id !== excludeSessionId);
      const keep = new Set(
        others
          .slice(0, Math.max(0, maxSessions - (excludeSessionId ? 1 : 0)))
          .map((entry) => entry.id),
      );
      // A resumed session is never evicted merely because it is old. The
      // remaining count is reduced above so the configured cap still holds.
      if (excludeSessionId && entries.some((entry) => entry.id === excludeSessionId)) {
        keep.add(excludeSessionId);
      }
      for (const entry of entries) {
        if (entry.id !== excludeSessionId && !keep.has(entry.id)) remove.add(entry.id);
      }
    }

    let removed = 0;
    for (const id of remove) {
      try {
        await unlink(this.filePath(id));
        removed++;
      } catch {
        // A concurrent cleanup or an unreadable file must not abort startup.
      }
    }

    if (removed > 0) {
      try {
        const index = await this.readIndex();
        if (index) {
          await this.writeIndex({
            ...index,
            sessions: index.sessions.filter((entry) => !remove.has(entry.id)),
          });
        }
      } catch {
        // list() rebuilds a stale index from the remaining JSONL files.
      }
    }
    return removed;
  }

  async getSummary(sessionId: string): Promise<string | undefined> {
    const records = await this.readRecords(sessionId);
    if (!records) return undefined;
    for (const rec of records) {
      if (rec.type === "state" && typeof rec.summary === "string") {
        return rec.summary as string;
      }
    }
    return undefined;
  }

  /**
   * Build an index entry for one session by scanning its JSONL. Returns null if
   * the file is missing, empty, or has no valid `meta` record. Detects a torn
   * final line (unclean write) to report `failed` status. This is the single
   * source of the derivation rules — both incremental updates and full rebuilds
   * go through it, so the index and a from-scratch scan can never disagree.
   */
  private async deriveEntry(sessionId: string): Promise<SessionIndexEntry | null> {
    let raw: string;
    try {
      raw = await readFile(this.filePath(sessionId), "utf-8");
    } catch {
      return null;
    }

    const lines = raw.split("\n").filter((l) => l.trim() !== "");
    if (lines.length === 0) return null;

    let meta: { id: string; createdAt: string } | null = null;
    let title = "";
    let messageCount = 0;
    let lastMessageRole: Message["role"] | null = null;
    let lastAt = "";
    let torn = false;
    let totalUsed: number | undefined;
    let budgetMax: number | undefined;

    for (let i = 0; i < lines.length; i++) {
      let rec: SessionRecord;
      try {
        rec = JSON.parse(lines[i]);
      } catch {
        // A mid-file unparseable line is dropped; a torn final line marks the
        // session as failed (a write was cut off).
        if (i === lines.length - 1) torn = true;
        continue;
      }

      if (typeof rec.at === "string" && rec.at) lastAt = rec.at;

      if (rec.type === "meta" && !meta) {
        meta = { id: rec.id as string, createdAt: rec.createdAt as string };
      } else if (rec.type === "message" && rec.message) {
        messageCount++;
        const msg = rec.message as Message;
        lastMessageRole = msg.role;
        if (!title && msg.role === "user") {
          title = redactSecrets(String(msg.content ?? "")).slice(0, TITLE_MAX);
        }
      } else if (rec.type === "token") {
        if (typeof rec.totalUsed === "number") totalUsed = rec.totalUsed;
        if (typeof rec.budgetMax === "number") budgetMax = rec.budgetMax;
      }
    }

    if (!meta) return null;

    const status: SessionStatus = torn
      ? "failed"
      : lastMessageRole === "assistant" || lastMessageRole === "tool"
        ? "completed"
        : "interrupted";

    return {
      id: meta.id,
      title,
      createdAt: meta.createdAt,
      updatedAt: lastAt || meta.createdAt,
      status,
      messageCount,
      ...(totalUsed !== undefined ? { totalUsed } : {}),
      ...(budgetMax !== undefined ? { budgetMax } : {}),
    };
  }

  /**
   * Read the index. Returns null when the file is absent OR unparseable — a
   * corrupt index is treated as a cache miss so the caller rebuilds from the
   * JSONL (the source of truth) rather than trusting garbage.
   */
  private async readIndex(): Promise<SessionsIndex | null> {
    let raw: string;
    try {
      raw = await readFile(this.indexPath, "utf-8");
    } catch {
      return null;
    }
    try {
      const parsed = JSON.parse(raw) as SessionsIndex;
      if (
        !parsed ||
        typeof parsed !== "object" ||
        !Array.isArray(parsed.sessions)
      ) {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  /** Atomically write the index (temp file + rename) so a reader never sees a half-written file. */
  private async writeIndex(index: SessionsIndex): Promise<void> {
    await ensurePrivateStateDirectoryAsync(dirname(dirname(this.sessionDir)), "sessions", basename(this.sessionDir));
    const tmp = `${this.indexPath}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
    await writePrivateFile(tmp, JSON.stringify(index, null, 2) + "\n");
    await rename(tmp, this.indexPath);
  }

  /**
   * Rebuild the entire index by scanning every JSONL in the session dir. Used
   * on first run for a legacy dir and to recover from a corrupt index.
   */
  private async rebuildIndex(): Promise<SessionsIndex> {
    let entries: string[];
    try {
      entries = await readdir(this.sessionDir);
    } catch {
      entries = [];
    }

    const sessions: SessionIndexEntry[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".jsonl")) continue;
      const sessionId = entry.replace(/\.jsonl$/, "");
      const derived = await this.deriveEntry(sessionId);
      if (derived) sessions.push(derived);
    }

    // Preserve any user-set titles from a still-readable existing index: a
    // rebuild is a cache repair, not a reason to discard renames.
    const existing = await this.readIndex();
    if (existing) {
      const titles = new Map(existing.sessions.map((s) => [s.id, s.title]));
      for (const s of sessions) {
        const t = titles.get(s.id);
        if (t && t !== s.title) s.title = t;
      }
    }

    const index: SessionsIndex = { version: INDEX_VERSION, sessions };
    await this.writeIndex(index);
    return index;
  }

  /**
   * Recompute one session's entry and merge it into the index in place. Any
   * existing (renamed) title is preserved. Failures here are swallowed: the
   * index is a cache, and a failed update just means the next `list()` repairs
   * it from the scan.
   */
  private async updateIndexEntry(sessionId: string): Promise<void> {
    try {
      const derived = await this.deriveEntry(sessionId);
      if (!derived) return;

      const index = (await this.readIndex()) ?? { version: INDEX_VERSION, sessions: [] };
      const prev = index.sessions.find((s) => s.id === sessionId);
      // Keep a title the user explicitly renamed (one that differs from the
      // first-user-message excerpt we would otherwise derive).
      if (prev && prev.title && prev.title !== derived.title) {
        derived.title = prev.title;
      }
      index.sessions = [
        ...index.sessions.filter((s) => s.id !== sessionId),
        derived,
      ];
      await this.writeIndex(index);
    } catch {
      // Best-effort cache maintenance; JSONL remains the source of truth.
    }
  }

  /** Rename a session by setting a custom title in the index. Rebuilds if the index is missing/corrupt. */
  async renameSession(id: string, title: string): Promise<boolean> {
    const derived = await this.deriveEntry(id);
    if (!derived) return false;

    let index = (await this.readIndex());
    if (!index) index = await this.rebuildIndex();

    const clean = redactSecrets(title).slice(0, TITLE_MAX);
    const entry = index.sessions.find((s) => s.id === id);
    if (entry) {
      entry.title = clean;
    } else {
      index.sessions.push({ ...derived, title: clean });
    }
    await this.writeIndex(index);
    return true;
  }

  /** The set of session IDs on disk (`*.jsonl` basenames). Empty if the dir is missing. */
  private async diskSessionIds(): Promise<Set<string>> {
    let entries: string[];
    try {
      entries = await readdir(this.sessionDir);
    } catch {
      return new Set();
    }
    return new Set(
      entries
        .filter((e) => e.endsWith(".jsonl"))
        .map((e) => e.replace(/\.jsonl$/, "")),
    );
  }

  private entryToListItem(e: SessionIndexEntry): SessionListItem {
    return {
      id: e.id,
      // Kept for back-compat with existing search/display: the excerpt is the
      // derived title (a rename overrides `title` but leaves `firstMessage`).
      firstMessage: e.title.slice(0, 60),
      messageCount: e.messageCount,
      createdAt: e.createdAt,
      title: e.title,
      updatedAt: e.updatedAt,
      status: e.status,
      ...(e.totalUsed !== undefined ? { totalUsed: e.totalUsed } : {}),
      ...(e.budgetMax !== undefined ? { budgetMax: e.budgetMax } : {}),
    };
  }

  async list(): Promise<SessionListItem[]> {
    const diskIds = await this.diskSessionIds();
    if (diskIds.size === 0) return [];

    let index = await this.readIndex();

    // Rebuild when the index is missing/corrupt (legacy dir → transparent
    // build) or stale — the on-disk `.jsonl` set and the index's session set
    // must agree, otherwise the cache is out of date.
    const indexIds = index ? new Set(index.sessions.map((s) => s.id)) : null;
    const fresh =
      indexIds !== null &&
      indexIds.size === diskIds.size &&
      [...diskIds].every((id) => indexIds.has(id));

    if (!fresh) {
      index = await this.rebuildIndex();
    }

    const results = index!.sessions
      // Only surface sessions whose JSONL still exists (a deleted file may
      // linger in a stale-but-fresh-enough index between rebuilds).
      .filter((e) => diskIds.has(e.id))
      .map((e) => this.entryToListItem(e));

    results.sort((a, b) => b.id.localeCompare(a.id));
    return results;
  }
}

/**
 * Restricted, audit-only view of a parent SessionStore handed to sub-agents
 * spawned via `new_task` (src/orchestrator/index.ts; decision H —
 * feature-plans.md §10, subsystems.md §7).
 *
 * Exactly three members exist on the view:
 *
 * - `appendPermission` / `appendToken` — forwarded to the parent store with
 *   `source: "subagent"` stamped on the row, so the parent session's JSONL
 *   gains a debuggable audit trail of every sub-agent permission decision
 *   and token-usage turn.
 * - `getMessageCount` — always 0: agent.ts's compaction-persist path keys
 *   off `persistedCount > 0`, and a sub-agent must never write a compaction
 *   marker into the parent transcript (its message indices would corrupt
 *   resume).
 *
 * Every other SessionStore member is absent (undefined) by construction: a
 * sub-agent can never append messages, state, todo snapshots, or anything
 * else into the parent session. Todo isolation is untouched — the
 * orchestrator still threads a fresh TodoStore, and `appendTodo` is simply
 * blocked here. The view needs no re-audit when SessionStore grows: new
 * members default to blocked.
 */
export function subagentAuditStore(parent: SessionStore): SessionStore {
  return new Proxy(parent, {
    get(target, prop) {
      if (prop === "appendPermission") {
        return (sessionId: string, record: PermissionAuditRecord): Promise<void> =>
          target.appendPermission(sessionId, { ...record, source: "subagent" });
      }
      if (prop === "appendToken") {
        return (sessionId: string, record: TokenUsageRecord): Promise<void> =>
          target.appendToken(sessionId, { ...record, source: "subagent" });
      }
      if (prop === "getMessageCount") return async () => 0;
      return undefined;
    },
  });
}
