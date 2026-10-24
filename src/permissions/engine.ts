import { join, relative, isAbsolute, resolve, dirname, basename } from "node:path";
import { existsSync, readFileSync, renameSync, statSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import type { PermissionAction, PermissionRule, PermissionSubject } from "./rules.js";
import { buildSubject, patternMatches, specificity, serializeRulePattern, extractHostname, extractToolSubject } from "./rules.js";
import { buildBashApprovalPattern, buildBashSubject } from "./bash-normalize.js";
import { BUILTIN_DESTRUCTIVE_RULES } from "./destructive.js";
import { BUILTIN_GUARDED_RULES } from "./guarded.js";
import { BUILTIN_ALLOW_RULES } from "./builtin-allow.js";
import { isPathWithinWriteRoots, resolveWriteRoots } from "../sandbox/write-roots.js";
import { classifyImageSource } from "../image-source.js";
import { projectDirPath } from "../config/paths.js";
import { extractApplyPatchPlan } from "./capabilities.js";
import type { ProfileLevel } from "./profile.js";
import { ensurePrivateDirectory, writePrivateFileSync } from "../config/state-permissions.js";

export type { PermissionAction, PermissionRule, PatternKind, RuleOrigin } from "./rules.js";

export interface PermissionConfig {
  rules?: PermissionRule[];
  defaultMode?: "allowAll" | "askAll";
}

export interface ResolveResult {
  action: PermissionAction;
  winningRule?: PermissionRule;
  /** True when any bash segment couldn't be safely classified — see bash-normalize.ts. Never bypassable by the auto posture. */
  wasUnresolved: boolean;
  /** True when the winning rule is origin "builtin-guarded" (secret-adjacent path). Never bypassable by the auto posture, same as wasUnresolved. */
  isGuarded: boolean;
}

/** Internal shape used by the private resolution helpers, before isGuarded is derived at the resolve() boundary. */
type InternalResolveResult = Omit<ResolveResult, "isGuarded">;

/** True when `path` is `dir` itself or sits under it (both absolute, lexical). */
function pathWithin(dir: string, path: string): boolean {
  const rel = relative(dir, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** True when `dir` is `home` itself or one of its ancestors. */
function atOrAbove(dir: string, home: string): boolean {
  return dir === home || pathWithin(dir, home);
}

interface OnDiskRule {
  tool: string;
  pattern: string;
  action: PermissionAction;
}

export class PermissionEngine {
  private configRules: PermissionRule[];
  private sessionRules: PermissionRule[] = [];
  private defaultMode: "allowAll" | "askAll";
  private workingDir: string;
  private projectConfigDir: string;
  /** True when the user has at least one MCP server configured. Not a rule — never persisted — just the signal that lets defaultMode: allowAll cover mcp__* tools without an explicit rule. */
  private hasMcpServersConfigured: boolean;
  /**
   * Whether the file-tool write boundary is active (docs/unified-write-
   * boundary.md §2): true when the permission profile level is
   * `workspace-write`. Deliberately NOT gated on sandbox.enabled — the
   * boundary follows the profile level (decision 2026-08-17). When active,
   * write/edit targets inside the shared write-set resolve silently (no
   * prompt); targets outside it resolve to a builtin-guarded ask. Under
   * strict-sandbox the profile layer denies all writes before the engine
   * runs; under unrestricted there is no boundary — neither sets this.
   */
  private readonly enforceWriteBoundary: boolean;
  /**
   * The shared workspace-write write-set (resolveWriteRoots,
   * docs/unified-write-boundary.md §1): workspace root + the battery-proven
   * carve-outs (/tmp, $TMPDIR, ~/.npm) + global sandbox.writeRoots,
   * realpath-resolved — the same set the Seatbelt layer emits allow-lines
   * from. Empty when the boundary is inactive.
   */
  private readonly writeSet: string[];
  private readonly writePolicyLevel: ProfileLevel;

  /**
   * Invoked with the settings path after a successful persist() write, so a
   * caller with access to the TOFU trust store (settings-trust.ts) can
   * re-record the hash of the file the engine itself just wrote — otherwise
   * every "always" approval hash-mismatches the trust store's stale entry and
   * the next launch treats its own project settings file as tampered. Kept
   * as an injected callback rather than a direct import to avoid an import
   * cycle (settings-trust.ts -> config/loader.ts -> permissions/index.js).
   */
  private readonly onPersist?: (settingsPath: string) => void;

  /** Tools whose exact/glob patterns carry file paths (normalized on load). */
  private static readonly FILE_TOOLS = new Set([
    "read_file", "write_to_file", "edit", "list_files", "glob", "search", "lsp",
  ]);

  /**
   * FILE_TOOLS whose subject is a directory to search/enumerate, not a
   * specific file — the out-of-workspace realpath containment check (see
   * resolveSubject) applies only to these. read_file/write_to_file/edit
   * already get equivalent protection today via BUILTIN_ALLOW_RULES' "./**"
   * fallback glob simply not matching an out-of-workspace absolute path
   * (falls through to defaultMode, which asks) — this set covers the tools
   * whose builtin allow is instead an unconditional kind:"any" (glob,
   * search), which that fallback mechanism can't gate by path at all.
   */
  private static readonly DIR_SCOPED_TOOLS = new Set(["search", "glob"]);

  /** Read-only file tools eligible for the "grant whole folder" broadening offer. */
  private static readonly READ_TOOLS = new Set([
    "read_file", "list_files", "glob", "search",
  ]);

  /**
   * READ_TOOLS whose subject IS a directory rather than a file inside one, so
   * the directory itself is the base of their scope. Narrower than
   * DIR_SCOPED_TOOLS above, which is a security set (the tools the
   * out-of-workspace containment check applies to) — list_files reads like a
   * file tool there (its builtin allow is the "./**" glob) but its subject is
   * a directory here.
   */
  private static readonly DIRECTORY_SUBJECT_TOOLS = new Set([
    "search", "glob", "list_files",
  ]);

  /**
   * Write/edit file tools eligible for the "grant whole folder" broadening
   * offer. A recursive write grant is materially riskier than a recursive
   * read grant (it lets the agent modify or overwrite anything under the
   * folder, not just see it), so this offer is gated more strictly than the
   * read one — see the hasSibling check in folderScopeRule.
   */
  private static readonly WRITE_TOOLS = new Set([
    "edit", "edit_file", "write_to_file", "search_replace", "apply_diff", "apply_patch",
  ]);

  constructor(
    config?: PermissionConfig,
    workingDir?: string,
    hasMcpServersConfigured?: boolean,
    opts?: { writeRoots?: string[]; sessionTempDir?: string; enforceWriteBoundary?: boolean; writePolicyLevel?: ProfileLevel; onPersist?: (settingsPath: string) => void },
  ) {
    this.workingDir = workingDir ?? process.cwd();
    this.configRules = (config?.rules ?? [])
      .filter((r) => !PermissionEngine.isEmptySubjectAllowRule(r))
      .map((r) => this.normalizeConfigRule(r));
    this.defaultMode = config?.defaultMode ?? "askAll";
    this.projectConfigDir = projectDirPath(this.workingDir);
    this.hasMcpServersConfigured = hasMcpServersConfigured ?? false;
    this.enforceWriteBoundary = opts?.enforceWriteBoundary ?? false;
    this.writePolicyLevel = opts?.writePolicyLevel ?? "workspace-write";
    this.onPersist = opts?.onPersist;
    this.writeSet = this.enforceWriteBoundary
      ? resolveWriteRoots("workspace-write", this.workingDir, opts?.writeRoots, opts?.sessionTempDir)
      : [];
  }

  /**
   * Normalize exact-match pattern paths in user-authored rules at load time so
   * they survive a change in path spelling. Does NOT touch glob patterns —
   * prepending "./" to a glob like "**" / "**\/*.ts" shifts its anchoring and
   * can break matching (e.g. "./**" won't match a top-level ".env" the way
   * "**" does). Also guards against the "undefined" string literal that
   * buildSubject produces for file tools called with neither path nor filePath.
   */
  private normalizeConfigRule(r: PermissionRule): PermissionRule {
    if (
      r.kind === "exact" &&
      PermissionEngine.FILE_TOOLS.has(r.tool) &&
      r.pattern &&
      r.pattern !== "undefined"
    ) {
      return { ...r, origin: "config" as const, pattern: this.normalizePath(r.pattern) };
    }
    return { ...r, origin: "config" as const };
  }

  /**
   * An empty non-`any` allow pattern is never a valid approval scope. It is
   * produced when a tool's effect lives in an argument the permission layer
   * did not extract (for example apply_patch.patch), and matches every
   * subject. `any` remains valid because it is an explicit catch-all rule.
   */
  private static isEmptySubjectAllowRule(rule: PermissionRule): boolean {
    return rule.action === "allow" && rule.kind !== "any" && rule.pattern.trim() === "";
  }

  /** Approval callers must use the canonical form buildDefaultRule produces. */
  private isInvalidApprovalRule(rule: PermissionRule): boolean {
    return PermissionEngine.isEmptySubjectAllowRule(rule) || (
      rule.kind === "exact" &&
      PermissionEngine.FILE_TOOLS.has(rule.tool) &&
      rule.pattern !== this.normalizePath(rule.pattern)
    );
  }

  /**
   * Resolves a tool call to an action. For run_bash, splits the command into
   * independent segments and resolves each against the same rule set,
   * combining via most-restrictive-wins: any deny -> deny; else any
   * unresolved-ask or ordinary ask -> ask; else allow.
   */
  resolve(toolName: string, args?: Record<string, unknown>): ResolveResult {
    const a = args ?? {};

    // A view_image call is hostname-scoped only when its target is remote; a
    // local file path must go through relativizeSubject like any other path
    // tool, or an in-workspace read would never match a "./**" rule.
    const usesDomainSubject =
      toolName === "web_fetch" ||
      (toolName === "view_image" && classifyImageSource(String(a.url ?? "")).kind === "remote");

    const internal = toolName === "run_bash" || toolName === "run_bash_background"
      ? this.resolveBash(toolName, String(a.command ?? ""))
      : toolName === "apply_patch"
        ? this.resolveApplyPatch(a)
      : usesDomainSubject
        ? this.resolveSubject(toolName, buildSubject(toolName, a))
        : this.resolveSubject(toolName, this.relativizeSubject(buildSubject(toolName, a)));

    return { ...internal, isGuarded: internal.winningRule?.origin === "builtin-guarded" };
  }

  /**
   * Rewrites a path subject's resolvedPath to be relative to workingDir
   * (e.g. "./src/main.ts") when the path is inside it, so glob rules like
   * "./**" (what migrateLegacyPermissions emits for the old read-in-cwd
   * scope) can actually match — tools always pass absolute paths, and a
   * relative glob pattern can never match one directly. Paths outside
   * workingDir are left as absolute, so they don't spuriously match a
   * "./**"-rooted rule; an absolute glob can still be authored to cover them.
   *
   * Relative paths are first resolved against workingDir so that different
   * spellings of the same path ("src/main.ts", "./src/main.ts") all collapse
   * to the same canonical form. Without this, an exact-match rule approved
   * for one spelling would prompt again for another — same file, different
   * string literal.
   */
  private relativizeSubject(subject: PermissionSubject): PermissionSubject {
    if (!subject.resolvedPath) return subject;

    const normalized = this.normalizePath(subject.resolvedPath);
    return { ...subject, resolvedPath: normalized };
  }

  /**
   * Canonicalize a path to the same form relativizeSubject uses:
   * - Inside workingDir → "./relative/path"
   * - Outside workingDir → absolute path
   */
  private normalizePath(raw: string): string {
    const absolute = isAbsolute(raw) ? raw : resolve(this.workingDir, raw);
    const rel = relative(this.workingDir, absolute);
    if (rel.startsWith("..")) return absolute;
    if (rel === "") return "./";
    return `./${rel}`;
  }

  /**
   * Realpath-resolves a path via its nearest existing ancestor: walk up to
   * the deepest existing component, resolve that with realpath, re-append
   * the missing tail. Same nearest-existing-ancestor pattern as
   * seatbeltWorkspaceRoot (src/sandbox/seatbelt.ts) — reused conceptually
   * rather than imported, since this module has no dependency on the
   * sandbox layer and the two resolve different kinds of paths (a spawn cwd
   * there vs. an arbitrary tool-call directory argument here). A symlink
   * inside workingDir pointing outside it resolves to its real, physical
   * target, so the containment check below can't be fooled by a symlink
   * escape. Falls back to the lexical absolute path when nothing on the
   * path exists (the call would fail on its own merits anyway).
   */
  private realpathNearestAncestor(path: string): string {
    let existing = path;
    const missing: string[] = [];
    while (!existsSync(existing)) {
      const parent = dirname(existing);
      if (parent === existing) return path;
      missing.unshift(basename(existing));
      existing = parent;
    }
    try {
      const real = realpathSync(existing);
      return missing.length ? join(real, ...missing) : real;
    } catch {
      return path;
    }
  }

  /**
   * Synthesizes a builtin-guarded "ask" rule when a directory-scoped tool's
   * (search, glob) subject resolves outside workingDir — realpath-resolved,
   * so a symlink inside the workspace pointing outside it is caught, not
   * just a lexically-out-of-tree path. Returns undefined for every other
   * case (in-workspace, non-dir-scoped tool, no resolvedPath), so it's a
   * pure no-op everywhere else.
   *
   * Why engine-level rather than a static rule: BUILTIN_GUARDED_RULES is a
   * fixed glob-pattern list, and "outside workingDir" is relative to a
   * per-instance, per-session boundary — no glob can express it. This is
   * the dynamic counterpart to what BUILTIN_ALLOW_RULES' "./**" pattern
   * already does implicitly for read_file/list_files (an absolute
   * out-of-tree path just never matches "./**", so those tools fall through
   * to defaultMode's "ask"). search/glob can't lean on that trick because
   * their builtin allow is an unconditional kind:"any" (matches every call
   * regardless of path) — this restores the same path-sensitivity for them
   * without loosening or duplicating the read_file mechanism.
   *
   * origin "builtin-guarded" so it flows through the exact same precedence
   * and posture-exemption path as a static guarded rule (see resolve()'s
   * isGuarded derivation and resolveTier) — a human always sees this,
   * regardless of posture or defaultMode: allowAll.
   */
  private outOfWorkspaceGuardedRule(toolName: string, subject: PermissionSubject): PermissionRule | undefined {
    if (!PermissionEngine.DIR_SCOPED_TOOLS.has(toolName)) return undefined;
    if (!subject.resolvedPath) return undefined;

    // subject.resolvedPath has already been through relativizeSubject:
    // "./rel" (lexically inside workingDir) or an absolute path (lexically
    // outside, or workingDir itself). Reconstruct the absolute lexical form
    // before realpath-resolving, since relativizeSubject's normalization is
    // lexical only (no filesystem access) and can't see a symlink escape.
    const lexicalAbsolute = subject.resolvedPath.startsWith("./")
      ? resolve(this.workingDir, subject.resolvedPath.slice(2))
      : resolve(this.workingDir, subject.resolvedPath);

    const realRoot = this.realpathNearestAncestor(resolve(this.workingDir));
    const realTarget = this.realpathNearestAncestor(lexicalAbsolute);
    const rel = relative(realRoot, realTarget);
    const isInside = rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
    if (isInside) return undefined;

    // The `externalRead` tag is what lets a human's approval of this call
    // broaden to the enclosing project (buildPathRule) instead of being
    // narrowed back to the one directory — see narrowToExact.
    return { tool: toolName, kind: "any", pattern: "", action: "ask", origin: "builtin-guarded", externalRead: true };
  }

  /**
   * The file-tool write boundary (docs/unified-write-boundary.md §2): a
   * write/edit tool whose target realpath-resolves INSIDE the shared
   * write-set is silently allowed (no prompt — the common in-workspace case
   * stays free, matching how reads work); a target OUTSIDE it is a
   * builtin-guarded "ask" — the same containment mechanism as search/glob,
   * so a human always sees it regardless of posture or defaultMode. A
   * path-scoped session/always approval may out-specify this dynamic guard
   * for that target only; the initial call still remains guarded. This is
   * the design's "outside → ask, not hard-deny": the Seatbelt layer still
   * kernel-denies the same out-of-set paths for shell writes, and the layers
   * agree on the ALLOW side — a path either layer allows for a write, the
   * other does too.
   *
   * Origin "config" for the in-set allow (a plain allow, same as
   * BUILTIN_ALLOW_RULES — an explicit user deny/ask rule out-specifies it);
   * origin "builtin-guarded" for the out-of-set ask (same precedence and
   * posture-exemption path as a static guarded rule). Returns undefined when
   * the boundary is inactive, the tool isn't a write tool, or there is no
   * path to gate.
   */
  private writeBoundaryRule(toolName: string, subject: PermissionSubject): PermissionRule | undefined {
    if (!this.enforceWriteBoundary) return undefined;
    if (!PermissionEngine.WRITE_TOOLS.has(toolName)) return undefined;
    if (!subject.resolvedPath) return undefined;

    // Same lexical-absolute reconstruction as outOfWorkspaceGuardedRule:
    // relativizeSubject's normalization is lexical only (no filesystem
    // access), so a symlink escape is only visible to the realpath-based
    // containment check here.
    const lexicalAbsolute = subject.resolvedPath.startsWith("./")
      ? resolve(this.workingDir, subject.resolvedPath.slice(2))
      : resolve(this.workingDir, subject.resolvedPath);

    if (isPathWithinWriteRoots(lexicalAbsolute, this.writeSet)) {
      return { tool: toolName, kind: "any", pattern: "", action: "allow", origin: "config" };
    }
    return { tool: toolName, kind: "any", pattern: "", action: "ask", origin: "builtin-guarded" };
  }

  private resolveBash(toolName: "run_bash" | "run_bash_background", command: string): InternalResolveResult {
    const { segments, wasUnresolved } = buildBashSubject(command);

    if (segments.length === 0) {
      return { action: "ask", wasUnresolved: true };
    }

    let combined: InternalResolveResult = this.resolveSubject(toolName, { tool: toolName, text: segments[0] });
    for (const segment of segments.slice(1)) {
      const result = this.resolveSubject(toolName, { tool: toolName, text: segment });
      combined = this.combineMostRestrictive(combined, result);
    }

    // wasUnresolved is fail-closed: it can only push the result toward ask,
    // never let it resolve weaker than ask (an actual deny still wins outright).
    const finalAction = wasUnresolved && combined.action === "allow" ? "ask" : combined.action;
    if (finalAction === "deny" || wasUnresolved) {
      return { action: finalAction, winningRule: combined.winningRule, wasUnresolved: combined.wasUnresolved || wasUnresolved };
    }

    // A compound approval is an exact match on the complete normalized
    // segment list, not an allow rule for any one segment. It may satisfy an
    // ordinary ask for the same complete call, but never weakens a segment
    // deny and never applies to a different tool (foreground/background are
    // intentionally separate permission subjects).
    const canonical = buildBashApprovalPattern(command);
    const compoundApproval = canonical && this.highestSpecificity(
      [...this.configRules, ...this.sessionRules].filter(
        (rule) => rule.tool === toolName && rule.kind === "exact" &&
          rule.action === "allow" && rule.pattern === canonical,
      ),
    );
    if (compoundApproval) {
      return { action: "allow", winningRule: compoundApproval, wasUnresolved: combined.wasUnresolved };
    }

    return { action: finalAction, winningRule: combined.winningRule, wasUnresolved: combined.wasUnresolved || wasUnresolved };
  }

  private resolveApplyPatch(args: Record<string, unknown>): InternalResolveResult {
    const plan = extractApplyPatchPlan(args, this.workingDir, {
      level: this.writePolicyLevel,
      roots: this.writeSet.length > 0 ? this.writeSet : undefined,
    });
    if (plan.status !== "known" || plan.tool !== "apply_patch" || !("targets" in plan)) {
      return { action: "ask", wasUnresolved: true };
    }

    let combined: InternalResolveResult | undefined;
    for (const target of plan.targets) {
      const path = this.normalizePath(target.path);
      const result = this.resolveSubject("apply_patch", { tool: "apply_patch", text: path, resolvedPath: path });
      combined = combined ? this.combineMostRestrictive(combined, result) : result;
    }
    return combined ?? { action: "ask", wasUnresolved: true };
  }

  private combineMostRestrictive(a: InternalResolveResult, b: InternalResolveResult): InternalResolveResult {
    const rank: Record<PermissionAction, number> = { deny: 2, ask: 1, allow: 0 };
    if (rank[b.action] > rank[a.action]) return b;
    return a;
  }

  private resolveSubject(toolName: string, subject: PermissionSubject): InternalResolveResult {
    const outOfWorkspaceRule = this.outOfWorkspaceGuardedRule(toolName, subject);
    const boundaryRule = this.writeBoundaryRule(toolName, subject);
    const builtinRules = [...BUILTIN_DESTRUCTIVE_RULES, ...BUILTIN_GUARDED_RULES].map((rule) =>
      toolName === "run_bash_background" && rule.tool === "run_bash" ? { ...rule, tool: toolName } : rule,
    );
    const allRules = [...builtinRules, ...this.configRules, ...this.sessionRules];
    const matches = allRules.filter((r) => patternMatches(r, subject));
    // Spliced in alongside the static guarded rules (not short-circuited)
    // so they participate in the same tier/specificity resolution as any
    // other match: an explicit, more-specific user rule can still beat an
    // in-set boundary allow, and the blanket builtin-allow fallback below —
    // consulted only when matches.length === 0 — never gets a chance to.
    if (outOfWorkspaceRule) matches.push(outOfWorkspaceRule);
    if (boundaryRule) matches.push(boundaryRule);

    if (matches.length === 0) {
      // Fallback: reads inside the working tree are free. Applied ONLY here,
      // when nothing else matched — a guarded secret-path rule (e.g. .env)
      // would have produced a match above, so it always pre-empts this and
      // still surfaces a prompt. See builtin-allow.ts for why these aren't
      // pooled with the specificity-ranked rules.
      const builtinAllow = BUILTIN_ALLOW_RULES.find((r) => patternMatches(r, subject));
      if (builtinAllow) {
        return { action: "allow", winningRule: builtinAllow, wasUnresolved: false };
      }

      // Only user-configured rules count toward "this tool is recognized" —
      // builtin destructive/guarded rules exist for every install regardless
      // of user intent, so they can't be what makes an unconfigured tool "known."
      // MCP tools are the one exception: connecting a server via mcpServers is
      // itself an explicit opt-in, so it stands in for a rule without one
      // actually needing to exist (and therefore without ever being persisted).
      const userRules = [...this.configRules, ...this.sessionRules];
      const hasAnyRuleForTool =
        userRules.some((r) => r.tool === toolName || r.tool === "*" || (r.tool === "mcp__*" && toolName.startsWith("mcp__"))) ||
        (toolName.startsWith("mcp__") && this.hasMcpServersConfigured);
      if (this.defaultMode === "allowAll" && hasAnyRuleForTool) {
        return { action: "allow", wasUnresolved: false };
      }
      return { action: "ask", wasUnresolved: false };
    }

    const denyMatches = matches.filter((r) => r.action === "deny");
    const askMatches = matches.filter((r) => r.action === "ask");
    const allowMatches = matches.filter((r) => r.action === "allow");

    if (denyMatches.length > 0) {
      return this.resolveTier(denyMatches, allowMatches, "deny");
    }
    // A session approval for web_search is an explicit, in-memory user
    // decision that broadens across query text. It must be checked before the
    // static guarded any-rule's kill switch, while still letting an explicit
    // deny win above. No config/always rule enters this escape hatch.
    if (
      toolName === "web_search" &&
      this.sessionRules.some((r) => r.tool === "web_search" && r.kind === "any" && r.action === "allow")
    ) {
      const sessionRule = this.sessionRules.find(
        (r) => r.tool === "web_search" && r.kind === "any" && r.action === "allow",
      );
      return { action: "allow", winningRule: sessionRule, wasUnresolved: false };
    }
    if (askMatches.length > 0) {
      // The write boundary and the out-of-workspace search/glob guard are
      // both dynamic guards: they must prompt initially, but a path-scoped
      // session/always approval from that prompt must be able to resolve the
      // same call thereafter. Keep the kind:"any" kill-switch semantics for
      // BUILTIN_GUARDED_RULES and BUILTIN_DESTRUCTIVE_RULES (static rules) —
      // the escape hatch only applies when EVERY ask match is one of these
      // two dynamic guards; a static guarded/destructive rule matching
      // alongside one still falls through to the kill-switch below.
      const dynamicAskMatches = askMatches.filter((r) => r === boundaryRule || r === outOfWorkspaceRule);
      if (dynamicAskMatches.length > 0 && dynamicAskMatches.length === askMatches.length) {
        const approvedRule = this.highestSpecificity(
          allowMatches.filter((r) => r.kind !== "any"),
        );
        if (approvedRule) {
          return { action: "allow", winningRule: approvedRule, wasUnresolved: false };
        }
      }
      return this.resolveTier(askMatches, allowMatches, "ask");
    }
    return { action: "allow", winningRule: this.highestSpecificity(allowMatches), wasUnresolved: false };
  }

  /**
   * Highest-specificity rule of `tier` wins unless an allow rule is strictly
   * more specific than every rule in `tier`. An `any`-kind rule in `tier` is
   * an absolute kill-switch and can never be overridden this way — it scores
   * the floor (0) by construction, so "strictly more specific" would be
   * satisfied by literally any real allow rule, defeating the point of a
   * deliberately unqualified catch-all block.
   */
  private resolveTier(tierMatches: PermissionRule[], allowMatches: PermissionRule[], tier: PermissionAction): InternalResolveResult {
    const bestTierRule = this.highestSpecificity(tierMatches)!;
    if (tierMatches.some((r) => r.kind === "any")) {
      return { action: tier, winningRule: bestTierRule, wasUnresolved: false };
    }

    // A secret-adjacent guard is not out-specified by a *broad* grant. "Read
    // anything in this project" does not answer "may the agent read this
    // project's .env", so a guarded ask yields to an exact allow for that path
    // and to nothing wider. Specificity alone can't express this: a tree glob
    // long enough to name a project outscores a short guard pattern such as
    // "**/.env*".
    const guarded = tierMatches.filter((r) => r.origin === "builtin-guarded");
    if (guarded.length > 0 && !allowMatches.some((r) => r.kind === "exact")) {
      return { action: tier, winningRule: this.highestSpecificity(guarded)!, wasUnresolved: false };
    }

    const maxTierSpecificity = Math.max(...tierMatches.map(specificity));
    const bestAllow = this.highestSpecificity(allowMatches);
    const bestAllowSpecificity = bestAllow ? specificity(bestAllow) : -Infinity;

    if (bestAllow && bestAllowSpecificity > maxTierSpecificity) {
      return { action: "allow", winningRule: bestAllow, wasUnresolved: false };
    }
    return { action: tier, winningRule: bestTierRule, wasUnresolved: false };
  }

  private highestSpecificity(rules: PermissionRule[]): PermissionRule | undefined {
    if (rules.length === 0) return undefined;
    return rules.reduce((best, r) => (specificity(r) > specificity(best) ? r : best));
  }

  /**
   * The allow rule an approval of this call stores. Narrowest-first: an exact
   * match on the canonical path or literal subject text, broadened only where
   * the plan says a grant may be (see buildPathRule — an external read covers
   * its enclosing project, a write does not). Used by the UI layer for
   * session/always, and to show the scope the prompt is actually storing.
   *
   * `exactOnly` builds the un-broadened rule instead, for a call whose winner
   * is a builtin guarded/destructive match: those approvals are narrowed to the
   * exact subject (narrowToExact), so this is the rule that will be stored.
   */
  buildDefaultRule(
    toolName: string,
    args?: Record<string, unknown>,
    opts?: { exactOnly?: boolean },
  ): PermissionRule {
    const a = args ?? {};
    if (toolName === "run_bash" || toolName === "run_bash_background") {
      const command = String(a.command ?? "");
      const pattern = buildBashApprovalPattern(command);
      const { segments, wasUnresolved } = buildBashSubject(command);
      const hasDestructiveSegment = segments.some((segment) =>
        BUILTIN_DESTRUCTIVE_RULES.some((builtin) =>
          patternMatches(
            toolName === "run_bash_background" && builtin.tool === "run_bash"
              ? { ...builtin, tool: toolName }
              : builtin,
            { tool: toolName, text: segment },
          ),
        ),
      );
      return {
        tool: toolName,
        kind: "exact",
        pattern: pattern ?? command,
        action: "allow",
        origin: "config",
        ...(wasUnresolved || hasDestructiveSegment ? { persistable: false } : {}),
      };
    }
    if (toolName === "web_fetch" || toolName === "view_image") {
      const raw = String(a.url ?? "");
      const source = classifyImageSource(raw);
      // view_image also takes a local file path in `url`. Only the remote form
      // is domain-scoped; the local form is scoped to the path itself, exactly
      // like any other path-taking tool. Falling through to the generic path
      // branch below would read `a.path` (absent here) and store a "" pattern
      // — an allow-everything rule.
      if (toolName === "web_fetch" || source.kind === "remote") {
        // Domain-scoped: approving one URL approves the whole hostname, so
        // "allow for session/always" covers future fetches to the same site
        // rather than re-prompting per exact URL.
        const hostname = extractHostname(raw);
        return { tool: toolName, kind: "exact", pattern: hostname ?? "", action: "allow", origin: "config" };
      }
      const asPath = source.kind === "local" ? source.path : raw;
      return {
        tool: toolName,
        kind: "exact",
        pattern: asPath ? this.normalizePath(asPath) : "",
        action: "allow",
        origin: "config",
      };
    }
    // search/glob don't take path/filePath — their subject is the directory
    // they operate on (search: `dir`, glob: `cwd`), same extraction
    // extractToolSubject uses for matching, so the stored rule's pattern
    // actually reflects what was called rather than the empty string
    // `a.path ?? a.filePath` would produce for these two tools.
    const raw = PermissionEngine.DIR_SCOPED_TOOLS.has(toolName) ? extractToolSubject(toolName, a) : a.path ?? a.filePath;
    const rawPath = typeof raw === "string" ? raw : "";
    if (!rawPath) {
      return { tool: toolName, kind: "exact", pattern: "", action: "allow", origin: "config" };
    }
    // Normalize the path the same way relativizeSubject does, so the stored
    // rule matches future calls regardless of how the LLM spells the path.
    const normalized = this.normalizePath(rawPath);
    return this.buildPathRule(toolName, normalized, opts?.exactOnly === true);
  }

  /**
   * The directory an external read approval should cover: the enclosing
   * project root — the nearest ancestor carrying a `.git` entry — or the
   * start directory itself when there is none.
   *
   * One prompt per subfolder is what this replaces: the previous scope for an
   * external read was the literal approved directory (search/glob) or one
   * level of it (read_file/list_files), so exploring a sibling repository
   * meant a prompt for every folder the agent walked into (onramp session
   * 2026-10-10T1117-ecdc: the same project asked five times).
   *
   * Bounded on purpose. The walk stops at the user's home directory and never
   * returns it, an ancestor of it, or the filesystem root — so the grant is a
   * project, never "your home directory". Returns undefined for those starts,
   * and callers then keep their previous, narrower scope.
   */
  private externalReadRoot(startDir: string): string | undefined {
    const lexical = resolve(startDir);
    const realHome = this.realpathNearestAncestor(homedir());
    const realStart = this.realpathNearestAncestor(lexical);
    // $HOME itself, an ancestor of it, or "/" is not a project — refuse rather
    // than widen. A path *under* home is the normal case.
    if (realStart === "/" || atOrAbove(realStart, realHome)) return undefined;

    // One walk, in realpath space: the only space where a symlinked parent is
    // visible, and the only one where the `.git` probe means anything.
    let realRoot = realStart;
    while (!existsSync(join(realRoot, ".git"))) {
      const parent = dirname(realRoot);
      if (parent === realRoot || atOrAbove(parent, realHome)) {
        // No repository above the start: the start directory is the project.
        realRoot = realStart;
        break;
      }
      realRoot = parent;
    }

    // Translate back to the caller's spelling, because subjects are matched
    // lexically (normalizePath resolves "./x" without touching the filesystem)
    // — a realpath pattern (/private/etc) would never match the /etc call it
    // came from. ONE offset, applied once: stepping a second path in lockstep
    // through the same loop instead lets a symlink that expands more components
    // than its spelling has move the result somewhere else entirely — an
    // ancestor of it, /, or $HOME — and the grant would then cover that.
    const lexicalRoot = resolve(lexical, relative(realStart, realRoot));
    if (lexicalRoot === "/" || atOrAbove(lexicalRoot, homedir())) return undefined;
    // …and the spelling is only the same directory when it resolves back to it.
    // A divergence (a symlink whose target sits deeper than the path reaching
    // it) leaves us unable to say what the lexical path covers, so no grant is
    // built and the caller keeps its previous, narrower scope.
    if (this.realpathNearestAncestor(lexicalRoot) !== realRoot) return undefined;
    return lexicalRoot;
  }

  /**
   * Builds an allow rule for a file path. Broadens to a directory-scope glob
   * so one approval covers related files, not just the exact path the LLM
   * happened to spell:
   *   - External read paths   → the enclosing project's tree (root/**)
   *   - External write paths  → exact match (a write approval never broadens)
   *   - Internal directories   → recursive glob (./dir/**)
   *   - Internal files         → exact match
   */
  private buildPathRule(toolName: string, normalized: string, exactOnly = false): PermissionRule {
    // A builtin guarded/destructive prompt stores the exact subject and
    // nothing wider (narrowToExact) — so the rule built for it must be the
    // exact subject too. Broadening first and narrowing the pattern afterwards
    // leaves an "exact" rule whose pattern is a glob string, which matches no
    // real path: pressing "always" on a .env prompt then grants nothing.
    if (exactOnly) {
      return { tool: toolName, kind: "exact", pattern: normalized, action: "allow", origin: "config" };
    }
    // External path (doesn't start with "./"): a read grant covers the sibling
    // project it lives in, a write grant stays exact.
    if (!normalized.startsWith("./")) {
      if (PermissionEngine.WRITE_TOOLS.has(toolName)) {
        return { tool: toolName, kind: "exact", pattern: normalized, action: "allow", origin: "config" };
      }
      if (PermissionEngine.READ_TOOLS.has(toolName)) {
        // The subject is the directory itself for a dir-subject tool, the
        // containing directory for a file — the same base externalTreeRule
        // uses, resolved up to the enclosing project.
        const startDir = PermissionEngine.DIRECTORY_SUBJECT_TOOLS.has(toolName) ? normalized : dirname(normalized);
        const root = this.externalReadRoot(startDir);
        if (root) {
          return { tool: toolName, kind: "glob", pattern: join(root, "**"), action: "allow", origin: "config" };
        }
      }
      // No bounded project root (a file straight in $HOME, say): the previous,
      // narrower scopes stand — exact for search/glob, one level for the rest.
      if (PermissionEngine.DIR_SCOPED_TOOLS.has(toolName)) {
        return { tool: toolName, kind: "exact", pattern: normalized, action: "allow", origin: "config" };
      }
      return {
        tool: toolName,
        kind: "glob",
        pattern: join(dirname(normalized), "*"),
        action: "allow",
        origin: "config",
      };
    }

    // Internal: if the path exists and is a directory → recursive glob
    const absolute = resolve(this.workingDir, normalized.slice(2));
    try {
      if (existsSync(absolute) && statSync(absolute).isDirectory()) {
        return {
          tool: toolName,
          kind: "glob",
          pattern: `${normalized}/**`,
          action: "allow",
          origin: "config",
        };
      }
    } catch {
      // Path doesn't exist or is inaccessible — fall through to exact match
    }

    // Internal file or non-existent path → exact match
    return { tool: toolName, kind: "exact", pattern: normalized, action: "allow", origin: "config" };
  }

  /**
   * For a read or write/edit tool call, returns a recursive-glob allow rule
   * covering the file's parent folder — but ONLY when at least one exact
   * approval already exists for a *different* file in that same folder, for
   * that SAME tool. This is the "second call of this kind in a folder"
   * signal: the first call gets an exact rule with no offer, and only when
   * the user is clearly working within one folder does the UI offer to
   * broaden. Returns undefined when the tool isn't a read or write/edit tool,
   * the path is external, or no sibling exact approval exists yet.
   *
   * Policy: the sibling lookup matches on `r.tool === toolName`, so read and
   * write approvals accumulate separately — prior reads in a folder never
   * unlock a recursive WRITE offer. A write grant is materially more
   * dangerous than a read grant (it lets the agent modify or overwrite
   * anything under the folder), so a write offer requires its own two prior
   * write approvals in that folder rather than piggybacking on read history.
   */
  folderScopeRule(toolName: string, args?: Record<string, unknown>): PermissionRule | undefined {
    if (!PermissionEngine.READ_TOOLS.has(toolName) && !PermissionEngine.WRITE_TOOLS.has(toolName)) return undefined;

    const raw = args?.path ?? args?.filePath;
    if (typeof raw !== "string" || !raw) return undefined;
    const normalized = this.normalizePath(raw);
    // External paths keep their existing parent-dir behavior; no folder offer.
    if (!normalized.startsWith("./")) return undefined;

    const folder = dirname(normalized);
    const folderGlob = `${folder}/**`;

    // Look for an already-approved exact rule for the SAME tool on a
    // *different* file in this same folder, across config + session rules
    // the user has granted.
    const userRules = [...this.configRules, ...this.sessionRules];
    const hasSibling = userRules.some(
      (r) =>
        r.tool === toolName &&
        r.action === "allow" &&
        r.kind === "exact" &&
        r.pattern !== normalized &&
        dirname(r.pattern) === folder,
    );
    if (!hasSibling) return undefined;

    return { tool: toolName, kind: "glob", pattern: folderGlob, action: "allow", origin: "config" };
  }

  /**
   * The recursive counterpart of the one-level parent-directory glob
   * buildPathRule stores for an external READ path — the "include subfolders"
   * option of the stage-two scope prompt. Returns undefined for internal
   * paths (folderScopeRule covers those), for non-read tools, and for calls
   * with no path: an external WRITE approval never broadens (see
   * buildPathRule), so no tree offer exists for it.
   *
   * The base mirrors what buildDefaultRule scopes to for the same call:
   * search/glob's subject IS the directory it operates on, so that directory
   * is its own base; every other read tool's subject is a file, whose base is
   * its parent directory.
   */
  externalTreeRule(toolName: string, args?: Record<string, unknown>): PermissionRule | undefined {
    if (!PermissionEngine.READ_TOOLS.has(toolName)) return undefined;

    const a = args ?? {};
    const isDirScoped = PermissionEngine.DIR_SCOPED_TOOLS.has(toolName);
    const raw = isDirScoped ? extractToolSubject(toolName, a) : a.path ?? a.filePath;
    if (typeof raw !== "string" || !raw) return undefined;

    const normalized = this.normalizePath(raw);
    if (normalized.startsWith("./")) return undefined;

    const base = isDirScoped ? normalized : dirname(normalized);
    // When buildPathRule already grants this project's whole tree — the normal
    // case for a read outside the workspace — the offer would ask the user to
    // widen to the scope the approval is about to cover anyway.
    if (this.externalReadRoot(base) !== undefined) return undefined;
    return { tool: toolName, kind: "glob", pattern: join(base, "**"), action: "allow", origin: "config" };
  }

  /**
   * Approves `rule` for this process only. Never written to disk, cleared on
   * restart. A destructive- or guarded-origin match is forced to kind
   * "exact" on the literal subject text — approving one instance never
   * broadens to the whole category (all destructive commands of that shape,
   * or all secret-adjacent paths of that shape).
   */
  approveForSession(rule: PermissionRule, matchedBuiltin?: PermissionRule): void {
    // web_search is guarded so every new query gets an explicit first-use
    // prompt, but a user's explicit session approval should not be narrowed
    // back to that one query. Keep this broadening in memory only: the
    // persistent/always path below retains the guarded narrowing behavior.
    if (rule.tool === "web_search") {
      this.sessionRules.push({ tool: "web_search", kind: "any", pattern: "", action: "allow", origin: "session" });
      return;
    }
    if (this.isInvalidApprovalRule(rule)) return;
    const narrowed = matchedBuiltin ? this.narrowToExact(rule, matchedBuiltin) : rule;
    for (const stored of this.withCompanion({ ...narrowed, origin: "session" })) {
      this.sessionRules.push(stored);
    }
  }

  /**
   * Approves `rule` for this process and persists it to .nib/settings.json
   * via an atomic write (temp file + rename). A destructive- or
   * guarded-origin match is forced to kind "exact" on the literal subject text.
   */
  approveAlways(rule: PermissionRule, matchedBuiltin?: PermissionRule): void {
    if (this.isInvalidApprovalRule(rule)) return;
    const narrowed = matchedBuiltin ? this.narrowToExact(rule, matchedBuiltin) : rule;
    // Unsafe Bash approvals may be granted for this process, but never become
    // a durable project rule. Unresolved shell has no canonical subject and
    // therefore remains prompt-only; destructive commands retain the legacy
    // in-memory approval while avoiding persistence.
    const unresolvedBashApproval =
      (narrowed.tool === "run_bash" || narrowed.tool === "run_bash_background") &&
      buildBashSubject(narrowed.pattern).wasUnresolved;
    const destructiveApproval = matchedBuiltin?.origin === "builtin-destructive";
    if (narrowed.persistable === false || unresolvedBashApproval || destructiveApproval) {
      if (destructiveApproval) {
        this.approveForSession(narrowed, matchedBuiltin);
      }
      return;
    }
    for (const rule of this.withCompanion({ ...narrowed, origin: "config" })) {
      this.configRules.push(rule);
    }
    this.persist();
  }

  /**
   * The rule(s) an approval stores: the grant itself, plus the base-directory
   * companion a recursive grant needs (treeBaseRule) so both paths — session
   * and always — store the same shape.
   */
  private withCompanion(rule: PermissionRule): PermissionRule[] {
    const base = this.treeBaseRule(rule);
    return base ? [rule, base] : [rule];
  }

  /**
   * Safety net: forces kind "exact" for builtin-origin approvals so a future
   * code change that passes a broader rule can't accidentally blanket-approve
   * a whole destructive or guarded category. Currently a no-op in practice —
   * handlePermissionDecision already passes buildDefaultRule (always kind
   * "exact") for builtin-triggered prompts — but kept as defense-in-depth.
   */
  private narrowToExact(rule: PermissionRule, matchedBuiltin: PermissionRule): PermissionRule {
    // The out-of-workspace read guard is the one guarded rule an approval
    // broadens: its whole point is "this call is outside the trust boundary,
    // ask once" — narrowing the answer back to the one directory is what made
    // exploring a sibling project cost a prompt per folder. Static secret
    // guards are untouched by this (the tag is set only there).
    if (matchedBuiltin.externalRead) return rule;
    if (matchedBuiltin.origin !== "builtin-destructive" && matchedBuiltin.origin !== "builtin-guarded") return rule;
    return { ...rule, kind: "exact" };
  }

  /**
   * The companion rule a recursive grant needs: `<base>/**` does not match
   * `<base>` itself — the same asymmetry guarded.ts works around with explicit
   * "directory-itself variants" — while search/glob/list_files resolve their
   * subject to exactly that directory. Without it, the very call just approved
   * (a glob of the sibling project's root) would ask again. External patterns
   * only: an in-workspace tree grant needs no companion, since reads inside the
   * workspace are already free.
   */
  private treeBaseRule(rule: PermissionRule): PermissionRule | undefined {
    if (rule.kind !== "glob" || !rule.pattern.endsWith("/**")) return undefined;
    if (!PermissionEngine.READ_TOOLS.has(rule.tool)) return undefined;
    if (rule.pattern.startsWith("./")) return undefined;
    const base = rule.pattern.slice(0, -3);
    return base === "" || base === "/" ? undefined : { ...rule, kind: "exact", pattern: base };
  }

  private persist(): void {
    const settingsPath = join(this.projectConfigDir, "settings.json");
    let config: Record<string, unknown> = {};
    if (existsSync(settingsPath)) {
      try {
        config = JSON.parse(readFileSync(settingsPath, "utf-8"));
      } catch {}
    }

    const onDiskRules: OnDiskRule[] = this.configRules.map((r) => ({
      tool: r.tool,
      pattern: serializeRulePattern(r.kind, r.pattern),
      action: r.action,
    }));

    config.permissions = { rules: onDiskRules, defaultMode: this.defaultMode };

    ensurePrivateDirectory(this.projectConfigDir);

    const tmpPath = join(this.projectConfigDir, `.settings.json.${randomBytes(6).toString("hex")}.tmp`);
    writePrivateFileSync(tmpPath, JSON.stringify(config, null, 2));
    renameSync(tmpPath, settingsPath);
    this.onPersist?.(settingsPath);
  }
}
