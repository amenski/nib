import { join, relative, isAbsolute, resolve, dirname, basename } from "node:path";
import { existsSync, readFileSync, renameSync, statSync, realpathSync } from "node:fs";
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
  /** True when any bash segment couldn't be safely classified — see bash-normalize.ts. Never bypassable by an auto-approve posture. */
  wasUnresolved: boolean;
  /** True when the winning rule is origin "builtin-guarded" (secret-adjacent path). Never bypassable by an auto-approve posture, same as wasUnresolved. */
  isGuarded: boolean;
}

/** Internal shape used by the private resolution helpers, before isGuarded is derived at the resolve() boundary. */
type InternalResolveResult = Omit<ResolveResult, "isGuarded">;

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
    "read_file", "write_to_file", "edit", "list_files", "glob", "search",
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
    "read_file", "list_files", "glob",
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
   * regardless of auto-approve posture or defaultMode: allowAll.
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

    return { tool: toolName, kind: "any", pattern: "", action: "ask", origin: "builtin-guarded" };
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
   * Builds the narrowest possible allow rule for a specific call — an exact
   * match on its canonical path or literal subject text. Used by the UI layer
   * when the user approves a call for session/always and no winningRule already
   * exists to approve (e.g. the call fell through to defaultMode with zero
   * matching rules), so approval never defaults to something broader than what
   * was actually asked.
   */
  buildDefaultRule(toolName: string, args?: Record<string, unknown>): PermissionRule {
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
    return this.buildPathRule(toolName, normalized);
  }

  /**
   * Builds an allow rule for a file path. Broadens to a directory-scope glob
   * so one approval covers related files, not just the exact path the LLM
   * happened to spell:
   *   - External read paths   → parent-directory glob (one level)
   *   - External write paths  → exact match (a write approval never broadens)
   *   - Internal directories   → recursive glob (./dir/**)
   *   - Internal files         → exact match
   */
  private buildPathRule(toolName: string, normalized: string): PermissionRule {
    // External path (doesn't start with "./") → parent directory non-recursive glob
    if (!normalized.startsWith("./")) {
      if (PermissionEngine.WRITE_TOOLS.has(toolName)) {
        return { tool: toolName, kind: "exact", pattern: normalized, action: "allow", origin: "config" };
      }
      // search/glob's subject IS the directory itself (not a file within
      // it), so the parent-directory glob below would grant the wrong
      // scope — the directory's siblings, not its own contents. An exact
      // match on the normalized dir path matches a future search/glob call
      // on that same directory (the subject search/glob resolve to is the
      // dir path itself, not something under it).
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
    this.sessionRules.push({ ...narrowed, origin: "session" });
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
    const configRule: PermissionRule = { ...narrowed, origin: "config" };
    this.configRules.push(configRule);
    this.persist();
  }

  /**
   * Safety net: forces kind "exact" for builtin-origin approvals so a future
   * code change that passes a broader rule can't accidentally blanket-approve
   * a whole destructive or guarded category. Currently a no-op in practice —
   * handlePermissionDecision already passes buildDefaultRule (always kind
   * "exact") for builtin-triggered prompts — but kept as defense-in-depth.
   */
  private narrowToExact(rule: PermissionRule, matchedBuiltin: PermissionRule): PermissionRule {
    if (matchedBuiltin.origin !== "builtin-destructive" && matchedBuiltin.origin !== "builtin-guarded") return rule;
    return { ...rule, kind: "exact" };
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
