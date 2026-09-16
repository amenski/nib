import { createHash } from "node:crypto";
import { readFileSync, renameSync, existsSync, chmodSync, realpathSync } from "node:fs";
import { dirname } from "node:path";
import { resolveHome } from "../config/loader.js";
import { ensurePrivateDirectory, writePrivateFileSync } from "../config/state-permissions.js";

/**
 * Trust-on-first-use store for project-declared skills (security-spec.md T4,
 * skill-spec.md §6). Mirrors hooks-trust.json: a JSON file under ~/.nib
 * (NIB_HOME honored, same as every other user-level file) keyed by the
 * skill's absolute source path, storing only the full sha256 of the SKILL.md
 * content — never the content itself. Global user skills (~/.nib/skills,
 * ~/.agents/skills) never consult this store — they are trusted implicitly
 * (same split hooks-spec §6 chose for global vs project hooks).
 *
 * Unlike the previous auto-trust-on-first-sight behavior, an unseen or edited
 * project skill is withheld from the session until the user explicitly
 * confirms: `checkSkillTrust` only classifies (new | changed | trusted), and
 * `trustSkill` records the decision. Interactive sessions ask via the
 * SkillTrustPrompt modal; headless runs skip untrusted skills with a stderr
 * warning — fail closed, like hooks.
 */

export interface SkillTrustEntry {
  path: string;
  hash: string;
  firstSeen: number;
  lastChanged?: number;
  trusted: boolean;
}

export interface SkillTrustStore {
  skills: Record<string, SkillTrustEntry>;
}

function skillTrustFilePath(): string {
  return `${resolveHome()}/skill-trust.json`;
}

export function loadSkillTrust(): SkillTrustStore {
  const path = skillTrustFilePath();
  if (!existsSync(path)) return { skills: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    if (parsed && typeof parsed === "object" && parsed.skills && typeof parsed.skills === "object") {
      return parsed as SkillTrustStore;
    }
    return { skills: {} };
  } catch {
    return { skills: {} };
  }
}

/**
 * Write the trust store: mode 0600, atomic (tmp + rename), and any failure is
 * swallowed with a stderr note — a trust-save failure must never become an
 * unhandled rejection at a turn boundary. The skill still runs for the
 * session; only the persistence is lost.
 */
export function saveSkillTrust(store: SkillTrustStore): void {
  const path = skillTrustFilePath();
  const dir = dirname(path);
  try {
    ensurePrivateDirectory(dir);
    const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}`;
    writePrivateFileSync(tmp, JSON.stringify(store, null, 2));
    renameSync(tmp, path);
    chmodSync(path, 0o600);
  } catch (err) {
    process.stderr.write(`nib: failed to write skill-trust.json: ${(err as Error).message}\n`);
  }
}

/**
 * Canonicalize a skill path for store keys: realpath, so the same file is
 * always the same key. Without this, a workspace reached through a symlink
 * (or, on macOS, the `/var` → `/private/var` spelling difference) would get
 * two keys and re-ask every session. Falls back to the raw path if the file
 * is gone (e.g. deleted while the trust modal was open).
 */
function realSkillPath(skillPath: string): string {
  try {
    return realpathSync(skillPath);
  } catch {
    return skillPath;
  }
}

/** Full sha256 of a SKILL.md's content — the trust key, not the content itself. */
export function skillContentHash(skillPath: string): string {
  return createHash("sha256").update(readFileSync(skillPath)).digest("hex");
}

export type SkillTrustResult =
  | { status: "trusted" }
  | { status: "new"; name: string; sourcePath: string }
  | { status: "changed"; name: string; sourcePath: string };

/**
 * Length of the truncated hash format written by a pre-204f856 build
 * (`sha256(...).slice(0, 16)`). Entries this short predate the switch to
 * full-length digests and are migrated in place by `checkSkillTrust` below
 * rather than treated as a genuine content change.
 */
const LEGACY_HASH_LENGTH = 16;

/**
 * Drop store entries whose key (a realpath) no longer exists on disk. Called
 * only from the migration save path in `checkSkillTrust` — never as a
 * separate startup sweep — so pruning piggybacks on a save that is already
 * happening.
 */
function pruneUnreachable(store: SkillTrustStore): void {
  for (const key of Object.keys(store.skills)) {
    if (!existsSync(key)) delete store.skills[key];
  }
}

/**
 * Classify a skill's current content against the trust store WITHOUT
 * persisting anything: the trust decision is recorded only when the user
 * explicitly confirms (trustSkill), so an unseen or edited project skill can
 * be withheld from the session until the ask-tier confirmation. A hash
 * mismatch (content edit) re-classifies as `changed` — the tamper signal.
 *
 * Legacy migration: a build prior to 204f856 stored truncated 16-char
 * hashes. If the stored hash is that legacy length and matches the prefix of
 * the freshly computed full digest, the content hasn't changed — treat it as
 * trusted, rewrite the entry with the full-length hash, prune unreachable
 * entries, and save. A legacy hash that does NOT match the prefix is a real
 * content change and still reports "changed". A full-length stored hash is
 * always compared by exact equality, never by prefix.
 */
export function checkSkillTrust(skillPath: string, skillName: string): SkillTrustResult {
  const key = realSkillPath(skillPath);
  const hash = skillContentHash(key);
  const store = loadSkillTrust();
  const entry = store.skills[key];
  if (!entry) return { status: "new", name: skillName, sourcePath: key };
  if (entry.hash.length === LEGACY_HASH_LENGTH) {
    if (hash.slice(0, LEGACY_HASH_LENGTH) !== entry.hash) {
      return { status: "changed", name: skillName, sourcePath: key };
    }
    store.skills[key] = { ...entry, hash };
    pruneUnreachable(store);
    saveSkillTrust(store);
    return { status: "trusted" };
  }
  if (entry.hash !== hash) return { status: "changed", name: skillName, sourcePath: key };
  return { status: "trusted" };
}

/**
 * Record an explicit "trust forever" decision: store the current content
 * hash, keyed by the canonical (realpath) source path. First trust sets
 * firstSeen; a re-trust after a content change records lastChanged.
 */
export function trustSkill(skillPath: string, skillName: string): void {
  const key = realSkillPath(skillPath);
  const store = loadSkillTrust();
  const existing = store.skills[key];
  const hash = skillContentHash(key);
  store.skills[key] = {
    path: key,
    hash,
    firstSeen: existing?.firstSeen ?? Date.now(),
    lastChanged: existing && existing.hash !== hash ? Date.now() : existing?.lastChanged,
    trusted: true,
  };
  saveSkillTrust(store);
}
