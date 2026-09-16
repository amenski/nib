import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { PermissionEngine, ResolveResult } from "./engine.js";
import { extractHostname } from "./rules.js";
import { isPathWithinWriteRoots, resolveWriteRoots } from "../sandbox/write-roots.js";
import { realpathNearestAncestor } from "../sandbox/write-roots.js";
import { PROJECT_DIR_NAME, STATE_DIR_NAME } from "../config/paths.js";
import { extractApplyPatchPlan } from "./capabilities.js";

/**
 * PermissionProfile — the capability-boundary layer (docs/permission-profile.md §3).
 *
 * One coarse, absolute gate in front of the rule engine: the profile says
 * what the agent may *reach at all* (path globs, network domains); the rule
 * engine says which of those touches are polite enough to run silently vs.
 * need a human nod. Evaluation order (decision L, §4): profile first →
 * rules → posture. A profile deny is terminal — it never reaches a prompt,
 * and nothing in layers 2–3 can rescue it.
 *
 * Absent `permissionProfile` config the caller simply doesn't construct a
 * gate: `authorize(call, engine)` with no profile runs the engine alone,
 * which is today's behavior byte-for-byte (§9). An explicitly-constructed
 * evaluator (level present) applies the always-denied set even at
 * `unrestricted` — `.git/` and the profile file itself are denied at every
 * level, as in Codex (§3).
 */

export type ProfileLevel = "strict-sandbox" | "workspace-write" | "unrestricted";
export type FsAction = "deny" | "read" | "write";

export interface PermissionProfileFsRule {
  /** gitignore-style glob; workspace-relative, "~"-home-relative, or absolute. */
  path: string;
  /** "write" implies "read" (permission-profile.md §3). */
  action: FsAction;
}

export interface PermissionProfileNetwork {
  /** Hostnames (exact, case-insensitive) or "*" (any host). */
  allow?: string[];
  deny?: string[];
}

export interface PermissionProfileConfig {
  level: ProfileLevel;
  fs?: PermissionProfileFsRule[];
  network?: PermissionProfileNetwork;
}

export type ProfileDecision = "allow" | "deny";

/**
 * Tools the profile gates per the §7 enforcement map: file-targeting tools
 * resolve to a read or write action; web tools resolve to the network rules.
 * Mirrors PermissionEngine's READ_TOOLS/WRITE_TOOLS (engine.ts) plus the
 * "search" read tool; everything else (run_bash, mcp__*, …) passes through —
 * bash's fs side effects and egress are rule-engine-governed (§7, honest
 * limitation).
 */
const READ_TOOLS = new Set(["read_file", "list_files", "glob", "search"]);
const WRITE_TOOLS = new Set([
  "edit", "edit_file", "write_to_file", "search_replace", "apply_diff", "apply_patch",
]);

/**
 * Compiles an fs rule glob. Throws on patterns that can't mean what the
 * loader/evaluator supports: empty, or a "[" character class (this matcher
 * supports `*`, `?`, `**` only). The loader wraps this in try/catch so an
 * invalid pattern is a fail-fast config error naming the fs entry.
 *
 * Addressing follows the canonical path forms produced by canonicalizePath:
 * workspace-relative patterns (e.g. "src/**", "./src/**") match the "./rel"
 * form (the optional "./" prefix is tolerated); "~"-relative and absolute
 * patterns match their own forms and never cross into another addressing
 * space (a workspace pattern can't reach "~/x", an absolute one can't match
 * "./rel").
 */
export function compileGlob(pattern: string): RegExp {
  if (pattern === "") throw new Error("empty pattern");
  if (pattern.includes("[")) {
    throw new Error("character classes are not supported (use *, ?, **)");
  }
  const anchored = pattern.startsWith("~") || pattern.startsWith("/");
  const core = anchored ? pattern : pattern.startsWith("./") ? pattern.slice(2) : pattern;
  const segs = core.split("/");
  const parts = segs.map((seg) => {
    if (seg === "**") return "__DOUBLESTAR__";
    let out = "";
    for (const ch of seg) {
      if (ch === "*") out += "[^/]*";
      else if (ch === "?") out += "[^/]";
      else out += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
    return out;
  });
  let src = parts.join("/").replace(/__DOUBLESTAR__/g, ".*");
  if (!anchored) src = `(?:\\./)?${src}`;
  return new RegExp(`^${src}$`);
}

/**
 * Canonical form a fs rule glob is matched against (engine.ts normalizes
 * paths the same way for rule subjects, extended with a home space):
 *   inside cwd       → "./rel"     (workspace-relative addressing)
 *   inside home      → "~/rel"     (home-relative addressing)
 *   anywhere else    → absolute
 * A leading "~" in the raw path is expanded (and never appears in output,
 * so "~/…" in output always means "under the home dir"). `..` never appears:
 * paths are resolved before comparing, which also means a pattern containing
 * ".." simply never matches (allowed for deny/read rules, harmless).
 */
function canonicalizePath(raw: string, cwd: string, home: string): string {
  const expanded =
    raw === "~" ? home : raw.startsWith("~/") ? join(home, raw.slice(2)) : raw;
  const abs = isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
  const rel = relative(cwd, abs);
  if (rel === "") return "./";
  if (!rel.startsWith("..")) return `./${rel}`;
  const relHome = relative(home, abs);
  if (relHome === "") return "~/";
  if (!relHome.startsWith("..")) return `~/${relHome}`;
  return abs;
}

/**
 * Always-denied by construction (§3): any path under a `.git` directory
 * (any depth), and the profile file itself — the project copy and the global
 * copy under the state dir. No explicit rule can rescue these: the check runs
 * before rule matching at every level.
 *
 * Both names are matched explicitly rather than assuming they stay equal. This
 * is the only guard on the file that carries `permissions.rules`; if one name
 * changes and this line still tested the other, writes to the real file would
 * silently drop out of the deny set — a fail-open with no visible error.
 */
function isAlwaysDenied(canonical: string): boolean {
  if (canonical.split("/").includes(".git")) return true;
  return (
    canonical.endsWith(`/${PROJECT_DIR_NAME}/settings.json`) ||
    canonical.endsWith(`/${STATE_DIR_NAME}/settings.json`)
  );
}

function isAccountCredentialStore(canonical: string): boolean {
  return canonical === "~/.netrc" || canonical === "~/.git-credentials" || canonical === "~/.npmrc" ||
    canonical === `~/${STATE_DIR_NAME}/credentials.yaml` ||
    ["~/.ssh", "~/.aws", "~/.gnupg", "~/.azure", "~/.kube", "~/.config/gcloud", "~/.config/gh", "~/Library/Keychains"]
      .some((root) => canonical === root || canonical.startsWith(`${root}/`)) ||
    canonical === "~/.docker/config.json";
}

/** Network entry matching: "*" matches any host; otherwise exact, case-insensitive. */
function matchesNetworkEntry(entry: string, hostname: string): boolean {
  if (entry === "*") return true;
  return entry === hostname; // both lowercased at construction / by extractHostname
}

/**
 * Layer-1 gate. `decide` returns "deny" (terminal) or "allow" (pass through
 * to layer 2). "allow" never means "granted" — the rule engine still decides
 * ask vs. allow (§4, deny-absolute proof: layer 1 has no ask, so nothing a
 * profile allows bypasses layer 2).
 */
export class ProfileEvaluator {
  readonly level: ProfileLevel;
  private readonly cwd: string;
  private readonly home: string;
  /**
   * The built-in search tool's egress host. web_search takes no host
   * argument, so the profile's network rules are evaluated against the
   * pinned host (web-search-spec.md §2: www.bing.com is the sole search
   * host). Overridable for tests / a future second host.
   */
  private readonly searchHost: string;
  private readonly fsRules: { pattern: string; action: FsAction; re: RegExp }[];
  private readonly networkAllow: string[];
  private readonly networkDeny: string[];
  /**
   * The shared workspace-write write-set (docs/unified-write-boundary.md §1):
   * the same {@link resolveWriteRoots} set the Seatbelt layer emits allow-lines
   * from, so a path either layer allows for a write is allowed by the other.
   * Consulted by {@link editTargetInWriteSet} (the engine enforces the
   * boundary itself with its own copy of the same set). Only meaningful at
   * `workspace-write` (strict-sandbox has no write-set; unrestricted imposes
   * no boundary). Resolved once at construction — the workspace root,
   * carve-outs, and configured writeRoots are session-stable.
   */
  private readonly writeSet: string[];

  constructor(
    config?: PermissionProfileConfig,
    cwd?: string,
    opts?: { searchHost?: string; writeRoots?: string[] },
  ) {
    this.level = config?.level ?? "unrestricted";
    this.cwd = cwd ?? process.cwd();
    this.home = homedir();
    this.searchHost = opts?.searchHost ?? "www.bing.com";
    this.fsRules = (config?.fs ?? []).map((r) => ({
      pattern: r.path,
      action: r.action,
      re: compileGlob(r.path),
    }));
    this.networkAllow = (config?.network?.allow ?? []).map((e) => e.toLowerCase());
    this.networkDeny = (config?.network?.deny ?? []).map((e) => e.toLowerCase());
    this.writeSet =
      this.level === "workspace-write"
        ? resolveWriteRoots("workspace-write", this.cwd, opts?.writeRoots)
        : [];
  }

  decide(
    tool: string,
    input: Record<string, unknown>,
    cwd: string = this.cwd,
  ): ProfileDecision {
    if (tool === "apply_patch") {
      const plan = extractApplyPatchPlan(input, cwd, { level: this.level, roots: this.writeSet });
      if (plan.status !== "known" || plan.tool !== "apply_patch" || !("targets" in plan)) return "deny";
      return plan.targets.some((target) =>
        this.decideFs(canonicalizePath(target.path, cwd, this.home), "write") === "deny",
      ) ? "deny" : "allow";
    }
    if (READ_TOOLS.has(tool) || WRITE_TOOLS.has(tool)) {
      const raw = input.path ?? input.filePath;
      if (typeof raw !== "string" || raw === "") return "allow"; // no path to gate
      return this.decideFs(
        canonicalizePath(raw, cwd, this.home),
        READ_TOOLS.has(tool) ? "read" : "write",
      );
    }
    if (tool === "web_fetch") {
      return this.decideNetwork(extractHostname(String(input.url ?? "")));
    }
    if (tool === "web_search") {
      return this.decideNetwork(this.searchHost);
    }
    // Everything else is not profile-gated (§7).
    return "allow";
  }

  private decideFs(canonical: string, requested: "read" | "write"): ProfileDecision {
    const physical = canonicalizePath(realpathNearestAncestor(this.canonicalToAbsolute(canonical)), this.cwd, this.home);
    if (isAlwaysDenied(canonical) || isAlwaysDenied(physical) || isAccountCredentialStore(physical)) return "deny";
    const rule = this.fsRules.find((r) => r.re.test(canonical));
    if (rule && rule.action === "deny") return "deny";
    // A matched read/write rule can only grant within the level's allowance,
    // which the level default already permits — so it never widens anything
    // (rules narrow only, §3) and the level default decides. The rules that
    // act are deny rules plus the level defaults.
    if (requested === "write") {
      return this.levelAllowsWrite(canonical) ? "allow" : "deny";
    }
    return "allow"; // every level permits reads anywhere (§3 table)
  }

  /**
   * §3 level table: write allowance per level. `workspace-write` returns
   * true unconditionally — the level's write BOUNDARY is no longer enforced
   * here (docs/unified-write-boundary.md §2): out-of-set file writes pass
   * through layer 1 so the rule engine resolves them to a guarded ask
   * instead of a terminal deny (the Seatbelt layer still kernel-denies the
   * same paths for shell writes). strict-sandbox stays read-only;
   * unrestricted imposes no boundary.
   */
  private levelAllowsWrite(canonical: string): boolean {
    switch (this.level) {
      case "strict-sandbox":
        return false;
      case "workspace-write":
        return true;
      case "unrestricted":
        return true;
    }
  }

  /**
   * Reconstructs the absolute path a canonical subject form denotes, so the
   * realpath-based containment check has a physical target to resolve:
   *   "./rel"  → cwd/rel    (workspace-relative addressing)
   *   "~/rel"  → home/rel   (home-relative addressing)
   *   anything else is already absolute.
   */
  private canonicalToAbsolute(canonical: string): string {
    if (canonical.startsWith("./")) return resolve(this.cwd, canonical.slice(2));
    if (canonical.startsWith("~/")) return join(this.home, canonical.slice(2));
    return canonical;
  }

  /**
   * Consolidation M.1 (permission-profile.md §5): whether an edit-group
   * tool call's write target is inside the profile's effective write-set.
   * This is the old `isEditToolInWorkspace` containment check (security-
   * spec D1), now the shared write-set: `workspace-write`'s boundary is the
   * resolveWriteRoots set (workspace + carve-outs + global writeRoots,
   * realpath-checked), `unrestricted` covers any path, and `strict-sandbox`
   * has no write-set (always false). Explicit fs deny rules and the
   * always-denied set also exclude the target. The approval overlay
   * (App.tsx) consults this as its edit-in-workspace condition. It answers
   * "inside the write-set" (where the engine writes silently) — an
   * out-of-set target is NOT denied here, it becomes a guarded ask in the
   * engine (docs/unified-write-boundary.md §2).
   */
  editTargetInWriteSet(tool: string, input: Record<string, unknown>): boolean {
    if (!WRITE_TOOLS.has(tool)) return false;
    const raw = input.path ?? input.filePath;
    if (typeof raw !== "string" || raw === "") return false;
    const canonical = canonicalizePath(raw, this.cwd, this.home);
    if (isAlwaysDenied(canonical)) return false;
    const rule = this.fsRules.find((r) => r.re.test(canonical));
    if (rule && rule.action === "deny") return false;
    switch (this.level) {
      case "strict-sandbox":
        return false;
      case "unrestricted":
        return true;
      case "workspace-write":
        return isPathWithinWriteRoots(this.canonicalToAbsolute(canonical), this.writeSet);
    }
  }

  private decideNetwork(hostname: string | undefined): ProfileDecision {
    // Unparsable URL → nothing to match; the level default applies
    // (fail-closed at every level below unrestricted).
    if (!hostname) return this.level === "unrestricted" ? "allow" : "deny";
    // Most specific matching entry wins; a tie (the same host in both lists)
    // goes to deny — rules narrow only (§3). "*" is the least specific
    // entry, so a specific allow carves the allowlist out of a "*" deny
    // (the §3 example's `deny: ["*"]` allowlist mode).
    const allowMatch = this.networkAllow.find((e) => matchesNetworkEntry(e, hostname));
    const denyMatch = this.networkDeny.find((e) => matchesNetworkEntry(e, hostname));
    const allowSpecificity = allowMatch === undefined ? -1 : allowMatch === "*" ? 0 : 1;
    const denySpecificity = denyMatch === undefined ? -1 : denyMatch === "*" ? 0 : 1;
    if (denySpecificity > allowSpecificity) return "deny";
    if (denyMatch !== undefined && denySpecificity === allowSpecificity) return "deny";
    if (allowMatch !== undefined) {
      // A specific allow beating a wildcard deny is honored only at
      // workspace-write, where the level default is deny and the allowlist
      // is the grant mechanism (§3 table). Under strict-sandbox it is inert
      // (the level denies all network; rules narrow only); under
      // unrestricted the default already allows.
      return this.level === "strict-sandbox" ? "deny" : "allow";
    }
    return this.level === "unrestricted" ? "allow" : "deny";
  }
}

// ── Composition: profile-gate → rules → posture (§4, decision L) ──

export interface AuthorizeCall {
  tool: string;
  arguments: Record<string, unknown>;
}

export interface AuthorizeResult extends ResolveResult {
  /**
   * "deny-by-profile" when the profile gate (layer 1) denied the call before
   * rule resolution — the terminal audit marker (permission-spec.md §11).
   * Absent on every other path; the engine result is otherwise unchanged.
   */
  reason?: "deny-by-profile";
}

/**
 * The one composed permission surface: profile first (deny ⇒ done, silent,
 * audit row "deny-by-profile"), then the unchanged rule engine. No profile
 * (feature off, §9) → layer 1 is skipped entirely and the engine result is
 * returned as-is — today's behavior byte-for-byte.
 */
export function authorize(
  call: AuthorizeCall,
  engine: PermissionEngine,
  profile?: ProfileEvaluator,
): AuthorizeResult {
  if (profile && profile.decide(call.tool, call.arguments) === "deny") {
    return {
      action: "deny",
      winningRule: undefined,
      wasUnresolved: false,
      isGuarded: false,
      reason: "deny-by-profile",
    };
  }
  return { ...engine.resolve(call.tool, call.arguments) };
}
