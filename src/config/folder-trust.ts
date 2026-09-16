import { readFileSync, renameSync, existsSync, chmodSync, realpathSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveHome, type LoadResult } from "./loader.js";
import { PROJECT_DIR_NAME, projectSettingsPath } from "./paths.js";
import type { HookEntry } from "../hooks/types.js";
import { hookContentHash, hookTrustKey, loadHookTrust, saveHookTrust, type ContentHashCache } from "../hooks/trust.js";
import { loadSkillTrust, saveSkillTrust, skillContentHash } from "../skills/trust.js";
import { loadSettingsTrust, saveSettingsTrust, settingsContentHash } from "./settings-trust.js";
import { ensurePrivateDirectory, writePrivateFileSync } from "./state-permissions.js";

/**
 * Folder-level trust — a "fast path" bulk-approval convenience layered on top
 * of the three existing per-artifact TOFU gates (skills: skills/trust.ts,
 * hooks: hooks/trust.ts, settings: config/settings-trust.ts). It is NOT a
 * fourth independent trust mechanism: answering "yes" here does nothing more
 * than pre-populate the same three trust stores those gates already read, for
 * exactly the artifacts present in the project right now — using the exact
 * same key derivation (realpath+hash for skills/settings, the content-hashed
 * `hookTrustKey` for hooks) each gate already uses. This means:
 *
 *  - A "yes" here is fully equivalent to answering "yes" to every pending
 *    per-artifact prompt individually — no new bypass surface, no new trust
 *    semantics for those three gates to reason about.
 *  - Content that changes AFTER folder trust, or a new artifact ADDED after
 *    folder trust, has no matching entry in the underlying store (its hash —
 *    or for hooks, its whole trust key, which is itself hash-derived — no
 *    longer matches what was recorded) and therefore still re-prompts via the
 *    normal per-artifact gate. This is deliberate: folder trust is a bulk
 *    "yes" convenience, not a blanket "trust this tree forever" grant. The
 *    content-change re-prompt is the tamper signal and must survive.
 *
 * This module's OWN store (folder-trust.json) exists only to answer "have I
 * already asked about (and been told yes for) this exact folder in this
 * exact state?" — i.e. whether to even show the folder-trust prompt again.
 * It is not consulted by the three underlying gates at all; they are
 * entirely unaware folder trust exists.
 */

export interface FolderTrustEntry {
  path: string;
  /** Content hashes of every artifact that was present and got bulk-trusted,
   *  keyed by a stable per-artifact id (skill sourcePath realpath, the
   *  settings file realpath, or a hook's own trust key). Used only to decide
   *  whether the folder-trust prompt itself should re-fire — the per-artifact
   *  gates make their own independent decision from their own stores. */
  artifactHashes: Record<string, string>;
  firstSeen: number;
  lastChanged?: number;
  trusted: boolean;
}

export interface FolderTrustStore {
  folders: Record<string, FolderTrustEntry>;
}

function folderTrustFilePath(): string {
  return `${resolveHome()}/folder-trust.json`;
}

export function loadFolderTrust(): FolderTrustStore {
  const path = folderTrustFilePath();
  if (!existsSync(path)) return { folders: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    if (parsed && typeof parsed === "object" && parsed.folders && typeof parsed.folders === "object") {
      return parsed as FolderTrustStore;
    }
    return { folders: {} };
  } catch {
    return { folders: {} };
  }
}

/**
 * Write the trust store: mode 0600, atomic (tmp + rename), and any failure is
 * swallowed with a stderr note — a trust-save failure must never become an
 * unhandled rejection at a turn boundary. The session still proceeds with the
 * bulk-trust decision applied in-memory (via the underlying per-artifact
 * stores, which are saved independently); only the folder-level "don't ask
 * again" record is lost.
 */
export function saveFolderTrust(store: FolderTrustStore): void {
  const path = folderTrustFilePath();
  const dir = dirname(path);
  try {
    ensurePrivateDirectory(dir);
    const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}`;
    writePrivateFileSync(tmp, JSON.stringify(store, null, 2));
    renameSync(tmp, path);
    chmodSync(path, 0o600);
  } catch (err) {
    process.stderr.write(`nib: failed to write folder-trust.json: ${(err as Error).message}\n`);
  }
}

/** Canonicalize a project dir for store keys: realpath, so a workspace
 *  reached through a symlink (or macOS's /var → /private/var spelling) is
 *  always the same key. Falls back to the raw path if it's gone. */
function realProjectDir(projectDir: string): string {
  try {
    return realpathSync(projectDir);
  } catch {
    return projectDir;
  }
}

// ── Enumerating what's "currently present" ──

export interface DiscoveredSkill {
  name: string;
  sourcePath: string;
}

/**
 * Minimal project-skill scan for folder-trust's own purposes: just enough to
 * list what's present and hash it for the summary + bulk-trust write. This
 * intentionally does NOT reuse skills/index.ts's scanDir — that function
 * scans relative to `process.cwd()` and does full frontmatter validation for
 * indexing into the system prompt. Folder trust only needs "which SKILL.md
 * files exist under this project dir's skill directories right now", which
 * is a much smaller surface and must work independent of when SkillLoader
 * itself runs (folder trust runs BEFORE it, in both entry points).
 */
export function discoverProjectSkills(projectDir: string): DiscoveredSkill[] {
  const found: DiscoveredSkill[] = [];
  for (const sub of [`${PROJECT_DIR_NAME}/skills`, ".agents/skills"]) {
    const dir = join(projectDir, ...sub.split("/"));
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillPath = join(dir, entry.name, "SKILL.md");
      if (!existsSync(skillPath)) continue;
      found.push({ name: entry.name, sourcePath: skillPath });
    }
  }
  return found;
}

/** Summary of gated content found in a project dir right now — used both to
 *  render the folder-trust prompt and to bulk-trust exactly this set. */
export interface FolderContentSummary {
  skills: DiscoveredSkill[];
  settingsKeys: string[];
  settingsPath: string;
  hooks: HookEntry[];
}

/**
 * Builds the summary from what `loadConfig()` already parsed, plus a skill
 * scan (skills aren't loaded by SkillLoader yet at the point folder trust
 * runs — see discoverProjectSkills). Used identically by both entry points
 * (cli.tsx, exec-runner.ts) so the fast-path decision is based on the exact
 * same "what's gated right now" view the three real gates will use moments
 * later.
 */
export function buildFolderContentSummary(projectDir: string, configResult: LoadResult): FolderContentSummary {
  return {
    skills: discoverProjectSkills(projectDir),
    settingsKeys: configResult.projectExecutionKeys,
    settingsPath: projectSettingsPath(projectDir),
    hooks: (configResult.config.hooks?.entries ?? []).filter((e) => e.origin === "project"),
  };
}

/** True when there is nothing gated to ask about — the folder-trust prompt
 *  must not fire for a project with no untrusted gated content. */
export function hasGatedContent(summary: FolderContentSummary): boolean {
  return summary.skills.length > 0 || summary.settingsKeys.length > 0 || summary.hooks.length > 0;
}

// ── Classifying folder trust ──

export type FolderTrustResult =
  | { status: "trusted" }
  | { status: "new" }
  | { status: "changed" };

/**
 * Per-artifact id → content hash for everything in `summary`, using each
 * gate's own hash function so the recorded value is directly comparable
 * against what that gate would compute later.
 */
function artifactHashesFor(summary: FolderContentSummary, cwd: string): Record<string, string> {
  const hashes: Record<string, string> = {};
  for (const skill of summary.skills) {
    try {
      hashes[`skill:${realpathSyncSafe(skill.sourcePath)}`] = skillContentHash(skill.sourcePath);
    } catch {
      // Unreadable at scan time — skip; the per-artifact gate will handle it directly.
    }
  }
  if (summary.settingsKeys.length > 0) {
    try {
      hashes[`settings:${realpathSyncSafe(summary.settingsPath)}`] = settingsContentHash(summary.settingsPath);
    } catch {
      // Unreadable — skip.
    }
  }
  const cache: ContentHashCache = new Map();
  for (const entry of summary.hooks) {
    const contentHash = hookContentHash(entry.command, cwd, cache);
    const key = hookTrustKey(entry.event, entry.matcher, entry.command, contentHash, cwd);
    hashes[`hook:${key}`] = key;
  }
  return hashes;
}

function realpathSyncSafe(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * Classify a project dir's CURRENT gated content against the folder-trust
 * store WITHOUT persisting anything. `new` = never asked; `trusted` = asked
 * yes, and every artifact present now has a matching recorded hash (nothing
 * added, nothing changed); `changed` = asked yes previously, but the set of
 * artifact hashes no longer matches exactly — something was added, removed,
 * or edited, so the fast path no longer applies and the prompt (or, on
 * decline, the per-artifact gates) must run again.
 */
export function checkFolderTrust(projectDir: string, summary: FolderContentSummary): FolderTrustResult {
  const key = realProjectDir(projectDir);
  const store = loadFolderTrust();
  const entry = store.folders[key];
  if (!entry || !entry.trusted) return { status: "new" };
  const current = artifactHashesFor(summary, key);
  const currentKeys = Object.keys(current).sort();
  const storedKeys = Object.keys(entry.artifactHashes).sort();
  if (currentKeys.length !== storedKeys.length) return { status: "changed" };
  for (let i = 0; i < currentKeys.length; i++) {
    if (currentKeys[i] !== storedKeys[i]) return { status: "changed" };
  }
  for (const k of currentKeys) {
    if (current[k] !== entry.artifactHashes[k]) return { status: "changed" };
  }
  return { status: "trusted" };
}

/**
 * Record an explicit "trust this folder" decision AND bulk-apply it to the
 * three underlying per-artifact stores for exactly what's in `summary` right
 * now — equivalent to answering "yes" to each pending prompt individually.
 * Anything added or changed afterward has no matching entry in the
 * underlying stores (or, for the folder record itself, no matching hash set)
 * and therefore still goes through the normal per-artifact gate.
 */
export function trustFolder(projectDir: string, summary: FolderContentSummary): void {
  const key = realProjectDir(projectDir);

  // Bulk-apply to skill-trust.json.
  if (summary.skills.length > 0) {
    const skillStore = loadSkillTrust();
    for (const skill of summary.skills) {
      try {
        const skillKey = realpathSyncSafe(skill.sourcePath);
        const hash = skillContentHash(skill.sourcePath);
        const existing = skillStore.skills[skillKey];
        skillStore.skills[skillKey] = {
          path: skillKey,
          hash,
          firstSeen: existing?.firstSeen ?? Date.now(),
          lastChanged: existing && existing.hash !== hash ? Date.now() : existing?.lastChanged,
          trusted: true,
        };
      } catch {
        // Unreadable at trust time — leave ungated; the per-artifact gate
        // (SkillLoader) will surface it normally instead of silently skipping.
      }
    }
    saveSkillTrust(skillStore);
  }

  // Bulk-apply to settings-trust.json.
  if (summary.settingsKeys.length > 0) {
    try {
      const settingsStore = loadSettingsTrust();
      const settingsKey = realpathSyncSafe(summary.settingsPath);
      const hash = settingsContentHash(summary.settingsPath);
      const existing = settingsStore.settings[settingsKey];
      settingsStore.settings[settingsKey] = {
        path: settingsKey,
        hash,
        firstSeen: existing?.firstSeen ?? Date.now(),
        lastChanged: existing && existing.hash !== hash ? Date.now() : existing?.lastChanged,
        trusted: true,
      };
      saveSettingsTrust(settingsStore);
    } catch {
      // Unreadable — leave ungated; checkSettingsTrust will surface it normally.
    }
  }

  // Bulk-apply to hooks-trust.json: pre-record a trust entry for each
  // project hook, keyed by the SAME content-hashed trust key
  // HookRunner.trustKeyFor computes lazily at fire time
  // (hookContentHash + hookTrustKey — hooks/trust.ts). This is what makes the
  // fast path work for hooks specifically: HookRunner never needs to know
  // folder trust exists. verifyTrust()/ensureTrusted() just find these
  // entries already present in hooks-trust.json via isHookTrusted() and treat
  // them exactly as if the user had answered the HookTrustPrompt directly.
  // Because the key already encodes the hook's content hash, an edited
  // command or script produces a DIFFERENT key with no matching entry here —
  // the lazy check falls through to a normal ask, with no special-casing
  // needed in hooks/runner.ts or hooks/trust.ts at all.
  if (summary.hooks.length > 0) {
    const hookStore = loadHookTrust();
    const cache: ContentHashCache = new Map();
    for (const entry of summary.hooks) {
      const contentHash = hookContentHash(entry.command, key, cache);
      const trustKey = hookTrustKey(entry.event, entry.matcher, entry.command, contentHash, key);
      hookStore.hooks[trustKey] = { firstSeen: Date.now(), trusted: true };
    }
    saveHookTrust(hookStore);
  }

  // Record the folder-level decision itself, so the prompt doesn't re-fire
  // for an unchanged set of artifacts.
  const folderStore = loadFolderTrust();
  const existingFolder = folderStore.folders[key];
  const artifactHashes = artifactHashesFor(summary, key);
  folderStore.folders[key] = {
    path: key,
    artifactHashes,
    firstSeen: existingFolder?.firstSeen ?? Date.now(),
    lastChanged: existingFolder ? Date.now() : undefined,
    trusted: true,
  };
  saveFolderTrust(folderStore);
}
