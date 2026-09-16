import { classifyImageSource } from "../image-source.js";

export type PermissionAction = "allow" | "ask" | "deny";
export type PatternKind = "exact" | "prefix" | "glob" | "any";
/**
 * "builtin-guarded" covers secret-adjacent paths (.env, ~/.ssh, ~/.aws,
 * credentials files): always resolves to "ask" (never silently auto-allowed
 * by posture or defaultMode: allowAll — see PermissionEngine's posture
 * bypass and resolveSubject), unlike "builtin-destructive" which denies.
 * Reading your own .env once is legitimate; silently exfiltrating it is not
 * — the guarantee is "a human always sees this," not "this never runs."
 */
export type RuleOrigin = "builtin-destructive" | "builtin-guarded" | "config" | "session";

export interface PermissionRule {
  tool: string;
  kind: PatternKind;
  pattern: string;
  action: PermissionAction;
  origin: RuleOrigin;
}

export interface PermissionSubject {
  tool: string;
  text: string;
  resolvedPath?: string;
}

export function matchesTool(ruleTool: string, subjectTool: string): boolean {
  if (ruleTool === "*") return true;
  if (ruleTool === "mcp__*") return subjectTool.startsWith("mcp__");
  return ruleTool === subjectTool;
}

/**
 * True when `textToken` equals `patternToken`, or extends it at a word
 * boundary (a non-alphanumeric character right after the shared prefix).
 * This lets a pattern's final token match real invocations like `~` against
 * `~/Documents` or `mkfs` against `mkfs.ext4`, while still rejecting
 * `commit` against `commitment-plan.sh` (extends mid-word, no boundary).
 */
function matchesTokenBoundary(patternToken: string, textToken: string): boolean {
  if (patternToken === textToken) return true;
  if (!textToken.startsWith(patternToken)) return false;
  const nextChar = textToken[patternToken.length];
  return nextChar !== undefined && !/[A-Za-z0-9]/.test(nextChar);
}

function matchesTokenSequence(patternTokens: string[], textTokens: string[]): boolean {
  if (patternTokens.length > textTokens.length) return false;
  for (let i = 0; i < patternTokens.length; i++) {
    const isLast = i === patternTokens.length - 1;
    if (isLast) {
      if (!matchesTokenBoundary(patternTokens[i], textTokens[i])) return false;
    } else if (patternTokens[i] !== textTokens[i]) {
      return false;
    }
  }
  return true;
}

function matchesPrefix(pattern: string, text: string): boolean {
  const patternTokens = pattern.trim().split(/\s+/).filter(Boolean);
  const textTokens = text.trim().split(/\s+/).filter(Boolean);
  return matchesTokenSequence(patternTokens, textTokens);
}

const SHORT_FLAG_CLUSTER = /^-[a-zA-Z]+$/;

/**
 * Merges the first run of consecutive single-dash short-flag tokens (e.g.
 * "-r", "-f", "-rf", "-fr") — wherever it starts, not necessarily
 * immediately after the first token, since some commands have a subcommand
 * before their flags ("git clean -fdx") — into one canonical cluster with
 * its letters lowercased and sorted. This makes "-fr"/"-rf"/"-r -f"/"-f -r"
 * (and their uppercase variants) all normalize identically before matching.
 * Long-form flags are mapped to their short equivalent first (see
 * LONG_FLAG_MAP) when the command is one we have a mapping for, so
 * "rm --recursive --force /" also normalizes to "rm -rf /". Flagless
 * arguments and tokens outside the run are left untouched; this only
 * targets the specific reordering/case/long-form evasion, not general
 * argument parsing.
 */
function normalizeShortFlagCluster(tokens: string[]): string[] {
  const command = tokens[0];
  const longMap = LONG_FLAG_MAP[command];
  const mapped = longMap ? tokens.map((t) => longMap[t] ?? t) : tokens;

  const startIdx = mapped.findIndex((t) => SHORT_FLAG_CLUSTER.test(t));
  if (startIdx === -1) return mapped;

  let endIdx = startIdx;
  let mergedFlags = "";
  while (endIdx < mapped.length && SHORT_FLAG_CLUSTER.test(mapped[endIdx])) {
    mergedFlags += mapped[endIdx].slice(1).toLowerCase();
    endIdx++;
  }

  const canonicalCluster = `-${[...mergedFlags].sort().join("")}`;
  return [...mapped.slice(0, startIdx), canonicalCluster, ...mapped.slice(endIdx)];
}

/**
 * Per-command long-form → short-flag equivalents, applied before
 * flag-cluster normalization so e.g. "rm --recursive --force /" folds to
 * the same canonical form as "rm -rf /". Deliberately a small, explicit,
 * per-binary table (each command's flag grammar differs) rather than a
 * generic getopt parser — scoped to exactly the flags the destructive/
 * guarded seed rules care about.
 */
const LONG_FLAG_MAP: Record<string, Record<string, string>> = {
  rm: { "--recursive": "-r", "--force": "-f" },
  git: { "--force": "-f", "--directory": "-d", "--ignored": "-x" },
};

/**
 * Resolves a token that may be a path-qualified command invocation
 * ("/usr/bin/rm", "./rm") down to its bare basename, and lowercases it, so
 * destructive-rule matching isn't defeated by absolute-path invocation or
 * case variation ("RM -RF /"). Only applied to the first (command) token —
 * arguments and paths elsewhere in the command are left case-sensitive,
 * since file paths on most filesystems are case-sensitive.
 */
function normalizeCommandToken(token: string): string {
  const base = token.includes("/") ? token.slice(token.lastIndexOf("/") + 1) : token;
  return base.toLowerCase();
}

/**
 * Command names where a suffix genuinely denotes the same family of tool
 * (mkfs.ext4/mkfs.vfat are all "mkfs"), so the command-name token is allowed
 * to boundary-extend like any other token. Every other single-token builtin
 * pattern requires an EXACT command-name match — "curl" must not match
 * "curl-config" (a real, unrelated, harmless tool bundled with libcurl;
 * confirmed present on a real machine during review), and there's no
 * general rule that distinguishes "legitimate tool-family variant" from
 * "different binary that happens to share a prefix" without an explicit list.
 */
const COMMAND_NAME_BOUNDARY_EXTENDABLE = new Set(["mkfs"]);

/**
 * Hardened prefix matching used only for builtin rules (origin
 * "builtin-destructive" or "builtin-guarded"): resolves the invoked command
 * to its lowercase basename and canonicalizes a leading short-flag cluster
 * before comparing, closing the absolute-path, case, and flag-reordering
 * evasions found during security review. Ordinary user-authored rules keep
 * matchesPrefix's literal semantics — this is deliberately not the default
 * so a user's own rule isn't silently reinterpreted.
 */
function matchesBuiltinPrefix(pattern: string, text: string): boolean {
  const patternTokens = pattern.trim().split(/\s+/).filter(Boolean);
  const textTokens = text.trim().split(/\s+/).filter(Boolean);
  if (textTokens.length === 0) return false;

  const normalizedText = normalizeShortFlagCluster([normalizeCommandToken(textTokens[0]), ...textTokens.slice(1)]);
  const normalizedPattern = normalizeShortFlagCluster([normalizeCommandToken(patternTokens[0]), ...patternTokens.slice(1)]);

  if (normalizedPattern.length === 1 && !COMMAND_NAME_BOUNDARY_EXTENDABLE.has(normalizedPattern[0])) {
    return normalizedText[0] === normalizedPattern[0];
  }

  return matchesTokenSequence(normalizedPattern, normalizedText);
}

function globToRegex(pattern: string): RegExp {
  const segs = pattern.split("/");
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
  let src = parts.join("/");
  src = src.replace(/__DOUBLESTAR__/g, ".*");
  return new RegExp(`^${src}$`);
}

export function patternMatches(rule: PermissionRule, subject: PermissionSubject): boolean {
  if (!matchesTool(rule.tool, subject.tool)) return false;

  switch (rule.kind) {
    case "any":
      return true;
    case "exact":
      // Use resolvedPath when available (file tools get it normalized by
      // PermissionEngine.relativizeSubject) so different spellings of the
      // same path match the same rule. Falls back to text for tools like
      // run_bash where resolvedPath is undefined.
      return rule.pattern === (subject.resolvedPath ?? subject.text);
    case "prefix":
      return rule.origin === "builtin-destructive" || rule.origin === "builtin-guarded"
        ? matchesBuiltinPrefix(rule.pattern, subject.text)
        : matchesPrefix(rule.pattern, subject.text);
    case "glob": {
      const target = subject.resolvedPath ?? subject.text;
      return globToRegex(rule.pattern).test(target);
    }
    default:
      return false;
  }
}

export function globSpecificity(pattern: string): number {
  const segs = pattern.split("/");
  let score = 0;
  for (const s of segs) {
    if (s === "**") score += 1;
    else if (s.includes("*") || s.includes("?")) score += 5;
    else score += 50;
  }
  return Math.min(score, 490);
}

export function specificity(rule: PermissionRule): number {
  switch (rule.kind) {
    case "exact":
      return 1000 + rule.pattern.length;
    case "prefix":
      return 500 + rule.pattern.trim().split(/\s+/).filter(Boolean).length * 10;
    case "glob":
      return globSpecificity(rule.pattern);
    case "any":
      return 0;
  }
}

/** One canonical subject-text extraction shared by audit, UI, and matching. */
export function extractToolSubject(toolName: string, args: Record<string, unknown>): string {
  if (toolName === "run_bash") {
    const c = args?.command;
    return typeof c === "string" ? c : "";
  }
  if (toolName === "web_search") {
    const q = args?.query;
    return typeof q === "string" ? q : "";
  }
  if (toolName === "web_fetch" || toolName === "view_image") {
    const u = args?.url;
    return typeof u === "string" ? u : "";
  }
  if (toolName === "apply_patch") {
    const patch = args?.patch;
    if (typeof patch !== "string") return "";
    return [...patch.matchAll(/^\+\+\+ b\/(.+)$/gm)]
      .map((match) => match[1].trim())
      .filter(Boolean)
      .join(", ");
  }
  // search's directory arg is `dir` (defaults to "." — the tool handler's
  // own default, mirrored here so an omitted dir resolves to the workspace
  // rather than to an empty/unmatchable subject). glob's is `cwd` (defaults
  // to ctx.workingDir at call time; "." resolves the same way here since
  // PermissionEngine.normalizePath resolves relative paths against
  // workingDir too).
  if (toolName === "search") {
    const d = args?.dir;
    return typeof d === "string" && d ? d : ".";
  }
  if (toolName === "glob") {
    const c = args?.cwd;
    return typeof c === "string" && c ? c : ".";
  }
  const raw = args?.path ?? args?.filePath;
  return typeof raw === "string" ? raw : "";
}

/** Best-effort hostname extraction for web_fetch's domain-scoped permission rules. Returns undefined for an unparsable URL rather than throwing — matching just falls through to "no match" in that case. */
export function extractHostname(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

export function buildSubject(tool: string, args: Record<string, unknown>): PermissionSubject {
  if (tool === "run_bash" || tool === "web_search") {
    return { tool, text: extractToolSubject(tool, args) };
  }
  if (tool === "web_fetch") {
    const text = extractToolSubject(tool, args);
    return { tool, text, resolvedPath: extractHostname(text) };
  }
  if (tool === "view_image") {
    // A remote target is scoped by hostname, a local one by path — see
    // classifyImageSource. Shaping a path as a hostname (or the reverse) would
    // apply rules that can never match the actual target, silently falling
    // through to a broader decision than the user approved.
    const text = extractToolSubject(tool, args);
    return classifyImageSource(text).kind === "remote"
      ? { tool, text, resolvedPath: extractHostname(text) }
      : { tool, text, resolvedPath: text || undefined };
  }
  const text = extractToolSubject(tool, args);
  return { tool, text, resolvedPath: text || undefined };
}

const PREFIX_SUFFIX = ":*";

export function parseRulePattern(kind: PatternKind, onDiskPattern: string): string {
  if (kind === "prefix" && onDiskPattern.endsWith(PREFIX_SUFFIX)) {
    return onDiskPattern.slice(0, -PREFIX_SUFFIX.length);
  }
  return onDiskPattern;
}

export function serializeRulePattern(kind: PatternKind, pattern: string): string {
  if (kind === "prefix") return `${pattern}${PREFIX_SUFFIX}`;
  return pattern;
}
