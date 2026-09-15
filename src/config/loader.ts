import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PermissionConfig, PermissionRule, PatternKind, PermissionAction, PermissionProfileConfig, PermissionProfileFsRule, PermissionProfileNetwork, ProfileLevel, FsAction } from "../permissions/index.js";
import { compileGlob } from "../permissions/index.js";
import type { HooksConfig } from "../hooks/types.js";
import { parseHooksConfig } from "../hooks/config.js";
import { STATE_DIR_NAME, projectSettingsPath } from "./paths.js";

// ── Deep Code settings.json schema ──

export interface DeepCodeEnv {
  /** Model name, e.g. "deepseek-v4-pro" */
  MODEL?: string;
  /** API base URL, e.g. "https://api.deepseek.com" */
  BASE_URL?: string;
  /** API key */
  API_KEY?: string;
  /** Temperature for chat completions (as string "0"-"2") */
  TEMPERATURE?: string;
  /** Enable thinking mode ("true"/"false") */
  THINKING_ENABLED?: string;
  /** Reasoning effort ("high" or "max") */
  REASONING_EFFORT?: string;
  /** Enable debug logging ("true"/"false") */
  DEBUG_LOG_ENABLED?: string;
  /** Enable telemetry ("true"/"false") */
  TELEMETRY_ENABLED?: string;
  /** Custom env vars */
  [key: string]: string | undefined;
}

export type { PermissionConfig };

export interface McpServerConfig {
  /** Executable path or command (e.g. "npx", "node", "python") */
  command: string;
  /** Arguments for the command */
  args?: string[];
  /** Environment variables for the MCP server process */
  env?: Record<string, string>;
}

export interface WebSearchConfig {
  /**
   * Base URL of a user-run SearXNG instance, used as the primary web_search
   * backend (Bing RSS is the fallback). http:// is allowed only for
   * localhost/127.0.0.1/[::1]; any other host must be https://.
   */
  searxngUrl?: string;
  /**
   * Inline content enrichment: when true (default), web_search fetches the
   * top 3 result pages through web_fetch's pipeline and includes a bounded
   * excerpt per result. Set to false to restore snippet-only output (and its
   * 8 000-char cap). Best-effort — a failing page fetch never fails the
   * search. (handoff-web-search-searxng.md Phase 2)
   */
  enrich?: boolean;
}

export interface DeepCodeSettings {
  // ── Env (model/api config) ──
  env?: DeepCodeEnv;

  // ── Top-level model / thinking settings ──
  /** Model name (higher priority than env.MODEL) */
  model?: string;
  /** Enable thinking mode (default true for DeepSeek V4) */
  thinkingEnabled?: boolean;
  /**
   * How often the UI repaints. Slower emulators (IntelliJ's terminal, tmux
   * over a slow link) paint every write, so a high refresh rate reads as
   * continuous flicker. See ui/core/refresh-rates for measured traffic.
   */
  refresh?: "fast" | "balanced" | "slow";
  /** Reasoning effort: "high" or "max" (default "max") */
  reasoningEffort?: "low" | "high" | "max";

  // ── Permissions ──
  permissions?: PermissionConfig;

  // ── Capability profile (permission-profile.md §3) ──
  /** Coarse reachability boundary gated before the rule engine (layer 1). */
  permissionProfile?: PermissionProfileConfig;

  // ── OS sandbox (permission-profile.md §8, phase (e)) ──
  /** Mechanical Seatbelt layer for bash children. macOS-only; when enabled
   *  on another platform the loader warns and runs policy-only.
   *
   *  `writeRoots` (docs/unified-write-boundary.md) is GLOBAL-only: extra
   *  directories writable under workspace-write, beyond the workspace root
   *  and the fixed carve-outs. Parsed from the user's own
   *  `~/.nib/settings.json` ONLY — a PROJECT `.nib/settings.json`
   *  setting this key is ignored with a warning, never merged in (see
   *  loadConfig's sandbox block). This is deliberately separate from
   *  `permissionProfile.fs`, whose "explicit rules narrow only" invariant
   *  this must not weaken. */
  sandbox?: { enabled: boolean; writeRoots?: string[] };

  // ── MCP Servers ──
  mcpServers?: Record<string, McpServerConfig>;

  // ── Notify ──
  /** Path to notification script */
  notify?: string;

  // ── Web Search ──
  /** Path to custom web search script */
  webSearchTool?: string;
  /** web_search backend config (nib extension) */
  webSearch?: WebSearchConfig;

  // ── Skills ──
  /** Per-skill enable/disable */
  enabledSkills?: Record<string, boolean>;

  // ── Hooks ──
  /** Lifecycle hooks (docs/hooks-spec.md) — parsed per source so project
   *  entries keep their origin for the TOFU trust model. */
  hooks?: HooksConfig;
  /** Master switch (hooks-spec.md §1): nothing runs, not even trusted hooks. */
  disableAllHooks?: boolean;

  // ── Debug (deprecated — use the --debug CLI flag) ──
  debugLogEnabled?: boolean;

  // ── MCP hardening ──
  /** When true (or unset — the default), only allowlisted MCP server commands
   *  may be spawned. Set explicitly to false to disable the allowlist. */
  strictMcpConfig?: boolean;

  /** When true, show the client-side estimated cost (status bar segment +
   *  the /cost estimate line). Default false: the estimate is pricing-table
   *  math the owner has asked to keep hidden (2026-08-14); token counts
   *  always display. The code stays — this only gates the display. */
  showCost?: boolean;

  // ── Temperature ──
  temperature?: number;

  // ── Nib extended fields (kept for backward compat, not in Deep Code) ──
  /** Provider name (nib extension — maps env settings to AI SDK provider) */
  provider?: string;
  /** Theme config (nib extension) */
  theme?: {
    mode?: "dark" | "light" | "auto";
    name?: string;
    overrides?: Record<string, unknown>;
  };
  /** Keybinding config (nib extension) */
  keybindings?: Record<string, unknown>;
  /** Workflow integration (nib extension) */
  workflow?: {
    /** Enable the git-status poller (default true) */
    gitStatus?: boolean;
    /** Git-status poll interval in ms (default 30000; 0 = on-demand only) */
    gitPollInterval?: number;
    /** @deprecated ignored — no git-command subsystem consumes it */
    gitCommands?: boolean;
    /** @deprecated ignored — no build-tool detection subsystem consumes it */
    detectBuildTools?: boolean;
  };
  /** Compaction settings (nib extension) */
  compaction?: {
    auto?: boolean;
    threshold?: number;
  };
  /** Command-group behavior knobs (nib extension) */
  commands?: {
    /** When run_bash hits its 120s timeout, move the process to the
     *  background (job id returned to the model) instead of killing it —
     *  unless the command looks interactive (default true). */
    timeoutToBackground?: boolean;
  };
  /** Context window override (nib extension) */
  contextWindow?: number;
  /** Status line provider plugins (nib extension, deepcode-compatible) */
  statusline?: StatuslineConfig;
  /** Favorited models in the /model picker, as "provider/model" ids (nib extension) */
  favoriteModels?: string[];
  /** Recently-switched-to models in the /model picker, newest first, capped at 5 (nib extension) */
  recentModels?: { id: string; at: number }[];
}

// ── Statusline config (deepcode-compatible) ──

export interface StatuslineCommandProvider {
  type: "command";
  id: string;
  command: string;
  color?: string;
  timeoutMs?: number;
  cwd?: string;
}

export interface StatuslineModuleProvider {
  type: "module";
  id: string;
  path: string;
  color?: string;
}

export type StatuslineProvider = StatuslineCommandProvider | StatuslineModuleProvider;

export interface StatuslineConfig {
  enabled: boolean;
  refreshMs: number;
  separator: string;
  providers: StatuslineProvider[];
}

export interface LoadResult {
  config: DeepCodeSettings;
  warnings: string[];
  errors: string[];
  /**
   * Execution-capable top-level keys (see EXECUTION_CAPABLE_KEYS) that were
   * present in the PROJECT settings file specifically — determined from
   * `projectRaw` before the global/project merge, so a key present in both
   * files is still correctly attributed to the project. Empty when there is
   * no project settings file, or it declares none of these keys. Consumers
   * (settings-trust.ts callers) use this list to decide what needs an
   * explicit trust confirmation before it takes effect this session.
   */
  projectExecutionKeys: string[];
}

// ── Helpers ──

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function deepMerge<T extends Record<string, unknown>>(
  a: T,
  b: Record<string, unknown>,
): T {
  // Defense in depth: loadJsonFile already strips DANGEROUS_KEYS recursively
  // from anything parsed off disk, but deepMerge's `result[key] = bv` is a
  // plain assignment — if a `__proto__`/`constructor`/`prototype` key ever
  // reached here some other way, that assignment would silently repoint
  // `result`'s prototype via the Object.prototype setter. Skipping those keys
  // here, plus building `result` with a null prototype, means this function
  // is safe even if called on unsanitized input.
  const result: Record<string, unknown> = Object.create(null);
  for (const key of Object.keys(a)) {
    if (DANGEROUS_KEYS.has(key)) continue;
    result[key] = a[key];
  }
  for (const key of Object.keys(b)) {
    if (DANGEROUS_KEYS.has(key)) continue;
    const bv = b[key];
    const av = result[key] as unknown;
    if (isObject(av) && isObject(bv)) {
      result[key] = deepMerge(av as Record<string, unknown>, bv);
    } else {
      result[key] = bv;
    }
  }
  return result as T;
}

export function resolveHome(): string {
  return process.env.NIB_HOME || join(homedir(), STATE_DIR_NAME);
}

/**
 * Whether the OS-sandbox (Seatbelt) layer can be applied on this platform.
 * macOS-only (permission-profile.md §8); on any other platform
 * `sandbox.enabled` is honored as policy-only — the loader emits a startup
 * warning and bash children spawn unsandboxed (the policy layer still
 * enforces the profile boundary).
 */
export function sandboxSupportedOnPlatform(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "darwin";
}

/**
 * Object keys that must never be accepted from a parsed settings file.
 * `JSON.parse('{"__proto__": ...}')` creates `__proto__` as a real own
 * enumerable property (unlike an object literal, where it invokes the
 * Object.prototype setter) — so a hostile file can smuggle a payload under a
 * key that `Object.keys` still reports, but that a later plain assignment
 * (`obj[key] = value`, as deepMerge does) resolves through the setter,
 * silently repointing the object's prototype. Rejecting these three names
 * recursively at the single JSON parse point protects every downstream
 * consumer, not just deepMerge.
 */
const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Recursively strips DANGEROUS_KEYS from a parsed JSON value, reporting each
 * rejected key via `warnings` (path-qualified) rather than staying silent —
 * silently dropping a key can mask a legitimate misconfiguration, and the
 * same warnings array already reports other config problems (e.g. unknown
 * fields). Rebuilds plain objects with `Object.create(null)` so even a key
 * that slips past the filter can't reach a real Object.prototype through
 * this object's own prototype slot.
 */
function sanitizeParsedJson(value: unknown, path: string, warnings: string[]): unknown {
  if (Array.isArray(value)) {
    return value.map((v, i) => sanitizeParsedJson(v, `${path}[${i}]`, warnings));
  }
  if (isObject(value)) {
    const out: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(value)) {
      if (DANGEROUS_KEYS.has(key)) {
        warnings.push(`${path}: key "${key}" is not allowed and was rejected`);
        continue;
      }
      out[key] = sanitizeParsedJson(value[key], `${path}.${key}`, warnings);
    }
    return out;
  }
  return value;
}

function loadJsonFile(path: string, warnings: string[]): Record<string, unknown> | null {
  try {
    const content = readFileSync(path, "utf-8");
    const parsed = JSON.parse(content);
    if (parsed === null || parsed === undefined) return {};
    if (!isObject(parsed)) {
      throw new Error(
        `config file "${path}" must be a JSON object, got ${typeof parsed}`,
      );
    }
    return sanitizeParsedJson(parsed, path, warnings) as Record<string, unknown>;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

// ── Known top-level keys (for unknown-field warnings) ──

const KNOWN_KEYS = new Set([
  "env",
  "model",
  "thinkingEnabled",
  "reasoningEffort",
  "refresh",
  "permissions",
  "permissionProfile",
  "sandbox",
  "mcpServers",
  "notify",
  "webSearchTool",
  "webSearch",
  "enabledSkills",
  "hooks",
  "disableAllHooks",
  "debugLogEnabled",
  "strictMcpConfig",
  "showCost",
  "temperature",
  // Nib extensions
  "provider",
  "theme",
  "keybindings",
  "workflow",
  "compaction",
  "commands",
  "contextWindow",
  "statusline",
  "favoriteModels",
  "recentModels",
]);

/**
 * Top-level settings keys that can cause code execution or network-traffic
 * redirection when their VALUE comes from a project's `.nib/settings.json`
 * rather than the user's own global `~/.nib/settings.json`:
 *  - statusline: providers[].command runs a shell command (manager.ts); a
 *    module provider does `import()` of a project-relative path.
 *  - mcpServers: each entry spawns a subprocess at connect time.
 *  - notify: spawns a script (argv-only, no shell — still an attacker-chosen
 *    executable).
 *  - env: only the BASE_URL redirect matters here (API traffic destination);
 *    the rest of `env` is never splatted into process.env, so it carries no
 *    execution risk beyond that one field.
 *  - strictMcpConfig: a project setting this to `false` disables the
 *    MCP-server-command allowlist — a security control being turned OFF is
 *    just as consequential as a new execution surface being turned on, so it
 *    deserves the same consent.
 *  - permissions: rule-based allow/ask/deny for every tool call. A project
 *    granting itself `allow` rules (or `defaultMode: "allowAll"`) bypasses
 *    the approval prompts that make every other gate here meaningful.
 *  - permissionProfile: the coarse capability-boundary layer
 *    (permission-profile.md §3) — a project setting `level: "unrestricted"`
 *    (or omitting the key, which resolves the same way — see
 *    settings-trust.ts's stripExecutionKeys) removes the one layer that can
 *    deny reads/writes/network reachability outright, independent of the
 *    rule engine.
 *  - sandbox: the mechanical Seatbelt layer for bash children
 *    (permission-profile.md §8). A project setting `enabled: false` (or
 *    omitting the key) drops OS-level enforcement, leaving only the policy
 *    layers.
 *  - webSearch: only `searxngUrl` matters here (same traffic-redirect
 *    concern as env.BASE_URL) — it controls the HOST every web_search query
 *    is sent to (web-search-searxng.ts), so a project can exfiltrate search
 *    queries and inject fabricated "results" back to the model. `enrich` is
 *    a content-fetching toggle with no host/network control and is not
 *    gated (see resolveProjectExecutionKeys / stripExecutionKeys).
 *
 * Adding a key to this set means "a project-supplied value for this key needs
 * explicit user trust before it takes effect" (see settings-trust.ts) — the
 * same TOFU gate hooks and skills apply to project-declared content. Global
 * settings are the user's own and stay implicitly trusted, matching the
 * hooks/skills global-vs-project split.
 */
export const EXECUTION_CAPABLE_KEYS = new Set([
  "statusline",
  "mcpServers",
  "notify",
  "env",
  "strictMcpConfig",
  "permissions",
  "permissionProfile",
  "sandbox",
  "webSearch",
]);

const VALID_ACTIONS = new Set(["allow", "ask", "deny"]);
const VALID_PROFILE_LEVELS = new Set(["strict-sandbox", "workspace-write", "unrestricted"]);
const VALID_FS_ACTIONS = new Set(["deny", "read", "write"]);

function parsePatternKindAndPattern(rawPattern: string): { kind: PatternKind; pattern: string } {
  if (rawPattern.endsWith(":*")) {
    return { kind: "prefix", pattern: rawPattern.slice(0, -2) };
  }
  if (rawPattern.includes("*") || rawPattern.includes("?")) {
    return { kind: "glob", pattern: rawPattern };
  }
  if (rawPattern === "") {
    return { kind: "any", pattern: "" };
  }
  return { kind: "exact", pattern: rawPattern };
}

// ── Validation ──

function validatePermissions(
  perms: unknown,
  source: string,
  errors: string[],
): PermissionConfig | undefined {
  if (!isObject(perms)) {
    errors.push(`${source}: permissions must be an object`);
    return undefined;
  }
  const p = perms as Record<string, unknown>;
  const result: PermissionConfig = {};

  if ("rules" in p) {
    if (Array.isArray(p.rules)) {
      const rules: PermissionRule[] = [];
      for (const item of p.rules as unknown[]) {
        if (!isObject(item)) {
          errors.push(`${source}: permissions.rules contains a non-object entry`);
          continue;
        }
        const r = item as Record<string, unknown>;
        if (typeof r.tool !== "string") {
          errors.push(`${source}: permissions.rules entry missing string "tool"`);
          continue;
        }
        if (typeof r.pattern !== "string") {
          errors.push(`${source}: permissions.rules entry for tool "${r.tool}" missing string "pattern"`);
          continue;
        }
        if (typeof r.action !== "string" || !VALID_ACTIONS.has(r.action)) {
          errors.push(`${source}: permissions.rules entry for tool "${r.tool}" has invalid action "${r.action}"`);
          continue;
        }
        const { kind, pattern } = parsePatternKindAndPattern(r.pattern);
        rules.push({ tool: r.tool, kind, pattern, action: r.action as PermissionAction, origin: "config" });
      }
      result.rules = rules;
    } else {
      errors.push(`${source}: permissions.rules must be an array`);
    }
  }

  if ("defaultMode" in p) {
    if (
      p.defaultMode === "allowAll" ||
      p.defaultMode === "askAll"
    ) {
      result.defaultMode = p.defaultMode;
    } else {
      errors.push(
        `${source}: permissions.defaultMode must be "allowAll" or "askAll"`,
      );
    }
  }

  return result;
}

/**
 * True when a write rule's pattern cannot leave the workspace: not absolute,
 * not "~"-home-relative, first segment not "..". Used by the narrowing-only
 * check — an explicit rule can never grant beyond the level's default
 * write-set (permission-profile.md §3).
 */
function isWorkspaceRelativePattern(pattern: string): boolean {
  if (pattern.startsWith("/") || pattern.startsWith("~")) return false;
  return pattern.split("/")[0] !== "..";
}

function validatePermissionProfile(
  raw: unknown,
  source: string,
  errors: string[],
): PermissionProfileConfig | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isObject(raw)) {
    errors.push(`${source}: permissionProfile must be an object`);
    return undefined;
  }
  const p = raw as Record<string, unknown>;

  // level — required when the key is present, one of the three presets (§3).
  let level: ProfileLevel | undefined;
  if (typeof p.level === "string" && VALID_PROFILE_LEVELS.has(p.level)) {
    level = p.level as ProfileLevel;
  } else {
    errors.push(
      `${source}: permissionProfile.level must be one of "strict-sandbox" | "workspace-write" | "unrestricted"`,
    );
  }
  // Errors are fatal (loadConfig errors exit 1), so the fallback never runs;
  // kept for a well-typed partial result while further errors accumulate.
  const result: PermissionProfileConfig = { level: level ?? "unrestricted" };

  if ("fs" in p) {
    if (!Array.isArray(p.fs)) {
      errors.push(`${source}: permissionProfile.fs must be an array`);
    } else {
      const fs: PermissionProfileFsRule[] = [];
      for (const item of p.fs as unknown[]) {
        if (!isObject(item)) {
          errors.push(`${source}: permissionProfile.fs contains a non-object entry`);
          continue;
        }
        const r = item as Record<string, unknown>;
        const path = typeof r.path === "string" ? r.path : "";
        if (!path) {
          errors.push(`${source}: permissionProfile.fs entry missing string "path"`);
          continue;
        }
        if (typeof r.action !== "string" || !VALID_FS_ACTIONS.has(r.action)) {
          errors.push(
            `${source}: permissionProfile.fs entry "${path}" has invalid action "${String(r.action)}" (must be "deny" | "read" | "write")`,
          );
          continue;
        }
        try {
          compileGlob(path);
        } catch (err) {
          errors.push(
            `${source}: permissionProfile.fs entry "${path}" has invalid glob: ${(err as Error).message}`,
          );
          continue;
        }
        const action = r.action as FsAction;
        // Narrowing-only (§3): explicit rules can never grant beyond the
        // level's default. strict-sandbox permits no writes at all;
        // workspace-write permits writes only inside workspace roots.
        if (level === "strict-sandbox" && action === "write") {
          errors.push(
            `${source}: permissionProfile.fs entry "${path}": action "write" not allowed at level "strict-sandbox" (explicit rules narrow only)`,
          );
          continue;
        }
        if (level === "workspace-write" && action === "write" && !isWorkspaceRelativePattern(path)) {
          errors.push(
            `${source}: permissionProfile.fs entry "${path}": action "write" must be a workspace-relative path at level "workspace-write" (explicit rules narrow only)`,
          );
          continue;
        }
        fs.push({ path, action });
      }
      if (fs.length > 0) result.fs = fs;
    }
  }

  if ("network" in p) {
    if (!isObject(p.network)) {
      errors.push(`${source}: permissionProfile.network must be an object`);
    } else {
      const n = p.network as Record<string, unknown>;
      const network: PermissionProfileNetwork = {};
      for (const key of ["allow", "deny"] as const) {
        if (!(key in n)) continue;
        const entries = n[key];
        if (!Array.isArray(entries)) {
          errors.push(`${source}: permissionProfile.network.${key} must be an array of strings`);
          continue;
        }
        const strings = entries.filter((e): e is string => typeof e === "string" && e !== "");
        if (strings.length !== entries.length) {
          errors.push(`${source}: permissionProfile.network.${key} must be an array of strings`);
        }
        // "*" is the only wildcard — a pattern like "*.example.com" would
        // never match (matching is exact-or-"*") and would silently fail to
        // deny, which is worse than a config error.
        const bad = strings.find((e) => e.includes("*") && e !== "*");
        if (bad !== undefined) {
          errors.push(
            `${source}: permissionProfile.network.${key} entry "${bad}" is not a valid hostname — "*" matches any host, subdomain wildcards are not supported`,
          );
        }
        if (strings.length > 0) network[key] = strings;
      }
      if (network.allow !== undefined || network.deny !== undefined) {
        result.network = network;
      }
    }
  }

  return result;
}

/**
 * Project > global merge for permissionProfile (permission-profile.md §3).
 * Parsed per-source (not from the merged object) because deepMerge would
 * replace the fs/network arrays wholesale. Chosen rule, simplest defensible:
 *  - level: project wins.
 *  - fs: project entries append after global; a project rule with the same
 *    `path` string replaces the global rule (one rule per path; the later
 *    entry wins, replaced rules keep their original position).
 *  - network: allow/deny arrays union (deduped); a domain in both lists is
 *    denied — deny is absolute, so the stricter membership wins.
 */
function mergePermissionProfiles(
  global: PermissionProfileConfig | undefined,
  project: PermissionProfileConfig | undefined,
): PermissionProfileConfig | undefined {
  if (!global && !project) return undefined;
  const byPath = new Map<string, PermissionProfileFsRule>();
  for (const r of global?.fs ?? []) byPath.set(r.path, r);
  for (const r of project?.fs ?? []) byPath.set(r.path, r);
  const fs = [...byPath.values()];
  const allow = [...new Set([...(global?.network?.allow ?? []), ...(project?.network?.allow ?? [])])];
  const deny = [...new Set([...(global?.network?.deny ?? []), ...(project?.network?.deny ?? [])])];
  const network =
    allow.length > 0 || deny.length > 0
      ? {
          ...(allow.length > 0 ? { allow } : {}),
          ...(deny.length > 0 ? { deny } : {}),
        }
      : undefined;
  return {
    level: project?.level ?? global?.level ?? "unrestricted",
    ...(fs.length > 0 ? { fs } : {}),
    ...(network ? { network } : {}),
  };
}

// ── Legacy scope migration ──

interface LegacyPermissionConfig {
  allow?: string[];
  deny?: string[];
  ask?: string[];
  defaultMode?: "allowAll" | "askAll";
}

const LEGACY_SCOPE_RULES: Record<string, PermissionRule[]> = {
  "read-in-cwd": [{ tool: "read_file", kind: "glob", pattern: "./**", action: "allow", origin: "config" }],
  "read-out-cwd": [{ tool: "read_file", kind: "any", pattern: "", action: "allow", origin: "config" }],
  "write-in-cwd": [{ tool: "write_to_file", kind: "glob", pattern: "./**", action: "allow", origin: "config" }],
  "write-out-cwd": [{ tool: "write_to_file", kind: "any", pattern: "", action: "allow", origin: "config" }],
  "delete-in-cwd": [{ tool: "run_bash", kind: "prefix", pattern: "rm", action: "allow", origin: "config" }],
  "delete-out-cwd": [{ tool: "run_bash", kind: "prefix", pattern: "rm", action: "allow", origin: "config" }],
  "query-git-log": [
    { tool: "run_bash", kind: "prefix", pattern: "git log", action: "allow", origin: "config" },
    { tool: "run_bash", kind: "prefix", pattern: "git show", action: "allow", origin: "config" },
    { tool: "run_bash", kind: "prefix", pattern: "git diff", action: "allow", origin: "config" },
    { tool: "run_bash", kind: "prefix", pattern: "git blame", action: "allow", origin: "config" },
  ],
  "mutate-git-log": [
    { tool: "run_bash", kind: "prefix", pattern: "git commit", action: "allow", origin: "config" },
    { tool: "run_bash", kind: "prefix", pattern: "git push", action: "allow", origin: "config" },
    { tool: "run_bash", kind: "prefix", pattern: "git rebase", action: "allow", origin: "config" },
    { tool: "run_bash", kind: "prefix", pattern: "git merge", action: "allow", origin: "config" },
    { tool: "run_bash", kind: "prefix", pattern: "git reset", action: "allow", origin: "config" },
  ],
  scan: [
    { tool: "glob", kind: "any", pattern: "", action: "allow", origin: "config" },
    { tool: "search", kind: "any", pattern: "", action: "allow", origin: "config" },
  ],
  mcp: [{ tool: "mcp__*", kind: "any", pattern: "", action: "allow", origin: "config" }],
};

export interface MigrationResult {
  rules: PermissionRule[];
  warnings: string[];
}

/**
 * Pure, in-memory translation of the old scope-bucket permission shape into
 * the new rule shape. Never writes to disk — the caller (loadConfig) applies
 * this to the parsed config before returning it; nothing on disk changes
 * until the next real approveAlways() call persists the new shape via an
 * atomic write. Idempotent: a config that already has a `rules` array is
 * returned unchanged (translation is skipped entirely).
 */
export function migrateLegacyPermissions(raw: unknown): MigrationResult {
  if (!isObject(raw)) return { rules: [], warnings: [] };
  const p = raw as Record<string, unknown>;

  if ("rules" in p) return { rules: [], warnings: [] };

  const legacy = p as LegacyPermissionConfig;
  const rules: PermissionRule[] = [];
  const warnings: string[] = [];
  const seenScopes = new Set<string>();

  for (const [scopeList, action] of [
    [legacy.allow, "allow"],
    [legacy.deny, "deny"],
    [legacy.ask, "ask"],
  ] as const) {
    if (!Array.isArray(scopeList)) continue;
    for (const scope of scopeList) {
      seenScopes.add(scope);
      if (scope === "network") {
        warnings.push(
          `permissions: legacy scope "network" has no clean rule-based equivalent (it was triggered by multiple unrelated command types) and was dropped during migration — review and re-add explicit rules if needed`,
        );
        continue;
      }
      const templates = LEGACY_SCOPE_RULES[scope];
      if (!templates) {
        warnings.push(`permissions: unrecognized legacy scope "${scope}" dropped during migration`);
        continue;
      }
      for (const template of templates) {
        rules.push({ ...template, action });
      }
    }
  }

  if (seenScopes.size > 0) {
    warnings.push(
      `permissions: migrated ${seenScopes.size} legacy scope(s) to rule-based permissions — review .nib/settings.json and re-approve as needed`,
    );
  }

  return { rules, warnings };
}

function validateMcpServers(
  mcp: unknown,
  source: string,
  errors: string[],
): Record<string, McpServerConfig> | undefined {
  if (!isObject(mcp)) {
    errors.push(`${source}: mcpServers must be an object`);
    return undefined;
  }
  const entries = mcp as Record<string, unknown>;
  const validated: Record<string, McpServerConfig> = {};

  for (const [name, entry] of Object.entries(entries)) {
    if (!isObject(entry)) {
      errors.push(`${source}: mcpServers.${name} must be an object`);
      continue;
    }
    const e = entry as Record<string, unknown>;
    if (typeof e.command !== "string") {
      errors.push(`${source}: mcpServers.${name}.command is required`);
      continue;
    }
    const srv: McpServerConfig = { command: e.command };

    if ("args" in e) {
      if (Array.isArray(e.args)) {
        srv.args = e.args.filter((a): a is string => typeof a === "string");
      } else {
        errors.push(
          `${source}: mcpServers.${name}.args must be an array of strings`,
        );
      }
    }

    if ("env" in e && isObject(e.env)) {
      const env: Record<string, string> = {};
      for (const [ek, ev] of Object.entries(
        e.env as Record<string, unknown>,
      )) {
        if (typeof ev === "string") env[ek] = ev;
      }
      srv.env = env;
    } else if ("env" in e) {
      errors.push(
        `${source}: mcpServers.${name}.env must be an object`,
      );
    }

    validated[name] = srv;
  }

  return validated;
}

function validateStatusline(
  raw: unknown,
  source: string,
  errors: string[],
): StatuslineConfig | undefined {
  if (!isObject(raw)) {
    errors.push(`${source}: statusline must be an object`);
    return undefined;
  }
  const s = raw as Record<string, unknown>;

  // providers (required to do anything; validated first so `enabled` can default)
  const providers: StatuslineProvider[] = [];
  if ("providers" in s) {
    if (!Array.isArray(s.providers)) {
      errors.push(`${source}: statusline.providers must be an array`);
    } else {
      for (const item of s.providers as unknown[]) {
        if (!isObject(item)) {
          errors.push(`${source}: statusline.providers contains a non-object entry`);
          continue;
        }
        const p = item as Record<string, unknown>;
        if (typeof p.id !== "string") {
          errors.push(`${source}: statusline.providers entry missing string "id"`);
          continue;
        }
        if (typeof p.color !== "undefined" && typeof p.color !== "string") {
          errors.push(`${source}: statusline.providers.${p.id}.color must be a string`);
          continue;
        }
        if (p.type === "command") {
          if (typeof p.command !== "string") {
            errors.push(`${source}: statusline.providers.${p.id}.command is required`);
            continue;
          }
          if (typeof p.timeoutMs !== "undefined" && typeof p.timeoutMs !== "number") {
            errors.push(`${source}: statusline.providers.${p.id}.timeoutMs must be a number`);
            continue;
          }
          if (typeof p.cwd !== "undefined" && typeof p.cwd !== "string") {
            errors.push(`${source}: statusline.providers.${p.id}.cwd must be a string`);
            continue;
          }
          providers.push({
            type: "command",
            id: p.id,
            command: p.command,
            ...(typeof p.color === "string" ? { color: p.color } : {}),
            ...(typeof p.timeoutMs === "number" ? { timeoutMs: p.timeoutMs } : {}),
            ...(typeof p.cwd === "string" ? { cwd: p.cwd } : {}),
          });
        } else if (p.type === "module") {
          if (typeof p.path !== "string") {
            errors.push(`${source}: statusline.providers.${p.id}.path is required`);
            continue;
          }
          providers.push({
            type: "module",
            id: p.id,
            path: p.path,
            ...(typeof p.color === "string" ? { color: p.color } : {}),
          });
        } else {
          errors.push(`${source}: statusline.providers.${p.id}.type must be "command" or "module"`);
        }
      }
    }
  }

  // enabled — defaults true when providers exist
  let enabled = providers.length > 0;
  if ("enabled" in s) {
    if (typeof s.enabled === "boolean") {
      enabled = s.enabled;
    } else {
      errors.push(`${source}: statusline.enabled must be a boolean`);
    }
  }

  // refreshMs — min 500, default 2000
  let refreshMs = 2000;
  if ("refreshMs" in s) {
    if (typeof s.refreshMs === "number") {
      refreshMs = Math.max(500, s.refreshMs);
    } else {
      errors.push(`${source}: statusline.refreshMs must be a number`);
    }
  }

  // separator — default " · "
  let separator = " · ";
  if ("separator" in s) {
    if (typeof s.separator === "string") {
      separator = s.separator;
    } else {
      errors.push(`${source}: statusline.separator must be a string`);
    }
  }

  return { enabled, refreshMs, separator, providers };
}

/** True for localhost/127.0.0.1/[::1] — the only hostnames http:// is allowed for on searxngUrl. */
function isLocalHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}

/**
 * Validates webSearch.searxngUrl: http:// only for localhost/127.0.0.1/[::1],
 * https:// required otherwise. Also parses webSearch.enrich (default true when
 * absent). Invalid values are a warning, not an error — an optional knob
 * shouldn't fail launch (same posture as `refresh`).
 */
function validateWebSearch(
  raw: unknown,
  source: string,
  warnings: string[],
): WebSearchConfig | undefined {
  if (!isObject(raw)) {
    warnings.push(`${source}: webSearch must be an object — ignoring`);
    return undefined;
  }
  const w = raw as Record<string, unknown>;
  const result: WebSearchConfig = {};

  if ("searxngUrl" in w) {
    if (typeof w.searxngUrl !== "string") {
      warnings.push(`${source}: webSearch.searxngUrl must be a string — ignoring`);
    } else {
      let parsed: URL | undefined;
      try {
        parsed = new URL(w.searxngUrl);
      } catch {
        warnings.push(`${source}: webSearch.searxngUrl "${w.searxngUrl}" is not a valid URL — ignoring`);
      }
      if (parsed) {
        if (parsed.protocol === "http:" && !isLocalHostname(parsed.hostname)) {
          warnings.push(
            `${source}: webSearch.searxngUrl "${w.searxngUrl}" uses http:// for a non-local host — only https:// is allowed except for localhost/127.0.0.1/[::1] — ignoring`,
          );
        } else if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          warnings.push(
            `${source}: webSearch.searxngUrl "${w.searxngUrl}" must be http:// or https:// — ignoring`,
          );
        } else if (parsed.username || parsed.password) {
          warnings.push(
            `${source}: webSearch.searxngUrl must not embed credentials — ignoring`,
          );
        } else {
          // Store the parsed, validated URL (trailing slash stripped) so the
          // value the client fetches is exactly the one this check approved.
          result.searxngUrl = parsed.toString().replace(/\/$/, "");
        }
      }
    }
  }

  if ("enrich" in w) {
    if (typeof w.enrich === "boolean") {
      result.enrich = w.enrich;
    } else {
      warnings.push(`${source}: webSearch.enrich must be a boolean — ignoring`);
    }
  }

  return result;
}

/**
 * Determines which EXECUTION_CAPABLE_KEYS the PROJECT settings file actually
 * resolves to, independent of the global/project merge (so a key present in
 * both files is still attributed to the project — the merge alone can't tell
 * where a key "came from" once deepMerge has combined the two objects).
 *
 * Deliberately NOT `Object.keys(projectRaw).filter(...)`: matching on raw key
 * names is exactly the flaw that let prototype pollution bypass this gate
 * (`JSON.parse('{"__proto__":{...}}')` makes `__proto__` a real own
 * enumerable property, so `Object.keys` doesn't see it as a match for any of
 * these names, yet a later plain assignment in deepMerge still resolves the
 * smuggled value onto the merged object's prototype chain). Sanitization in
 * loadJsonFile now closes that specific hole, but name-based detection would
 * still be one future parser or merge quirk away from failing silently again.
 * Instead, each execution-capable key is run through its real validator
 * against `projectRaw` ALONE (as if no global settings file existed) and a
 * key counts as project-execution-capable only if that produces an actual
 * resolved value — the same shape the consumers below (config.statusline,
 * config.mcpServers, etc.) end up with. A smuggled or malformed value can
 * therefore never be invisible to the gate: either it fails validation (and
 * never reaches `config` at all) or it succeeds and is correctly flagged.
 *
 * This is an isolated, throwaway validation pass — its own errors/warnings
 * are discarded; the real pass below (against the merged config) is what
 * reports diagnostics to the user.
 */
function resolveProjectExecutionKeys(projectRaw: Record<string, unknown> | null): string[] {
  if (!projectRaw) return [];
  const scratchErrors: string[] = [];
  const detected: string[] = [];

  if ("statusline" in projectRaw) {
    if (validateStatusline(projectRaw.statusline, "project", scratchErrors) !== undefined) {
      detected.push("statusline");
    }
  }
  if ("mcpServers" in projectRaw) {
    if (validateMcpServers(projectRaw.mcpServers, "project", scratchErrors) !== undefined) {
      detected.push("mcpServers");
    }
  }
  if ("notify" in projectRaw) {
    if (typeof projectRaw.notify === "string") detected.push("notify");
  }
  if ("env" in projectRaw) {
    if (isObject(projectRaw.env)) detected.push("env");
  }
  if ("strictMcpConfig" in projectRaw) {
    if (typeof projectRaw.strictMcpConfig === "boolean") detected.push("strictMcpConfig");
  }
  if ("permissions" in projectRaw) {
    if (validatePermissions(projectRaw.permissions, "project", scratchErrors) !== undefined) {
      detected.push("permissions");
    }
  }
  if ("permissionProfile" in projectRaw) {
    if (validatePermissionProfile(projectRaw.permissionProfile, "project", scratchErrors) !== undefined) {
      detected.push("permissionProfile");
    }
  }
  if ("sandbox" in projectRaw) {
    if (isObject(projectRaw.sandbox) && typeof (projectRaw.sandbox as Record<string, unknown>).enabled === "boolean") {
      detected.push("sandbox");
    }
  }
  if ("webSearch" in projectRaw) {
    // Only searxngUrl is execution-capable (host-control risk) — enrich is
    // not, so a project webSearch block containing only enrich must not
    // trigger the gate. Run through the real validator (not raw key
    // presence) so a smuggled/malformed value can't be invisible here either.
    const scratchWarnings: string[] = [];
    const webSearch = validateWebSearch(projectRaw.webSearch, "project", scratchWarnings);
    if (webSearch?.searxngUrl !== undefined) {
      detected.push("webSearch");
    }
  }

  return detected;
}

// ── Main loader ──

export function loadConfig(projectDir?: string): LoadResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const globalPath = join(resolveHome(), "settings.json");
  const projDir = projectDir ?? process.cwd();
  const projectPath = projectSettingsPath(projDir);

  const globalRaw = loadJsonFile(globalPath, warnings);
  const projectRaw = loadJsonFile(projectPath, warnings);

  const projectExecutionKeys = resolveProjectExecutionKeys(projectRaw);

  let merged: Record<string, unknown> = {};
  if (globalRaw && projectRaw) {
    merged = deepMerge(globalRaw, projectRaw);
  } else if (globalRaw) {
    merged = globalRaw;
  } else if (projectRaw) {
    merged = projectRaw;
  }

  const config: DeepCodeSettings = {};

  // ── env block ──
  if ("env" in merged) {
    if (isObject(merged.env)) {
      const env = merged.env as Record<string, unknown>;
      const envConfig: DeepCodeEnv = {};
      for (const [key, value] of Object.entries(env)) {
        if (typeof value === "string") {
          envConfig[key] = value;
        }
      }
      config.env = envConfig;
    } else {
      errors.push("config.env: must be an object");
    }
  }

  // ── model (top-level, higher priority than env.MODEL) ──
  if ("model" in merged) {
    if (typeof merged.model === "string") {
      config.model = merged.model;
    } else {
      errors.push("config.model: must be a string");
    }
  }

  // ── refresh ──
  if ("refresh" in merged) {
    const allowed = ["fast", "balanced", "slow"];
    if (typeof merged.refresh === "string" && allowed.includes(merged.refresh)) {
      config.refresh = merged.refresh as "fast" | "balanced" | "slow";
    } else {
      // refresh is a cosmetic display knob — it only affects repaint cadence,
      // not correctness. A hard error here is disproportionate: it would take
      // loadConfig's errors down the main() exit(1) path over a typo in a
      // setting the user probably doesn't remember the exact spelling of.
      // Warn and fall through to env/default resolution instead.
      warnings.push(
        `config.refresh: "${String(merged.refresh)}" is not one of ${allowed.join(" | ")} — using default`,
      );
    }
  }

  // ── thinkingEnabled ──
  if ("thinkingEnabled" in merged) {
    if (typeof merged.thinkingEnabled === "boolean") {
      config.thinkingEnabled = merged.thinkingEnabled;
    } else {
      errors.push("config.thinkingEnabled: must be a boolean");
    }
  }

  // ── reasoningEffort ──
  if ("reasoningEffort" in merged) {
    if (merged.reasoningEffort === "low" || merged.reasoningEffort === "high" || merged.reasoningEffort === "max") {
      config.reasoningEffort = merged.reasoningEffort;
    } else {
      errors.push('config.reasoningEffort: must be "low", "high", or "max"');
    }
  }

  // ── permissions ──
  if ("permissions" in merged) {
    const permsRaw = isObject(merged.permissions) ? merged.permissions : {};
    const alreadyNewShape = "rules" in permsRaw;

    let permsForValidation: Record<string, unknown> = merged.permissions as Record<string, unknown>;
    if (!alreadyNewShape) {
      const migration = migrateLegacyPermissions(merged.permissions);
      warnings.push(...migration.warnings);
      permsForValidation = { ...permsRaw, rules: migration.rules };
    }

    const perms = validatePermissions(permsForValidation, "config", errors);
    if (perms) config.permissions = perms;
  }

  // ── permissionProfile ──
  // Parsed from the per-source raws (not the merged object) so the fs/network
  // merge rule can append/override by path/domain instead of the wholesale
  // array replacement deepMerge would do. Errors name the file they came
  // from ("global config" / "project config"). (permission-profile.md §3)
  const profile = mergePermissionProfiles(
    validatePermissionProfile(globalRaw?.permissionProfile, "global config", errors),
    validatePermissionProfile(projectRaw?.permissionProfile, "project config", errors),
  );
  if (profile) config.permissionProfile = profile;

  // ── sandbox (permission-profile.md §8, phase (e)) ──
  // Mechanical Seatbelt layer for bash children; meaningful only with a
  // profile level below unrestricted. macOS-only — on other platforms the
  // flag is honored as policy-only with a startup notice.
  if ("sandbox" in merged) {
    if (isObject(merged.sandbox)) {
      const s = merged.sandbox as Record<string, unknown>;
      if (typeof s.enabled === "boolean") {
        config.sandbox = { enabled: s.enabled };
        if (s.enabled && !sandboxSupportedOnPlatform()) {
          warnings.push("sandbox is macOS-only; running policy-only");
        }
      } else {
        errors.push("config.sandbox.enabled: must be a boolean");
      }

      // writeRoots (docs/unified-write-boundary.md): the trusted, GLOBAL-only
      // grant — read from globalRaw alone, never from `merged` or
      // `projectRaw`, so a project cannot widen the write-set even by
      // co-opting a key the user's global file already declared. This is the
      // load-bearing security property: it does not depend on TOFU trust
      // (unlike the rest of `sandbox`, gated wholesale via
      // EXECUTION_CAPABLE_KEYS) — a project's writeRoots value is ALWAYS
      // ignored, trusted settings file or not.
      if (isObject(globalRaw?.sandbox) && "writeRoots" in (globalRaw.sandbox as Record<string, unknown>)) {
        const raw = (globalRaw.sandbox as Record<string, unknown>).writeRoots;
        if (Array.isArray(raw) && raw.every((p) => typeof p === "string")) {
          if (config.sandbox && raw.length > 0) config.sandbox.writeRoots = raw as string[];
        } else {
          errors.push("config.sandbox.writeRoots: must be an array of strings");
        }
      }
      if (isObject(projectRaw?.sandbox) && "writeRoots" in (projectRaw.sandbox as Record<string, unknown>)) {
        warnings.push(
          "sandbox.writeRoots is global-only and was ignored in project .nib/settings.json — set it in ~/.nib/settings.json instead",
        );
      }
    } else {
      errors.push("config.sandbox: must be an object");
    }
  }

  // ── mcpServers ──
  if ("mcpServers" in merged) {
    const mcp = validateMcpServers(merged.mcpServers, "config", errors);
    if (mcp) config.mcpServers = mcp;
  }

  // ── notify ──
  if ("notify" in merged) {
    if (typeof merged.notify === "string") {
      config.notify = merged.notify;
    } else {
      errors.push("config.notify: must be a string (script path)");
    }
  }

  // ── webSearchTool (deprecated) ──
  if ("webSearchTool" in merged) {
    if (typeof merged.webSearchTool === "string") {
      config.webSearchTool = merged.webSearchTool;
      warnings.push(
        "webSearchTool is deprecated and ignored — use an MCP search server (mcpServers) instead",
      );
    } else {
      errors.push("config.webSearchTool: must be a string (script path)");
    }
  }

  // ── webSearch ──
  if ("webSearch" in merged) {
    const webSearch = validateWebSearch(merged.webSearch, "config", warnings);
    if (webSearch) config.webSearch = webSearch;
  }

  // ── enabledSkills ──
  if ("enabledSkills" in merged) {
    if (isObject(merged.enabledSkills)) {
      const skills: Record<string, boolean> = {};
      for (const [name, value] of Object.entries(
        merged.enabledSkills as Record<string, unknown>,
      )) {
        if (typeof value === "boolean") {
          skills[name] = value;
        } else {
          errors.push(
            `config.enabledSkills.${name}: must be boolean`,
          );
        }
      }
      config.enabledSkills = skills;
    } else {
      errors.push("config.enabledSkills: must be an object");
    }
  }

  // ── hooks ──
  // Parsed from the per-source raws (not the merged object) so each entry
  // keeps its origin for the TOFU trust model (hooks-spec.md §6). Merge
  // semantics: per event key, project replaces global; events the project
  // doesn't mention keep the global entries.
  const hooks = parseHooksConfig(globalRaw?.hooks, projectRaw?.hooks, "config", errors);
  if (hooks) config.hooks = hooks;

  // ── disableAllHooks (master switch) ──
  if ("disableAllHooks" in merged) {
    if (typeof merged.disableAllHooks === "boolean") {
      config.disableAllHooks = merged.disableAllHooks;
    } else {
      errors.push("config.disableAllHooks: must be a boolean");
    }
  }

  // ── debugLogEnabled (deprecated) ──
  if ("debugLogEnabled" in merged) {
    if (typeof merged.debugLogEnabled === "boolean") {
      config.debugLogEnabled = merged.debugLogEnabled;
      warnings.push(
        "debugLogEnabled is deprecated and ignored — use the --debug flag",
      );
    } else {
      errors.push("config.debugLogEnabled: must be a boolean");
    }
  }

  // ── strictMcpConfig ──
  if ("strictMcpConfig" in merged) {
    if (typeof merged.strictMcpConfig === "boolean") {
      config.strictMcpConfig = merged.strictMcpConfig;
    } else {
      errors.push("config.strictMcpConfig: must be a boolean");
    }
  }

  // ── showCost (display flag, default false — hidden) ──
  if ("showCost" in merged) {
    if (typeof merged.showCost === "boolean") {
      config.showCost = merged.showCost;
    } else {
      errors.push("config.showCost: must be a boolean");
    }
  }

  // ── temperature ──
  if ("temperature" in merged) {
    if (typeof merged.temperature === "number") {
      if (merged.temperature >= 0 && merged.temperature <= 2) {
        config.temperature = merged.temperature;
      } else {
        errors.push("config.temperature: must be between 0 and 2");
      }
    } else {
      errors.push("config.temperature: must be a number");
    }
  }

  // ── Nib extended fields (backward compat) ──

  // provider
  if ("provider" in merged) {
    if (typeof merged.provider === "string") {
      config.provider = merged.provider;
    } else {
      errors.push("config.provider: must be a string");
    }
  }

  // theme
  if ("theme" in merged) {
    if (isObject(merged.theme)) {
      const t = merged.theme as Record<string, unknown>;
      const themeConfig: DeepCodeSettings["theme"] = { mode: "dark" };
      if ("mode" in t && typeof t.mode === "string") {
        const mode = t.mode;
        if (mode === "dark" || mode === "light" || mode === "auto") {
          themeConfig.mode = mode;
        } else {
          themeConfig.mode = "dark";
          themeConfig.name = mode;
        }
      }
      if ("overrides" in t && isObject(t.overrides)) {
        themeConfig.overrides = t.overrides as Record<string, unknown>;
      }
      config.theme = themeConfig;
    } else {
      errors.push("config.theme: must be an object");
    }
  }

  // keybindings (pass through as-is for now)
  if ("keybindings" in merged) {
    if (isObject(merged.keybindings)) {
      config.keybindings = merged.keybindings as Record<string, unknown>;
    } else {
      errors.push("config.keybindings: must be an object");
    }
  }

  // workflow
  if ("workflow" in merged) {
    if (isObject(merged.workflow)) {
      config.workflow = merged.workflow as DeepCodeSettings["workflow"];
      const wf = merged.workflow as Record<string, unknown>;
      if ("gitCommands" in wf) {
        warnings.push(
          "workflow.gitCommands is deprecated and ignored — no git-command subsystem consumes it",
        );
      }
      if ("detectBuildTools" in wf) {
        warnings.push(
          "workflow.detectBuildTools is deprecated and ignored — no build-tool detection subsystem consumes it",
        );
      }
    } else {
      errors.push("config.workflow: must be an object");
    }
  }

  // compaction
  if ("compaction" in merged) {
    if (isObject(merged.compaction)) {
      config.compaction = merged.compaction as DeepCodeSettings["compaction"];
    } else {
      errors.push("config.compaction: must be an object");
    }
  }

  // contextWindow
  if ("contextWindow" in merged) {
    if (typeof merged.contextWindow === "number") {
      config.contextWindow = merged.contextWindow;
    } else {
      errors.push("config.contextWindow: must be a number");
    }
  }

  // commands
  if ("commands" in merged) {
    if (isObject(merged.commands)) {
      const c = merged.commands as Record<string, unknown>;
      const commands: NonNullable<DeepCodeSettings["commands"]> = {};
      if ("timeoutToBackground" in c) {
        if (typeof c.timeoutToBackground === "boolean") {
          commands.timeoutToBackground = c.timeoutToBackground;
        } else {
          errors.push("config.commands.timeoutToBackground: must be a boolean");
        }
      }
      config.commands = commands;
    } else {
      errors.push("config.commands: must be an object");
    }
  }

  // statusline
  if ("statusline" in merged) {
    const statusline = validateStatusline(merged.statusline, "config", errors);
    if (statusline) config.statusline = statusline;
  }

  // favoriteModels
  if ("favoriteModels" in merged) {
    if (Array.isArray(merged.favoriteModels)) {
      config.favoriteModels = merged.favoriteModels.filter((f): f is string => typeof f === "string");
      if (config.favoriteModels.length !== merged.favoriteModels.length) {
        errors.push("config.favoriteModels: all entries must be strings");
      }
    } else {
      errors.push("config.favoriteModels: must be an array of strings");
    }
  }

  // recentModels
  if ("recentModels" in merged) {
    if (Array.isArray(merged.recentModels)) {
      const recent: { id: string; at: number }[] = [];
      for (const item of merged.recentModels as unknown[]) {
        if (!isObject(item) || typeof item.id !== "string" || typeof item.at !== "number") {
          errors.push('config.recentModels: entries must be objects of shape { id: string, at: number }');
          continue;
        }
        recent.push({ id: item.id, at: item.at });
      }
      config.recentModels = recent;
    } else {
      errors.push("config.recentModels: must be an array");
    }
  }

  // ── Unknown field warnings ──
  for (const key of Object.keys(merged)) {
    if (!KNOWN_KEYS.has(key)) {
      warnings.push(`config: unknown field "${key}"`);
    }
  }

  return { config, warnings, errors, projectExecutionKeys };
}
