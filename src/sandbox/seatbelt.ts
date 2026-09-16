import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { ProfileLevel } from "../permissions/index.js";
import { resolveWriteRoots } from "./write-roots.js";

/**
 * macOS Seatbelt (sandbox-exec) profile generation — the *mechanical* layer
 * under the PermissionProfile policy (permission-profile.md §8, phase (e)).
 *
 * The policy layer (ProfileEvaluator, src/permissions/profile.ts) decides
 * allow/deny per call; the Seatbelt layer makes the level's defaults hold in
 * the OS for bash children: strict-sandbox = read-only fs + no network,
 * workspace-write = write only workspace roots + network on, with two
 * deliberate, battery-proven carve-outs to the write boundary (ephemeral
 * temp: literal /tmp + the session $TMPDIR; npm cache: ~/.npm — see
 * {@link workspaceWriteCarveouts}). The .git always-denied set is
 * deliberately **not** expressed here — SBPL has no gitignore globs, and the
 * policy layer already enforces it (documented residual,
 * permission-profile.md §8).
 *
 * Two-layer network rationale (all-or-nothing): SBPL's
 * `(allow network-outbound (remote ip "*:443"))` matches IPs only — it
 * cannot express the profile's hostname allowlist (hostnames resolve after
 * the sandbox filter runs). So the Seatbelt layer gates network on/off per
 * level (strict-sandbox off, workspace-write on) and host-level
 * allowlisting stays with the policy layer, which sees the hostname. The
 * deny side is airtight (deny default denies every connect); the allow
 * side is intentionally coarser than the policy — a workspace-write bash
 * child can reach any host, though the policy layer still asks/denies
 * egress via the guarded tier and the profile's network rules.
 *
 * macOS-only. On any other platform `sandboxPrefix` returns null (plain
 * spawn args, policy-only) — the loader emits a one-time startup notice
 * when `sandbox.enabled` is set on a non-macOS host.
 */

/** Levels that get a Seatbelt profile. `unrestricted` never does (no prefix). */
export type SandboxLevel = "strict-sandbox" | "workspace-write";

export interface SandboxSpawn {
  /** Executable to spawn: /usr/bin/sandbox-exec on macOS. */
  file: string;
  /** Full argv: ["-p", "<profile>", "/bin/sh", "-c", command]. */
  args: string[];
}

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/**
 * Core every sandboxed level shares: deny default, then read-only fs plus
 * the plumbing a basic command needs (exec/map executable, sysctl). The
 * single write carve-out is `/dev/null` — `2>/dev/null` redirects are
 * ubiquitous (even the Xcode `git` shim does one internally) and the
 * write is a discard, not a filesystem write. Every other write stays
 * denied at this layer.
 */
const READ_ONLY_CORE = [
  "(allow process*)",
  "(allow file-read*)",
  "(allow file-map-executable)",
  "(allow sysctl-read)",
  '(allow file-write* (literal "/dev/null"))',
];

/** Escapes a path for embedding in an SBPL double-quoted string. */
function sbplQuote(path: string): string {
  return path.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * The SBPL profile source for a level, with the session workspace root
 * fixed at startup — never the per-call cwd (item 8.6) — as the
 * workspace-write write-set. `trustedRoot` is expected already
 * realpath-resolved (via {@link seatbeltWorkspaceRoot}); the sandbox
 * filters on resolved paths, so the subpath must be the physical form.
 * Verified empirically on macOS (2026-08-13): `ls`, `echo`, `git status`,
 * `node -e 'console.log(1)'` all run under the strict profile; writes and
 * network connects fail with EPERM-equivalent denials; the workspace-write
 * subpath is directory-boundary aware (a `(subpath "/a")` rule does not
 * match "/a2/..."). The carve-outs (temp + npm cache) are workspace-write
 * only, battery-proven 2026-08-15.
 *
 * `writeRoots` (optional) is the resolved-root list from
 * {@link resolveWriteRoots} (docs/unified-write-boundary.md) — the shared
 * source of truth also consulted by the file-tool containment check
 * (permissions/engine.ts), so a path either layer allows is allowed by the
 * other. When omitted, `resolveWriteRoots` is called here directly with no
 * configured `sandbox.writeRoots`, which reproduces exactly the trustedRoot +
 * carve-outs set this function has always emitted.
 */
export function buildSeatbeltProfile(
  level: SandboxLevel,
  trustedRoot: string,
  writeRoots?: string[],
): string {
  const lines = ["(version 1)", "(deny default)", ...READ_ONLY_CORE];
  if (level === "workspace-write") {
    const roots = writeRoots ?? resolveWriteRoots(level, trustedRoot);
    for (const root of roots) {
      lines.push(`(allow file-write* (subpath "${sbplQuote(root)}"))`);
    }
    lines.push("(allow network-outbound)");
  }
  return lines.join("\n");
}

/**
 * Realpath-resolves a path via its nearest existing ancestor (the D1
 * pattern from security-spec T6): walk up to the deepest existing
 * component, resolve that with realpath, re-append the missing tail. The
 * physical form is what the kernel matches SBPL subpaths against, and it is
 * what the cwd containment check needs — a symlink escaping the trusted
 * root resolves to its target and is caught. A leading "~" expands to the
 * home directory (matching Node's spawn-cwd expansion), so a model-passed
 * `cwd: "~"` is checked against the home directory rather than treated as
 * a literal relative dir. Falls back to the lexical absolute when nothing
 * on the path exists — the spawn would fail anyway.
 */
export function seatbeltWorkspaceRoot(path: string): string {
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
 * Whether a level would produce a Seatbelt prefix on this platform — the
 * same gate {@link sandboxPrefix} applies. The trusted-root cwd containment
 * check is gated on this too, so level absent/`unrestricted` or a non-macOS
 * host keeps today's spawn behavior exactly.
 */
export function isSandboxedLevel(level: ProfileLevel | undefined): level is SandboxLevel {
  return level !== undefined && level !== "unrestricted" && process.platform === "darwin";
}

/**
 * The trusted-root cwd containment check (item 8.6): the requested spawn
 * cwd, realpath-resolved via its nearest existing ancestor, must equal or
 * be a descendant of the trusted workspace root. A cwd outside the root —
 * or a symlink resolving outside it — is rejected before spawning (tool
 * error, no spawn, no profile).
 */
export function validateCwdWithinTrustedRoot(
  cwd: string,
  trustedRoot: string,
  authorizedRoots: string[] = [],
): { ok: true } | { ok: false; error: string } {
  const resolvedCwd = seatbeltWorkspaceRoot(cwd);
  const roots = [trustedRoot, ...authorizedRoots].map(seatbeltWorkspaceRoot);
  for (const root of roots) {
    const rel = relative(root, resolvedCwd);
    if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
      return { ok: true };
    }
  }
  return {
    ok: false,
    error: `Working directory escapes the sandbox workspace root: ${cwd} (root: ${trustedRoot}). Sandboxed commands must run inside the workspace or an explicitly added directory.`,
  };
}

/**
 * The spawn-time prefix for a bash child. Returns null when no sandbox
 * applies — the caller keeps today's `spawn(command, { shell: true })`
 * exactly: level absent/`unrestricted` (flag off, no profile, or the level
 * is unrestricted), or a non-macOS platform (policy-only).
 *
 * `cwd` is the child's actual working directory (passed to spawn unchanged);
 * `trustedRoot` is the workspace-write profile's write-set root — the
 * session workspace root fixed at startup (`ctx.workingDir`), never the
 * per-call cwd. Callers run {@link validateCwdWithinTrustedRoot} (when
 * {@link isSandboxedLevel} says a profile applies) before spawning.
 *
 * `writeRoots` is the configured `sandbox.writeRoots` list (GLOBAL-only,
 * unresolved paths — resolution happens inside {@link buildSeatbeltProfile}
 * via {@link resolveWriteRoots}), threaded through from `ctx.writeRoots`
 * (docs/unified-write-boundary.md) so a shell write into a configured root
 * is allowed by the same set the file tools consult.
 */
export function sandboxPrefix(
  command: string,
  cwd: string,
  trustedRoot: string,
  level: ProfileLevel | undefined,
  writeRoots?: string[],
  sessionTempDir?: string,
): SandboxSpawn | null {
  if (!isSandboxedLevel(level)) return null; // macOS-only; startup notice from the loader
  return {
    file: SANDBOX_EXEC,
    args: [
      "-p",
      buildSeatbeltProfile(
        level,
        seatbeltWorkspaceRoot(trustedRoot),
        level === "workspace-write" ? resolveWriteRoots(level, seatbeltWorkspaceRoot(trustedRoot), writeRoots, sessionTempDir) : undefined,
      ),
      "/bin/sh",
      "-c",
      command,
    ],
  };
}
