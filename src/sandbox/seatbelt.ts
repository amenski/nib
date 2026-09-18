import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { ProfileLevel } from "../permissions/index.js";
import { realpathNearestAncestor, resolveWriteRoots } from "./write-roots.js";

/**
 * macOS Seatbelt (sandbox-exec) profile generation — the *mechanical* layer
 * under the PermissionProfile policy (permission-profile.md §8, phase (e)).
 *
 * The policy layer (ProfileEvaluator, src/permissions/profile.ts) decides
 * allow/deny per call; the Seatbelt layer makes the level's defaults hold in
 * the OS for bash children: strict-sandbox = read-only fs + no network,
 * workspace-write = write only workspace roots + no direct network, with
 * deliberate, battery-proven carve-outs to the write boundary. Which
 * carve-outs are emitted depends on the caller: a launch that supplies a
 * session temp dir (what every production launch does — see
 * src/exec-runner.ts) gets the workspace root plus that private directory
 * and nothing else, while the fallback in write-roots.ts's
 * `workspaceWriteCarveoutRoots` additionally emits literal /tmp, the host
 * $TMPDIR, and ~/.npm. Measured 2026-09-16 by diffing the generated
 * profiles of the two forms. The .git always-denied set is expressed
 * here as well ({@link GIT_INTEGRITY_DENIES}): the policy layer denies
 * `.git/**` for the calls it sees, but an interpreter or package script is
 * not a call it sees, and the release-gate probe measured both writing
 * `.git/hooks`.
 *
 * Seatbelt cannot safely enforce hostname allowlists because it filters
 * resolved IPs, not hostnames. Therefore workspace-write denies direct
 * egress by default; a future network broker must provide any scoped
 * exception rather than granting arbitrary child processes the network.
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
  // `file-read-metadata` (stat/lstat/getattr) is allowed everywhere, and the
  // child read boundary below subtracts from `file-read*`/`file-read-data`.
  // This split is load-bearing, not incidental: path resolution and Node's
  // module resolution walk *parent* components and lstat them, so denying
  // metadata for $HOME makes `node node_modules/...` and even `ls -la` die
  // with EPERM ("lstat '/Users/<user>': operation not permitted") — measured
  // 2026-09-16. Metadata is not content, and readdir stays denied (it is
  // file-read-data on the directory), so names/existence leak but contents
  // and listings do not.
  "(allow file-read-metadata)",
];

/**
 * The one deliberate hole in the child read boundary: narrow `$HOME`
 * subpaths a child may still read, because Git and npm cannot run without
 * them. Git reads its config to resolve identity and includes; npm reads its
 * cache during install (npm also *writes* that cache, but only in a launch
 * that passes no session temp dir — production redirects the cache into the
 * session directory instead, so `~/.npm` is a read re-allow and not a
 * production write root).
 *
 * Everything else under `$HOME` is unreadable to a sandboxed child:
 * credentials, SSH/GPG material, browser data, shell startup files, and —
 * the case the release gate actually failed on — *sibling project
 * directories*. Keep this list tiny; each entry is a confidentiality
 * exception and needs evidence that a real workflow requires it.
 */
const HOME_READ_ALLOWS = [".gitconfig", ".config/git", ".npm", ".cache"] as const;

/**
 * Git integrity rules — the mechanical half of the `.git` always-denied set.
 *
 * permission-profile.md §8 recorded this as a policy-layer-only residual: the
 * policy denies `.git/**` for the calls it sees, but an interpreter or a
 * package lifecycle script is not a call it sees. The release-gate probe
 * confirmed a Node child *and* an npm lifecycle script could each write
 * `.git/hooks` (2026-09-16). A hook runs on the next Git operation, so that
 * is a persistence escape, not only a confidentiality one.
 *
 * Denied: hook files (arbitrary code execution), `config` (remote
 * retargeting, and `credential.helper` / `core.hooksPath` injection), and
 * `credentials` (the store-fill target). Deliberately *not* denied: the
 * index, objects, refs, HEAD, and logs, so `add` / `commit` / `stash` /
 * `branch` / `tag` / `checkout` / `worktree` need no exception at all.
 *
 * The `(/.*)?` hop between `.git` and the leaf is load-bearing, not
 * stylistic. A submodule's gitdir lives at `.git/modules/<name>/` with its
 * own `hooks/` and `config`; a regex anchored on a literal `.git/hooks/` was
 * measured to miss both, leaving the escape open one level down. Linked
 * worktrees add no case of their own — `.git/worktrees/<name>/` holds no
 * hooks or config (the common dir does), so the same rule already covers it.
 *
 * Ordering is deliberate throughout: SBPL is last-matching-rule-wins, so
 * these lines must follow the write-root grants in
 * {@link buildSeatbeltProfile}, and the `.sample` allow must follow the
 * hooks deny. The allow exists because `git init` lays down the hook
 * templates, so denying every file under `hooks/` would break repository
 * creation for no security gain — a `.sample` file is never executed.
 *
 * A regex, not a fixed `<root>/.git` path, is required: nested repositories
 * and submodules live at arbitrary depth under any write root.
 *
 * The `hooks$` rule denies the hooks *directory node* as well as its files,
 * which is what stops the obvious end run: rename `.git/hooks` aside and
 * point a fresh `.git/hooks` symlink at a directory the child may write. The
 * regex matches the resolved path, so a hook written through such a symlink
 * would land at an ordinary workspace path and be permitted — measured
 * (2026-09-16). Denying the node closes the vector, because the child can no
 * longer create, rename, or remove anything named `.git/hooks`.
 *
 * Residual, not closed by path rules: a repository whose `.git/hooks` is
 * *already* a symlink to a directory outside `.git` (a shape a user can
 * create deliberately) still resolves hook writes to ordinary paths. Git
 * follows that link, so no path-based rule can distinguish it. Recorded in
 * docs/security-architecture-plan.md rather than claimed closed.
 *
 * Measured 2026-09-16 against this profile: Node, npm-script, and shell
 * redirects into hooks / config / credentials are all denied, including
 * through a nested repository and a submodule gitdir, while the ordinary Git
 * workflow battery still passes in full.
 */
const GIT_INTEGRITY_DENIES = [
  `(deny file-write* (regex "^.*/\\.git(/.*)?/hooks$"))`,
  `(deny file-write* (regex "^.*/\\.git(/.*)?/hooks/[^/]+$"))`,
  `(allow file-write* (regex "^.*/\\.git(/.*)?/hooks/[^/]+\\.sample$"))`,
  `(deny file-write* (regex "^.*/\\.git(/.*)?/config(\\.lock)?$"))`,
  `(deny file-write* (regex "^.*/\\.git(/.*)?/credentials$"))`,
];

/**
 * The approved-operation variant (release gate 2, trusted half): the narrow
 * route back for the five repository-creation/wiring workflows
 * {@link GIT_INTEGRITY_DENIES} breaks — all of which write `.git/config`.
 *
 * Reached only through an explicit one-time user approval of *that specific
 * command*: `ToolExecOptions.approvedGitConfigWrite`, set in agent.ts's ask
 * branch when `askUser` returned a plain `true` (never on auto-approve
 * posture, never on a persisted rule — see the field's doc comment), and
 * only for commands `isGitConfigOperation` accepts.
 *
 * Scope is the workspace root alone, deliberately — not the whole
 * `resolveWriteRoots` set. Measured consequence: an approved `git config`
 * still fails when it targets a repository under a configured external
 * write root, which is the fail-closed direction and is recorded in
 * docs/security-architecture-plan.md rather than widened away.
 *
 * Two allows, in this order, and both after the denies above:
 *   - `config` (and its `config.lock`) at any depth under the workspace, so
 *     `init`, `clone`, `remote add`, and `config <name> <value>` can write.
 *   - the `hooks` *directory node*, which `git init` must create to lay down
 *     its `.sample` templates. Hook *files* stay denied: the deny above is
 *     `hooks/[^/]+$` and this allow matches only the directory, so an
 *     approved `git init` cannot be turned into a hook write.
 *
 * `credentials` is not re-allowed, and neither is anything outside the
 * workspace.
 */
function gitConfigTrustedAllows(workspaceRoot: string): string[] {
  const ws = sbplQuote(regexQuote(workspaceRoot));
  return [
    `(allow file-write* (regex "^${ws}/(.*/)?\\.git(/.*)?/config(\\.lock)?$"))`,
    `(allow file-write* (regex "^${ws}/(.*/)?\\.git(/.*)?/hooks$"))`,
  ];
}

/**
 * Whether `$HOME` is a safe thing to subtract from `(allow file-read*)`.
 * A root of `/` (or an unset/garbage home) would make the deny rule swallow
 * the entire filesystem, including the toolchain and the workspace, so the
 * boundary is skipped entirely rather than emitted in a form that breaks
 * every command. Skipping is the honest degradation: no containment is
 * claimed for that session, matching the "sandbox unavailable" posture.
 */
function isUsableHomeDeny(home: string): boolean {
  return home.startsWith("/") && home !== "/" && home.split("/").length > 2;
}

/** Escapes a path for embedding in an SBPL double-quoted string. */
function sbplQuote(path: string): string {
  return path.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Escapes a path for use as a literal inside an SBPL `(regex "…")` pattern.
 * Applied *before* {@link sbplQuote}: the regex engine sees the decoded
 * string, so metacharacters in a workspace path must already be escaped by
 * the time the SBPL string is decoded — a workspace under a directory named
 * `foo+bar` or `a.b` must not match its neighbours.
 */
function regexQuote(path: string): string {
  return path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
  allowGitConfigWrite?: boolean,
): string {
  // The level's authorized write-set: empty for strict-sandbox, the shared
  // resolveWriteRoots set for workspace-write. The read boundary re-allows
  // reads for exactly this set, so the two layers stay in agreement about
  // which roots are "authorized" and strict-sandbox still ignores configured
  // writeRoots entirely (test: "emits no allow line even when a writeRoot is
  // configured").
  const roots = level === "workspace-write" ? (writeRoots ?? resolveWriteRoots(level, trustedRoot)) : [];
  const lines = ["(version 1)", "(deny default)", ...READ_ONLY_CORE];
  lines.push(...readBoundaryLines(trustedRoot, roots));
  for (const root of roots) {
    lines.push(`(allow file-write* (subpath "${sbplQuote(root)}"))`);
  }
  // Git integrity last: last-matching-rule-wins means a deny only bites if it
  // follows the write-root grants above.
  lines.push(...GIT_INTEGRITY_DENIES);
  // The approved-operation variant must follow those denies to take effect.
  // workspace-write only: emitting it under strict-sandbox would widen a
  // read-only level into "may write .git/config", which is a different
  // level's contract, not this one's.
  if (allowGitConfigWrite && level === "workspace-write") {
    lines.push(...gitConfigTrustedAllows(trustedRoot));
  }
  return lines.join("\n");
}

/**
 * The child read boundary — SBPL's last-matching-rule-wins makes this an
 * ordering problem, so the sequence is deliberate:
 *
 *   1. `(allow file-read*)`      (in READ_ONLY_CORE) — toolchain + system work
 *   2. `(deny  file-read* $HOME)` — subtracts the whole home directory
 *   3. `(allow file-read* ...)`   — re-allows the workspace (which normally
 *                                   *lives under* $HOME) and the narrow
 *                                   {@link HOME_READ_ALLOWS} entries
 *
 * Emitted only when {@link isUsableHomeDeny} says `$HOME` is a real path.
 *
 * Scope note: this is a `$HOME`-shaped boundary, not a general filesystem
 * allowlist. Reads outside `$HOME` (system paths, temp, other volumes) stay
 * broad on purpose — enumerating every read root a macOS toolchain needs was
 * attempted and abandoned on 2026-09-16 because the profile aborts before
 * exec (the dyld shared cache alone lives on a separate volume). Residual
 * risks of the home-shaped boundary are recorded in
 * docs/security-architecture-plan.md: other-user homes under `/Users` are not
 * covered, and metadata/existence outside $HOME is readable.
 */
function readBoundaryLines(trustedRoot: string, authorizedRoots: string[]): string[] {
  const home = realpathNearestAncestor(homedir());
  if (!isUsableHomeDeny(home)) return [];
  const lines = [`(deny file-read* (subpath "${sbplQuote(home)}"))`];
  const seen = new Set<string>();
  const allowRead = (path: string) => {
    // Resolve the exact path, and skip an entry that does not exist. Using
    // nearest-existing-ancestor resolution here would be a boundary bypass:
    // an absent `~/.cache` resolves to `$HOME` and would emit an allow for
    // the whole home directory *after* the deny above, and last-matching-
    // rule-wins means that silently re-opens the entire read boundary. A
    // path that does not exist needs no read grant, so skipping is both
    // safer and sufficient.
    let real: string;
    try {
      real = realpathSync(path);
    } catch {
      return;
    }
    if (seen.has(real)) return;
    seen.add(real);
    lines.push(`(allow file-read* (subpath "${sbplQuote(real)}"))`);
  };
  // The workspace must stay readable even though it normally sits under
  // $HOME; so must any root the user explicitly authorized (a second project
  // added via sandbox.writeRoots), matching the shared write-boundary set.
  allowRead(trustedRoot);
  for (const root of authorizedRoots) allowRead(root);
  for (const name of HOME_READ_ALLOWS) allowRead(join(home, name));
  return lines;
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
 *
 * `allowGitConfigWrite` is the approved-operation grant (release gate 2) —
 * see {@link gitConfigTrustedAllows}. It widens this one spawn's profile;
 * nothing about it persists.
 */
export function sandboxPrefix(
  command: string,
  cwd: string,
  trustedRoot: string,
  level: ProfileLevel | undefined,
  writeRoots?: string[],
  sessionTempDir?: string,
  allowGitConfigWrite?: boolean,
): SandboxSpawn | null {
  if (!isSandboxedLevel(level)) return null; // macOS-only; startup notice from the loader
  return {
    file: SANDBOX_EXEC,
    args: [
      "-p",
      buildSandboxProfile(level, trustedRoot, writeRoots, sessionTempDir, allowGitConfigWrite),
      "/bin/sh",
      "-c",
      command,
    ],
  };
}

/**
 * The profile text for a launch — the single expression of "which profile does
 * this launch get". {@link sandboxPrefix} and the session-grant envelope hash
 * both derive from it, so the bytes a grant was approved against are the bytes
 * Seatbelt is handed. A second, hand-maintained description of the envelope is
 * exactly what this avoids (docs/permission-ux-redesign.md).
 *
 * Takes an already-narrowed {@link SandboxLevel}: the `ProfileLevel | undefined`
 * shape belongs to {@link sandboxPrefix}, which gates on
 * {@link isSandboxedLevel} before calling here.
 *
 * The root is resolved once and used for both the read boundary and the
 * write-set computation, so the two cannot disagree about which directory they
 * describe.
 */
export function buildSandboxProfile(
  level: SandboxLevel,
  trustedRoot: string,
  writeRoots?: string[],
  sessionTempDir?: string,
  allowGitConfigWrite?: boolean,
): string {
  return buildSeatbeltProfile(
    level,
    seatbeltWorkspaceRoot(trustedRoot),
    profileWriteSet(level, trustedRoot, writeRoots, sessionTempDir),
    allowGitConfigWrite,
  );
}

/**
 * The write-set this level's profile actually grants, in the exact bytes
 * {@link buildSandboxProfile} hands Seatbelt — the workspace root, the session
 * scratch directory or the shared carve-outs when there is none, and the
 * configured roots, all realpath-resolved, deduplicated and in the profile's
 * order. Empty for `strict-sandbox`, which grants no writes at all.
 *
 * Exported for the session-grant consent text: the user is approving a profile,
 * so the limits the prompt states must be this list and not the requested one
 * (docs/permission-ux-redesign.md).
 */
export function profileWriteSet(
  level: SandboxLevel,
  trustedRoot: string,
  writeRoots?: string[],
  sessionTempDir?: string,
): string[] {
  if (level !== "workspace-write") return [];
  return resolveWriteRoots(level, seatbeltWorkspaceRoot(trustedRoot), writeRoots, sessionTempDir);
}

/**
 * The session-grant envelope key for a profile: sha256 of the exact profile
 * text passed to the spawn.
 *
 * Hashing the text rather than enumerating envelope fields is deliberate. The
 * write-set is computed per launch, so two launches of the same level can
 * produce different profiles, and an enumerated field list can disagree with
 * what Seatbelt was actually handed. Keying on the real bytes means a newly
 * added profile rule — or a changed write root, workspace, or network policy —
 * changes the hash and invalidates a stale grant with no extra bookkeeping.
 */
export function sandboxEnvelopeHash(profile: string): string {
  return createHash("sha256").update(profile).digest("hex");
}
