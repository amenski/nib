import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, statSync, chmodSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { resolveHome } from "../config/loader.js";

/**
 * Trust-on-first-use store for project-declared hooks (docs/hooks-spec.md §6).
 * Mirrors skill-trust.json: a JSON file under ~/.nib (NIB_HOME
 * honored, same as every other user-level file) keyed by a full sha256 of
 * `event|matcher|command|content-hash` scoped to the project dir, so the
 * trust file never echoes command text it would otherwise not need to hold.
 * Global-settings hooks never consult this store — they are trusted
 * implicitly.
 *
 * Like skills, an unseen project hook requires an explicit ask-tier
 * confirmation before it ever runs: y = trust forever (persisted), n = skip
 * this session.
 */

export interface TrustEntry {
  firstSeen: number;
  trusted: boolean;
}

export interface TrustStore {
  hooks: Record<string, TrustEntry>;
}

/** Sentinel content hash for a file command whose script cannot be read —
 *  never auto-trusted (a missing file cannot be bound to a hash). */
const MISSING_FILE_HASH = "missing";

/** Per-path content-hash cache, mtime-gated so a script edit re-reads (fix 1). */
export type ContentHashCache = Map<string, { mtimeMs: number; hash: string }>;

function trustFilePath(): string {
  return `${resolveHome()}/hooks-trust.json`;
}

export function loadHookTrust(): TrustStore {
  const path = trustFilePath();
  if (!existsSync(path)) return { hooks: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    if (parsed && typeof parsed === "object" && parsed.hooks && typeof parsed.hooks === "object") {
      return parsed as TrustStore;
    }
    return { hooks: {} };
  } catch {
    return { hooks: {} };
  }
}

/**
 * Write the trust store: mode 0600, atomic (tmp + rename), and any failure is
 * swallowed with a stderr note — a trust-save failure must never become an
 * unhandled rejection at a turn boundary (fix 8). The hook still runs for the
 * session; only the persistence is lost.
 */
export function saveHookTrust(store: TrustStore): void {
  const path = trustFilePath();
  const dir = dirname(path);
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}`;
    writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
    renameSync(tmp, path);
    chmodSync(path, 0o600);
  } catch (err) {
    process.stderr.write(`nib: failed to write hooks-trust.json: ${(err as Error).message}\n`);
  }
}

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * Content hash for a hook command (fix 1): a command whose first token is a
 * path (contains "/", e.g. `hook-scripts/guard.sh`) hashes the resolved file's
 * content — the trust key then binds what will actually execute, so a script
 * edit changes the hash and forces re-confirmation. A path that resolves to no
 * file (or a directory) hashes to a never-auto-trusted sentinel. Everything
 * else (`npm run x`, `sh -c …`, `echo …`) is inline shell and hashes the
 * command string itself. The per-path cache is mtime-gated: an unchanged
 * mtime reuses the cached hash; any write (mtime bump) re-reads and re-hashes.
 */
export function hookContentHash(command: string, projectDir: string, cache?: ContentHashCache): string {
  const first = command.trim().split(/\s+/)[0] ?? "";
  if (!first.includes("/")) return hashText(command);
  const path = resolve(projectDir, first);
  let stat;
  try {
    stat = statSync(path);
  } catch {
    cache?.delete(path);
    return MISSING_FILE_HASH;
  }
  if (!stat.isFile()) {
    cache?.delete(path);
    return MISSING_FILE_HASH;
  }
  const cached = cache?.get(path);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.hash;
  let content: Buffer;
  try {
    content = readFileSync(path);
  } catch {
    cache?.delete(path);
    return MISSING_FILE_HASH;
  }
  const hash = createHash("sha256").update(content).digest("hex");
  cache?.set(path, { mtimeMs: stat.mtimeMs, hash });
  return hash;
}

/**
 * Full 256-bit trust key (fix 1 + fix 6): sha256 of the five key inputs —
 * `event`, `matcher`, `command`, the content hash, and the project dir —
 * JSON-encoded so field boundaries are unambiguous (commands may contain
 * pipes), and scoped to the project dir so the same hook in two projects
 * never shares trust. Full digest — no truncation.
 */
export function hookTrustKey(
  event: string,
  matcher: string | undefined,
  command: string,
  contentHash: string,
  projectDir: string,
): string {
  return hashText(JSON.stringify([event, matcher ?? "", command, contentHash, projectDir]));
}

export function isHookTrusted(store: TrustStore, hash: string): boolean {
  return store.hooks[hash]?.trusted === true;
}
