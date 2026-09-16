import { existsSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { SandboxLevel } from "./seatbelt.js";

/**
 * The single shared source of truth for "what is writable under
 * workspace-write" — consulted by both the Seatbelt layer (seatbelt.ts) and
 * the file-tool containment check (permissions/profile.ts), so a path either
 * layer allows is allowed by the other (docs/unified-write-boundary.md).
 *
 * Deliberately separate from `permissionProfile.fs`: an out-of-tree `write`
 * entry there is a fatal config error by design (loader.ts's
 * validatePermissionProfile, "explicit rules narrow only") — that invariant
 * protects against an untrusted PROJECT granting itself the filesystem and
 * must not be touched. `sandbox.writeRoots` is a different, GLOBAL-ONLY
 * setting that the loader parses from globalRaw alone (see loader.ts).
 */

/**
 * Realpath-resolves a path via its nearest existing ancestor (the D1 pattern
 * from security-spec T6): walk up to the deepest existing component, resolve
 * that with realpath, re-append the missing tail. The physical form is what
 * the kernel matches SBPL subpaths against and what a file-tool containment
 * check needs — a symlink escaping a write root resolves to its target and is
 * caught. A leading "~" expands to the home directory. Falls back to the
 * lexical absolute when nothing on the path exists (the caller would fail on
 * its own merits anyway).
 */
export function realpathNearestAncestor(path: string): string {
  const abs = path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : resolve(path);
  let existing = abs;
  const missing: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) return abs; // nothing on the path exists
    missing.unshift(basename(existing));
    existing = parent;
  }
  let real: string;
  try {
    real = realpathSync(existing);
  } catch {
    real = existing; // vanished between existsSync and realpathSync — keep the lexical form
  }
  return missing.length ? join(real, ...missing) : real;
}

/**
 * The workspace-write carve-outs — deliberate exceptions to the write
 * boundary, battery-proven 2026-08-15 (see seatbelt.ts's buildSeatbeltProfile
 * doc comment for the evidence): ephemeral temp (literal `/tmp` + the session
 * `$TMPDIR`) and the npm cache (`~/.npm`). strict-sandbox gains none of these.
 */
function workspaceWriteCarveoutRoots(): string[] {
  const literalTmp = realpathNearestAncestor("/tmp");
  const sessionTmp = realpathNearestAncestor(tmpdir());
  const npmCache = realpathNearestAncestor(join(homedir(), ".npm"));
  const seen = new Set<string>();
  const roots: string[] = [];
  for (const p of [literalTmp, sessionTmp, npmCache]) {
    if (seen.has(p)) continue; // TMPDIR unset on some hosts ⇒ tmpdir() === /tmp
    seen.add(p);
    roots.push(p);
  }
  return roots;
}

/**
 * Resolves the full set of directories writable under `workspace-write`:
 * `trustedRoot` (the session workspace root) + the carve-outs + any
 * globally-configured `sandbox.writeRoots`, all realpath-resolved. Order is
 * trustedRoot first, then carve-outs, then configured roots — callers that
 * emit one line per entry (buildSeatbeltProfile) get a stable, readable
 * order; de-duplicated so a configured root that coincides with the
 * trustedRoot or a carve-out doesn't produce a redundant entry.
 *
 * `strict-sandbox` returns an empty set — no writes anywhere, matching how
 * the Seatbelt layer's read-only core has no write-set at that level. The
 * configured `writeRoots` apply to `workspace-write` only, same as the
 * carve-outs.
 *
 * Each configured writeRoot is resolved via {@link realpathNearestAncestor},
 * so a root that doesn't exist yet still resolves (to its nearest existing
 * ancestor's realpath + the missing tail) rather than being silently
 * dropped — the directory can be created later and the grant still applies
 * to it, exactly like `trustedRoot` and the carve-outs already do.
 */
export function resolveWriteRoots(
  level: SandboxLevel,
  trustedRoot: string,
  writeRoots?: string[],
  sessionTempDir?: string,
): string[] {
  if (level === "strict-sandbox") return [];

  const seen = new Set<string>();
  const roots: string[] = [];
  const add = (p: string) => {
    const real = realpathNearestAncestor(p);
    if (seen.has(real)) return;
    seen.add(real);
    roots.push(real);
  };

  add(trustedRoot);
  for (const p of sessionTempDir ? [sessionTempDir] : workspaceWriteCarveoutRoots()) add(p);
  for (const p of writeRoots ?? []) add(p);

  return roots;
}

/**
 * Whether `target` resolves (realpath, nearest-existing-ancestor) inside any
 * of `roots` (themselves already realpath-resolved, e.g. from
 * {@link resolveWriteRoots}). A symlink pointing outside every root is
 * caught — same containment discipline as validateCwdWithinTrustedRoot and
 * the search/glob out-of-workspace check (permissions/engine.ts).
 */
export function isPathWithinWriteRoots(target: string, roots: string[]): boolean {
  const realTarget = realpathNearestAncestor(target);
  return roots.some((root) => {
    const rel = relative(root, realTarget);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  });
}
