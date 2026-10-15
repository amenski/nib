import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { detectWrapper, extractQuotedArgLoose, splitCompound } from "../bash-normalize.js";
import { classifyCommandSegment, tokenize } from "../command-classifier.js";
import { normalizeShortFlagCluster, type PermissionAction, type PermissionRule } from "../rules.js";

/**
 * The deterministic feature vector behind the risk classifier
 * (docs/command-risk-classifier.md §4). Pure, cheap and filesystem-free: path
 * arithmetic only, no reads, no model calls, no clock. Everything the rules
 * component (§5) asks about is computed here once, so a rule is a predicate
 * over data rather than a second parser.
 *
 * The vector is persisted on the permission audit row, which is what makes a
 * verdict replayable from the session log. That also makes it the one part of
 * this module that leaves the process, so `targets[].raw` and `secretRefs`
 * carry the text the redactor in sessions/store.ts must scrub (§8).
 */

export type RiskToolKind = "shell" | "path-write" | "path-read" | "network" | "spawn" | "mcp" | "other";

/** §4.1: how far the conservative tokenizer got. Never "parsed" by assumption. */
export type RiskParseStatus = "parsed" | "partial" | "failed";

/**
 * §4.2 `targets`. `build-dir` is a flavour of `inside-cwd` split out because
 * "deleting a build directory" is ordinary agent work, not a pre-session file
 * loss (§5.3), while every other path class is treated the same way by the
 * benign/confirm boundary.
 */
export type RiskTargetClass =
  | "inside-cwd"
  | "build-dir"
  | "write-root"
  | "home"
  | "system"
  | "critical"
  | "unknown";

export interface RiskTarget {
  /** The token as written, quoted. Persisted — goes through the redactor. */
  raw: string;
  /** Lexically resolved (no symlink chase: the rules only need the spelling). */
  resolved: string;
  class: RiskTargetClass;
}

export interface RiskRedirect {
  op: string;
  target: string;
  /** A heredoc: its body is data, not a file write, so it never counts as one. */
  heredoc: boolean;
  /** Filled in once the target context is known; see shellFeatures. */
  class?: RiskTargetClass;
}

/** §4.2 — program semantics for one independent segment, after wrapper strip. */
export interface SegmentFeatures {
  text: string;
  program: string;
  /** Subcommand for the multi-verb programs in VERB_PROGRAMS. */
  verb?: string;
  readOnly: boolean;
  writesFs: boolean;
  deletes: boolean;
  /** Recursive force: `rm -r -f`, `chmod -R`, or a directory-wide `find -delete`. */
  recursiveForce: boolean;
  targets: RiskTarget[];
  /** Anything that reaches the network (§4.2 `net`). */
  net: boolean;
  /** The subset the engine already guards with an ask (curl/wget/nc/ssh/…). */
  netEgress: boolean;
  pkgInstall: boolean;
  pkgFromLock: boolean;
  pkgPublish: boolean;
  /** §4.2 `gitDiscard` tags; the block subset is in rules.ts. */
  gitDiscard: string[];
  gitRemoteWrite: boolean;
  gitAmend: boolean;
  infraDestroy: boolean;
  privEsc: boolean;
  /** §4.2 `disarm`: flags that turn a security check off. */
  disarm: string[];
  /** §4.2 `secretRef`: tokens naming a credential-ish path or variable. */
  secretRefs: string[];
  findDelete: boolean;
  findMtime: boolean;
}

/** §4.3 — the path-shaped half of the non-shell tools. */
export interface PathFeatures {
  raw: string;
  resolved: string;
  class: "cwd" | "write-root" | "outside" | "home" | "system" | "unknown";
  /** Set only for the protected paths of §4.3, which no allow rule may cover. */
  protectedPath?: "git" | "nib" | "shell-rc" | "npmrc" | "husky" | "vscode" | "ci";
  secretRef: boolean;
  networkPath: boolean;
}

/** §4.3 — web_fetch/view_image targets. */
export interface HostFeatures {
  host: string;
  scheme: string;
  class: "public" | "private" | "metadata" | "localhost" | "unknown";
}

export interface RiskFeatures {
  tool: string;
  kind: RiskToolKind;

  // ── §4.1 shell structure ──
  parse: RiskParseStatus;
  segments: SegmentFeatures[];
  redirects: RiskRedirect[];
  /** Wrapper names stripped before the program token, e.g. ["sudo", "timeout"]. */
  wrappers: string[];
  interpreter?: string;
  /** True when the interpreter was handed an inline script (`-c`/`-e`). */
  interpreterInline: boolean;
  runner?: string;
  expansion: boolean;
  /**
   * The `$(…)`, backtick and `<(…)` subset of `expansion` — a body whose text
   * is not the argv that runs. §5.2's `shell.expansion` confirm is scoped to
   * this rather than to every `${VAR}`: a parameter expansion the surrounding
   * words make visible is not the same hazard.
   */
  substitution: boolean;
  glob: boolean;
  absBinary: boolean;
  envAssign?: { name: string; value: string; safe: boolean };
  specialVars: string[];
  longCommand: boolean;

  // ── cross-segment (§4.2 features that are not properties of one segment) ──
  pipeToShell: boolean;
  secretEgress: boolean;
  tmpWildcardDelete: boolean;
  preSessionTarget: boolean;
  /** Variables a `rm -rf "$VAR"`-shaped target depends on but the command never sets. */
  unassignedVars: string[];

  // ── §4.3 non-shell ──
  path?: PathFeatures;
  host?: HostFeatures;
  /** new_task's description, scanned at spawn time. */
  spawnText?: string;
  /** The mutating verb in an mcp__* tool name, when there is one. */
  mcpVerb?: string;
  /** edit/write: the diff removed an assertion from a security-relevant test. */
  deletesTests?: boolean;
}

export interface RiskInput {
  tool: string;
  args: Record<string, unknown>;
  workingDir: string;
  writeRoots: readonly string[];
  sandbox: { level: "strict-sandbox" | "workspace-write" | "unrestricted"; contained: boolean };
  /** sandbox/unsandboxed.ts result: how this call leaves the sandbox, if it does. */
  unsandboxed?: "requested" | "excluded";
  engine: {
    action: PermissionAction;
    winningRule?: PermissionRule;
    wasUnresolved: boolean;
    isGuarded: boolean;
  };
  session: {
    headless: boolean;
    /** Last N user turns, text only. Stage 2 only; never tool results (§3.1). */
    userMessages: string[];
    createdThisSession: Set<string>;
    gitRemotesAtStart: string[];
  };
}

// ── program vocabularies (§4.1, §4.2) ──

const SHELL_TOOLS = new Set(["run_bash", "run_bash_background"]);
const PATH_WRITE_TOOLS = new Set([
  "edit", "edit_file", "write_to_file", "apply_patch", "apply_diff", "search_replace",
]);
const PATH_READ_TOOLS = new Set(["read_file", "list_files", "glob", "search"]);
const NETWORK_TOOLS = new Set(["web_fetch", "view_image", "web_search"]);

const WRAPPERS = ["sudo", "env", "timeout", "nice", "nohup", "xargs", "command"];
const WRAPPER_SET = new Set(WRAPPERS);

const INTERPRETERS = new Set([
  "sh", "bash", "zsh", "fish", "ksh", "node", "ruby", "perl", "php", "python", "python2", "python3", "eval", "source", ".", "deno", "bun",
]);

const VERB_PROGRAMS = new Set([
  "git", "npm", "pnpm", "yarn", "bun", "pip", "pip3", "cargo", "docker", "kubectl", "gh", "terraform", "aws", "gcloud", "az",
]);

/** §4.2 `writesFs` programs. `sed` only counts with `-i` (see writesFsFor). */
const WRITE_PROGRAMS = new Set([
  "rm", "mv", "cp", "mkdir", "touch", "chmod", "chown", "ln", "dd", "tee", "truncate", "shred", "sed", "install", "rsync", "unzip", "tar", "find",
]);

const DELETE_PROGRAMS = new Set(["rm", "rmdir", "shred", "trash"]);

/** §4.2 `recursiveForce`: programs whose `-R` makes the target whole trees. */
const RECURSIVE_MUTATORS = new Set(["chmod", "chown", "chgrp"]);

/** §4.2 `net` programs. The engine guards only NET_EGRESS_PROGRAMS with an ask. */
const NET_PROGRAMS = new Set([
  "curl", "wget", "nc", "ncat", "netcat", "ssh", "scp", "sftp", "rsync", "ftp", "telnet", "socat", "nc.openbsd",
]);
const NET_EGRESS_PROGRAMS = new Set(["curl", "wget", "nc", "ncat", "netcat", "ssh", "scp", "rsync"]);

const PKG_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun", "pip", "pip3", "cargo", "brew", "apt", "apt-get", "gem", "pub"]);

/** §4.1 `runner`: opaque launchers whose inner command is not trusted either way. */
const RUNNER_PROGRAMS = new Set(["npx", "bunx", "devbox", "direnv", "make"]);

/** §4.1 `envAssign` safe list: assignments that cannot redirect execution. */
const SAFE_ENV_VARS = new Set(["NODE_ENV", "CI", "DEBUG", "FORCE_COLOR"]);

/** §4.1 `specialVar`. */
const SPECIAL_VARS = new Set(["PATH", "IFS", "LD_PRELOAD", "HOME"]);

/** §5.3: deleting these is ordinary work, not a pre-session file loss. */
const BUILD_DIRS = new Set(["node_modules", "dist", "build", ".dart_tool", "target", "out", "coverage"]);

/** §4.2 `secretRef` path-shaped tokens. */
const SECRET_TOKEN_RE = /(^|[/\\])\.env(\.|$)|(^|[/\\])\.ssh([/\\]|$)|(^|[/\\])\.aws([/\\]|$)|(^|[/\\])id_rsa|\.pem$|(^|[/\\])credentials|(^|[/\\])\.npmrc$|(^|[/\\])\.netrc$|Keychains|169\.254\.169\.254/;

/** §4.2 `secretRef` variable-shaped tokens: $GITHUB_TOKEN, ${AWS_SECRET_KEY}, …. */
const SECRET_VAR_RE = /^"?\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?"?$/;

const SECRET_VAR_NAMES = /(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|CREDENTIAL)/i;

/** §4.3 protected paths. Matched against the cwd-relative or absolute spelling. */
const PROTECTED_PATH_RULES: [RegExp, NonNullable<PathFeatures["protectedPath"]>][] = [
  [/(^|[/\\])\.git([/\\]|$)/, "git"],
  [/(^|[/\\])\.nib[/\\]settings\.json$/, "nib"],
  [/(^|[/\\])\.(bashrc|bash_profile|zshrc|zprofile|profile)$/, "shell-rc"],
  [/(^|[/\\])\.npmrc$/, "npmrc"],
  [/(^|[/\\])\.husky([/\\]|$)/, "husky"],
  [/(^|[/\\])\.vscode([/\\]|$)/, "vscode"],
  [/(^|[/\\])\.github[/\\]workflows([/\\]|$)/, "ci"],
];

const MCP_MUTATING_VERB_RE = /(^|_)(delete|remove|destroy|drop|purge|send|post|publish|merge|approve)(_|$)/;

const INTERPRETER_INLINE_FLAGS = new Set(["-c", "-e", "--eval", "-p", "--print"]);

// ── small shared helpers ──

function basenameLower(token: string): string {
  const slash = token.lastIndexOf("/");
  return (slash === -1 ? token : token.slice(slash + 1)).toLowerCase();
}

function pathWithin(dir: string, path: string): boolean {
  const rel = relative(dir, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function stripQuotes(token: string): string {
  return token.replace(/["']/g, "");
}

function nonFlagTokens(tokens: string[]): string[] {
  return tokens.filter((t) => !t.startsWith("-"));
}

/**
 * §4.2 `recursiveForce`. Short flags are merged through rules.ts's
 * `normalizeShortFlagCluster` so `-r -f`, `-fr`, `-RF` and `rm --recursive
 * --force` all answer the same question the destructive rules already ask.
 * Long-form flags outside that helper's per-command map are folded here for
 * the two programs whose long spellings matter.
 */
function hasRecursiveForce(tokens: string[]): boolean {
  const program = basenameLower(tokens[0] ?? "");
  const longFolded = tokens.map((t) => {
    if (program === "rm" && (t === "--recursive" || t === "--force")) return t === "--recursive" ? "-r" : "-f";
    return t;
  });
  const merged = normalizeShortFlagCluster([program, ...longFolded.slice(1)]);
  const cluster = merged.find((t) => /^-[a-zA-Z]+$/.test(t));
  if (!cluster) return false;
  const letters = cluster.slice(1);
  return letters.includes("r") && letters.includes("f");
}

/** §4.2 `recursiveForce` for `chmod -R`-style mutators: any `-R`/`--recursive`. */
function hasRecursiveFlag(tokens: string[]): boolean {
  return tokens.some((t) => /^-[a-zA-Z]*[rR][a-zA-Z]*$/.test(t) || t === "--recursive");
}

// ── redirects (§4.1) ──

/**
 * Extracts top-level redirects from one segment and returns the segment with
 * them removed, so the conservative tokenizer sees only the command words.
 * Without this, `make test 2>&1 | tee build.log` would fail tokenization on
 * the `>` and be reported as a parse failure (§7) — a confirm for the most
 * ordinary line in a build script.
 *
 * Ignored by construction: `2>&1`-style fd duplication and `/dev/null`
 * targets are returned as redirects but never count as file writes (see
 * isFileWriteRedirect). A heredoc is recorded and its body left alone: its
 * lines become their own segments, which is imprecise but fail-closed — an
 * unparseable body reports a parse failure rather than a clean read.
 */
function stripRedirects(segment: string): { cleaned: string; redirects: RiskRedirect[] } {
  const redirects: RiskRedirect[] = [];
  let cleaned = "";
  let i = 0;
  let quote: "'" | '"' | null = null;

  while (i < segment.length) {
    const ch = segment[i];
    if (quote) {
      cleaned += ch;
      if (ch === quote) quote = null;
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      cleaned += ch;
      i++;
      continue;
    }

    const parsed = matchRedirect(segment, i);
    if (parsed) {
      redirects.push(parsed.redirect);
      i = parsed.end;
      continue;
    }

    cleaned += ch;
    i++;
  }

  return { cleaned: cleaned.trim(), redirects };
}

/** Matches a redirect operator (and its target) at `start`, or returns null. */
function matchRedirect(segment: string, start: number): { redirect: RiskRedirect; end: number } | null {
  let i = start;
  const opMatch = /^(\d*)(<<-?|>>|>&|>|<&|>|<)/.exec(segment.slice(i));
  if (!opMatch) return null;

  const [opText, fd, symbol] = opMatch;
  i += opText.length;

  // `>&2`, `<&-`: fd duplication, not a file.
  if ((symbol === ">&" || symbol === "<&") && /^\s*[\d-]/.test(segment.slice(i))) {
    i += segment.slice(i).match(/^\s*[\d-]+/)![0].length;
    return { redirect: { op: opText.trim(), target: "", heredoc: false }, end: i };
  }

  // Heredoc: the delimiter is a word, and the body is data.
  if (symbol === "<<-" || symbol === "<<") {
    const rest = segment.slice(i);
    const delim = /^\s*(?:['"]?)([A-Za-z_][A-Za-z0-9_]*)(?:['"]?)/.exec(rest);
    const consumed = delim ? delim[0].length : 0;
    return {
      redirect: { op: `${fd}${symbol}`, target: delim?.[1] ?? "", heredoc: true },
      end: i + consumed,
    };
  }

  const rest = segment.slice(i);
  const gap = rest.match(/^\s*/)![0].length;
  i += gap;
  if (i >= segment.length) return { redirect: { op: `${fd}${symbol}`, target: "", heredoc: false }, end: i };

  let target = "";
  const q = segment[i];
  if (q === "'" || q === '"') {
    const close = segment.indexOf(q, i + 1);
    const end = close === -1 ? segment.length : close + 1;
    target = segment.slice(i, end);
    i = end;
  } else {
    const m = /^[^\s;|&<>]+/.exec(segment.slice(i));
    target = m ? m[0] : "";
    i += target.length;
  }
  return { redirect: { op: `${fd}${symbol}`, target, heredoc: false }, end: i };
}

/** A redirect that writes a real file, as opposed to `2>&1` or `/dev/null`. */
export function isFileWriteRedirect(r: RiskRedirect): boolean {
  if (r.heredoc) return false;
  if (!r.target) return false;
  if (r.op.startsWith("<")) return false;
  return stripQuotes(r.target) !== "/dev/null";
}

// ── target classification (§4.2 `targets`) ──

interface TargetContext {
  workingDir: string;
  writeRoots: readonly string[];
  /** Variables assigned anywhere in the same command, as written. */
  vars: Map<string, string>;
}

interface ClassifyOpts {
  /**
   * Whether the working directory itself counts as critical for this command.
   * True for the programs that can consume it — `rm -rf .` deletes the tree
   * the session is standing in — and false for the others, where `.` is just
   * the root of a search (`find . -delete` matches files, it does not remove
   * the directory).
   */
  cwdCritical: boolean;
}

function classifyTarget(raw: string, ctx: TargetContext, opts: ClassifyOpts): RiskTarget {
  const cleaned = stripQuotes(raw);
  const globStripped = cleaned.replace(/\/?\*+$/, "");
  const base = globStripped !== cleaned;
  const body = (base ? globStripped : cleaned).replace(/\/$/, "");

  const cls = classifyBase(body, base, ctx, 0, opts);
  return { raw, resolved: resolveTargetPath(body, ctx), class: cls };
}

function classifyBase(
  body: string,
  hadTrailingGlob: boolean,
  ctx: TargetContext,
  depth: number,
  opts: ClassifyOpts,
): RiskTargetClass {
  if (depth > 4) return "unknown";
  // `/*`: the root's children, with nothing naming what they are.
  if (body === "" || body === "/") return "critical";
  // Command substitution as the whole target: unknowable, so fail closed.
  if (body.includes("$(") || body.includes("`")) return "critical";

  // `${VAR:?}` / `${VAR?msg}` is bash's "die if unset" form: the variable the
  // command depends on cannot be empty, which is exactly the hazard row 12 of
  // §10.1 blocks for the unguarded `"$VAR"/*`. Not resolvable either way, so
  // the critical-path rule cannot claim it and the pre-session delete rule
  // reports it instead.
  if (/^\$\{[A-Za-z_][A-Za-z0-9_]*[?:]/.test(body)) return "unknown";

  const varMatch = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/.exec(body);
  if (varMatch) {
    const name = varMatch[1];
    if (name === "PWD" || name === "OLDPWD") return "critical";
    const assigned = ctx.vars.get(name);
    if (assigned === undefined) return hadTrailingGlob ? "critical" : "unknown";
    const value = stripQuotes(assigned);
    if (value === "$(pwd)" || value === "`pwd`" || value === "${PWD}" || value === "$PWD") return "critical";
    if (value.includes("$") || value.includes("`")) return "unknown";
    return classifyBase(value, hadTrailingGlob, ctx, depth + 1, opts);
  }

  return classifyLiteral(resolveTargetPath(body, ctx), ctx, hadTrailingGlob, opts);
}

function resolveTargetPath(body: string, ctx: TargetContext): string {
  const cleaned = stripQuotes(body);
  if (cleaned === "~") return homedir();
  if (cleaned.startsWith("~/")) return join(homedir(), cleaned.slice(2));
  if (cleaned === "" || cleaned === ".") return ctx.workingDir;
  return isAbsolute(cleaned) ? cleaned : resolve(ctx.workingDir, cleaned);
}

function classifyLiteral(abs: string, ctx: TargetContext, hadTrailingGlob: boolean, opts: ClassifyOpts): RiskTargetClass {
  if (abs === "/") return "critical";
  if (dirname(abs) === "/") return "critical";
  if (abs === homedir()) return "critical";
  // The cwd, and everything above it. Deleting the directory the session is
  // standing in is not recoverable from inside it — but only for the programs
  // that would actually do it (see ClassifyOpts.cwdCritical).
  if (abs === ctx.workingDir) return opts.cwdCritical ? "critical" : "inside-cwd";
  if (pathWithin(abs, ctx.workingDir)) return "critical";
  if (pathWithin(homedir(), abs)) return hadTrailingGlob && abs === homedir() ? "critical" : "home";
  if (pathWithin(ctx.workingDir, abs)) {
    const first = relative(ctx.workingDir, abs).split("/")[0];
    return BUILD_DIRS.has(first) ? "build-dir" : "inside-cwd";
  }
  if (ctx.writeRoots.some((root) => pathWithin(root, abs))) return "write-root";
  return isAbsolute(abs) ? "system" : "inside-cwd";
}

// ── wrapper stripping (§4.1 `wrappers`) ──

interface StrippedSegment {
  program: string;
  tokens: string[];
  wrappers: string[];
  envAssigns: [string, string][];
}

/**
 * Removes the leading wrappers and environment assignments §4.1 names, so
 * `sudo rm -rf /`, `FOO=1 rm -rf /` and `timeout 30 npm test` present the same
 * program to the rules. Bounded on purpose: only the flag/argument shapes of
 * these wrappers are consumed (`timeout`'s duration, `nice`'s adjustment,
 * `sudo -u user`), and an unrecognized shape stops the walk with the wrapper
 * recorded — the rules then see a program they do not recognize rather than a
 * wrong one.
 *
 * An assignment ending in an operator is a statement of its own
 * (`D=$(pwd); rm -rf "$D"`), not a prefix, and ends the walk untouched.
 */
function stripWrappers(tokens: string[]): StrippedSegment {
  const wrappers: string[] = [];
  const envAssigns: [string, string][] = [];
  let i = 0;

  for (;;) {
    const token = tokens[i];
    if (token === undefined) break;

    const assign = /^([A-Za-z_][A-Za-z0-9_]*)=(.+)$/.exec(token);
    if (assign && !/[;&|]$/.test(token)) {
      envAssigns.push([assign[1], assign[2]]);
      i++;
      continue;
    }

    const name = basenameLower(token);
    if (!WRAPPER_SET.has(name)) break;

    wrappers.push(name);
    i++;
    while (tokens[i]?.startsWith("-")) i++;
    if (name === "timeout" && tokens[i] && /^[\d.]+[smhd]?$/.test(tokens[i])) i++;
    if (name === "nice" && tokens[i] && /^-?\d+$/.test(tokens[i])) i++;
  }

  return { program: basenameLower(tokens[i] ?? ""), tokens: tokens.slice(i), wrappers, envAssigns };
}

/**
 * Splits a whole command into its leading wrappers/assignments and the rest.
 *
 * The wrapper strip has to happen on the *command*, before `detectWrapper`,
 * not only per segment: `FOO=1 bash -c 'rm -rf ~'` does not begin with `bash`,
 * so the unwrap that catches `bash -c 'rm -rf ~'` would miss it and the call
 * would fall through to a weaker verdict. Doing it here is what makes §5.1's
 * "sudo rm, FOO=1 rm and bash -c 'rm …' all hit" true of a wrapped compound
 * and not just of a bare program.
 */
function splitLeading(text: string): StrippedSegment & { rest: string } {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  const stripped = stripWrappers(tokens);
  const consumed = tokens.length - stripped.tokens.length;
  return { ...stripped, rest: tokens.slice(consumed).join(" ") };
}

function toEnvAssign(pair: [string, string] | undefined): RiskFeatures["envAssign"] {
  if (!pair) return undefined;
  return { name: pair[0], value: pair[1], safe: SAFE_ENV_VARS.has(pair[0]) };
}

// ── per-segment semantics (§4.2) ──

function collectVars(segments: string[]): Map<string, string> {
  const vars = new Map<string, string>();
  for (const segment of segments) {
    const tokens = tokenize(segment.trim());
    const source = tokens ?? segment.trim().split(/\s+/);
    for (const token of source) {
      const assign = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(token);
      if (assign && assign[2] !== "") vars.set(assign[1], assign[2]);
    }
  }
  return vars;
}

function gitDiscardTags(tokens: string[]): string[] {
  const sub = tokens[1]?.toLowerCase();
  const tags: string[] = [];
  const has = (flag: string) => tokens.some((t) => t === flag);

  if (sub === "reset" && has("--hard")) tags.push("reset-hard");
  if (sub === "checkout" && tokens.includes("--")) tags.push("checkout-dot");
  if (sub === "restore" && (tokens.includes("--") || tokens.includes("."))) tags.push("restore-dot");
  if (sub === "clean" && hasRecursiveForce([tokens[0], ...tokens.slice(1).filter((t) => t !== "-d" && t !== "-x")])) {
    tags.push("clean-force");
  }
  if (sub === "stash" && ["drop", "clear"].includes(tokens[2]?.toLowerCase() ?? "")) tags.push("stash-drop");
  if (sub === "branch" && has("-D")) tags.push("branch-delete");
  if (sub === "push") {
    if (has("--force") || has("-f")) tags.push("push-force");
    if (has("--force-with-lease")) tags.push("push-force-lease");
    if (has("--delete") || has("-d")) tags.push("push-delete");
  }
  return tags;
}

function disarmFlags(tokens: string[], program: string): string[] {
  const found: string[] = [];
  for (const token of tokens) {
    if (token === "--insecure" || token === "--no-verify" || token === "--no-sandbox" || token === "--dangerously-skip-permissions") {
      found.push(token);
    }
    if (program === "curl" && /^-[a-zA-Z]*k[a-zA-Z]*$/.test(token)) found.push("-k");
  }
  if (tokens.some((t) => t.startsWith("GIT_SSL_NO_VERIFY="))) found.push("GIT_SSL_NO_VERIFY");
  if (tokens.some((t) => t.startsWith("NODE_TLS_REJECT_UNAUTHORIZED="))) found.push("NODE_TLS_REJECT_UNAUTHORIZED");
  return found;
}

function secretRefsIn(tokens: string[]): string[] {
  const found: string[] = [];
  for (const token of tokens) {
    const bare = stripQuotes(token);
    if (SECRET_TOKEN_RE.test(bare)) {
      found.push(bare);
      continue;
    }
    const varMatch = SECRET_VAR_RE.exec(bare);
    if (varMatch && SECRET_VAR_NAMES.test(varMatch[1])) found.push(bare);
  }
  return found;
}

function segmentFeatures(
  segment: string,
  redirects: RiskRedirect[],
  ctx: TargetContext,
  outerWrappers: readonly string[],
): SegmentFeatures {
  const tokens = tokenize(segment) ?? segment.trim().split(/\s+/).filter(Boolean);
  const { program, tokens: after, wrappers, envAssigns } = stripWrappers(tokens);
  const args = after.slice(1);
  const verb = VERB_PROGRAMS.has(program) && args[0] && !args[0].startsWith("-") ? args[0].toLowerCase() : undefined;

  const targets = collectTargets(program, after, ctx);
  const findDelete = program === "find" && args.includes("-delete");
  const findMtime = program === "find" && args.some((t) => t === "-mtime" || t === "-mmin");

  const net =
    NET_PROGRAMS.has(program) ||
    (program === "openssl" && args.includes("s_client")) ||
    (program === "git" && ["push", "fetch", "pull", "clone"].includes(verb ?? "")) ||
    (program === "npm" && verb === "publish") ||
    (program === "docker" && verb === "push") ||
    (program === "aws" && args.some((t) => t.startsWith("s3://")));

  return {
    text: segment,
    program,
    verb,
    readOnly: classifyCommandSegment(segment).classification === "proven-read-only",
    writesFs: writesFiles(program, after, redirects),
    deletes: DELETE_PROGRAMS.has(program) || findDelete || (program === "git" && verb === "clean"),
    recursiveForce: hasRecursiveForce(after) || (RECURSIVE_MUTATORS.has(program) && hasRecursiveFlag(args)) || findDelete,
    targets,
    net,
    netEgress: NET_EGRESS_PROGRAMS.has(program),
    pkgInstall: isPkgInstall(program, verb),
    pkgFromLock: isPkgFromLock(program, verb, args),
    pkgPublish: isPkgPublish(program, verb),
    gitDiscard: program === "git" ? gitDiscardTags(after) : [],
    gitRemoteWrite: program === "git" && verb === "remote" && ["add", "set-url"].includes(args[1]?.toLowerCase() ?? ""),
    gitAmend: program === "git" && verb === "commit" && args.includes("--amend"),
    infraDestroy: isInfraDestroy(program, verb, args),
    privEsc:
      outerWrappers.includes("sudo") ||
      wrappers.includes("sudo") ||
      ["su", "doas", "launchctl", "systemctl"].includes(program) ||
      (program === "chmod" && args.some((t) => t === "+s" || t === "u+s" || t === "g+s")) ||
      (program === "crontab" && args.some((t) => /^-[er]$/.test(t))),
    disarm: disarmFlags(after, program),
    secretRefs: secretRefsIn(after),
    findDelete,
    findMtime,
  };
}

function writesFiles(program: string, tokens: string[], redirects: RiskRedirect[]): boolean {
  if (redirects.some(isFileWriteRedirect)) return true;
  // `sed` only writes with -i; every other writer in the list writes by
  // default (rm included — deleting is a write to the filesystem).
  if (program === "sed") return tokens.some((t) => /^-[a-zA-Z]*i[a-zA-Z]*$/.test(t) || t === "--in-place");
  return WRITE_PROGRAMS.has(program);
}

function collectTargets(program: string, tokens: string[], ctx: TargetContext): RiskTarget[] {
  const destructive = DELETE_PROGRAMS.has(program) || RECURSIVE_MUTATORS.has(program);
  if (!destructive && program !== "find") return [];
  // Skip the verb for programs whose second token names an operation, and
  // every flag; what remains is the path list the rules care about.
  const opts: ClassifyOpts = { cwdCritical: destructive };
  const candidates = tokens.slice(1).filter((t) => !t.startsWith("-"));
  return candidates.map((raw) => classifyTarget(raw, ctx, opts));
}

function isPkgInstall(program: string, verb?: string): boolean {
  if (program === "npm" || program === "pnpm" || program === "yarn") return verb === "install" || verb === "i" || verb === "ci" || verb === "add";
  if (program === "bun") return verb === "install" || verb === "add";
  if (program === "pip" || program === "pip3") return verb === "install";
  if (program === "cargo") return verb === "add" || verb === "install";
  if (program === "brew") return verb === "install";
  if (program === "apt" || program === "apt-get") return verb === "install";
  if (program === "gem") return verb === "install";
  if (program === "pub") return verb === "get";
  return false;
}

/**
 * §4.2 `pkgFromLock`: an install with no package named — the dependencies come
 * from a lock/manifest the repository already pins. Claude Code allows these
 * by default (§1.4), and §5.3 counts them benign.
 */
function isPkgFromLock(program: string, verb: string | undefined, args: string[]): boolean {
  if (!PKG_MANAGERS.has(program)) return false;
  if (program === "pub") return verb === "get";
  if (program === "pip" || program === "pip3") {
    return verb === "install" && (args.length <= 1 || args.includes("-r") || args.includes("--requirement"));
  }
  if (program === "gem" || program === "brew" || program === "apt" || program === "apt-get" || program === "cargo") {
    return false;
  }
  if (verb === "ci") return true;
  // `npm install` with no package name, or only flags/scripts.
  const named = nonFlagTokens(args.slice(1)).length;
  return (verb === "install" || verb === "i") && named === 0;
}

function isPkgPublish(program: string, verb?: string): boolean {
  if (program === "npm" || program === "pnpm" || program === "yarn") return verb === "publish";
  if (program === "cargo") return verb === "publish";
  if (program === "gem") return verb === "push";
  if (program === "docker") return verb === "push";
  if (program === "twine") return verb === "upload";
  return false;
}

function isInfraDestroy(program: string, verb: string | undefined, args: string[]): boolean {
  if (["terraform", "pulumi", "cdk"].includes(program)) return verb === "destroy";
  if (program === "kubectl") return verb === "delete";
  if (program === "aws") return args.some((t) => /^delete-/.test(t));
  if (program === "gcloud") return args.some((t) => t === "delete" || /-delete$/.test(t));
  return false;
}

// ── non-shell tools (§4.3) ──

function pathFeaturesOf(tool: string, args: Record<string, unknown>, ctx: TargetContext): PathFeatures | undefined {
  const raw = typeof args.path === "string" ? args.path : typeof args.filePath === "string" ? args.filePath : undefined;
  if (raw === undefined) return undefined;

  const target = classifyTarget(raw, ctx, { cwdCritical: false });
  const cls: PathFeatures["class"] =
    target.class === "critical" ? "system" : (target.class as PathFeatures["class"]);
  const protectedPath = PROTECTED_PATH_RULES.find(([re]) => re.test(raw))?.[1];

  return {
    raw,
    resolved: target.resolved,
    class: cls,
    ...(protectedPath !== undefined ? { protectedPath } : {}),
    secretRef: SECRET_TOKEN_RE.test(raw),
    networkPath: /^\/\/|^\/net\//.test(raw),
  };
}

function hostFeaturesOf(rawUrl: string): HostFeatures | undefined {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return undefined;
  }
  const host = url.hostname.toLowerCase();
  let cls: HostFeatures["class"] = "public";
  if (host === "localhost" || host === "[::1]" || host.endsWith(".localhost")) cls = "localhost";
  // Link-local is the cloud-metadata range on every major provider, and a
  // metadata service is either a bare link-local address or a `*.internal`
  // name. Matched by shape, not by a list of provider hostnames that would
  // rot — and without transcribing a real internal domain into the repo.
  else if (host.startsWith("169.254.") || host.endsWith(".internal")) cls = "metadata";
  else if (/^127\.|^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\.|^\[?fd[0-9a-f]{2}:/.test(host)) cls = "private";
  return { host, scheme: url.protocol.replace(":", ""), class: cls };
}

/** §4.3 `deletesTests`: a diff that removes an assertion from a security-relevant test. */
function diffDeletesTests(tool: string, args: Record<string, unknown>): boolean {
  const patch = typeof args.patch === "string" ? args.patch : "";
  const edits = Array.isArray(args.edits) ? JSON.stringify(args.edits) : "";
  const body = `${patch}\n${edits}`;
  if (body.trim() === "") return false;
  const removed = /^-(?!-).*(expect|assert|should|toBe|toEqual)/m.test(body);
  const target = typeof args.path === "string" ? args.path : typeof args.filePath === "string" ? args.filePath : "";
  return removed && /auth|permission|sandbox|security/i.test(target) && tool !== "read_file";
}

function toolKind(tool: string): RiskToolKind {
  if (SHELL_TOOLS.has(tool)) return "shell";
  if (PATH_WRITE_TOOLS.has(tool)) return "path-write";
  if (PATH_READ_TOOLS.has(tool)) return "path-read";
  if (NETWORK_TOOLS.has(tool)) return "network";
  if (tool === "new_task") return "spawn";
  if (tool.startsWith("mcp__")) return "mcp";
  return "other";
}

/**
 * Extracts the §4 vector for one tool call. Never throws: an input shape this
 * module does not model yields an empty-ish vector with `parse: "failed"`,
 * which §7 resolves to `confirm` — the same fail-closed answer the engine
 * gives an unparseable command.
 */
export function extractRiskFeatures(input: RiskInput): RiskFeatures {
  const kind = toolKind(input.tool);
  const command = typeof input.args.command === "string" ? input.args.command : "";

  const base: RiskFeatures = {
    tool: input.tool,
    kind,
    parse: "failed",
    segments: [],
    redirects: [],
    wrappers: [],
    expansion: false,
    substitution: false,
    glob: false,
    absBinary: false,
    interpreterInline: false,
    specialVars: [],
    longCommand: command.length > 2000,
    pipeToShell: false,
    secretEgress: false,
    tmpWildcardDelete: false,
    preSessionTarget: false,
    unassignedVars: [],
  };

  if (kind === "shell") return { ...base, ...shellFeatures(command, input) };
  if (kind === "path-write" || kind === "path-read") {
    const ctx = targetContext(input);
    const path = pathFeaturesOf(input.tool, input.args, ctx);
    return {
      ...base,
      parse: "parsed",
      ...(path !== undefined ? { path } : {}),
      ...(kind === "path-write" && diffDeletesTests(input.tool, input.args) ? { deletesTests: true } : {}),
    };
  }
  if (kind === "network") {
    const raw = String(input.args.url ?? "");
    const host = kind === "network" && raw ? hostFeaturesOf(raw) : undefined;
    return { ...base, parse: "parsed", ...(host !== undefined ? { host } : {}) };
  }
  if (kind === "spawn") {
    const description = String(input.args.description ?? input.args.task ?? "");
    return { ...base, parse: "parsed", spawnText: description };
  }
  if (kind === "mcp") {
    const verb = MCP_MUTATING_VERB_RE.exec(input.tool.slice("mcp__".length).replace(/__/g, "_"));
    return { ...base, parse: "parsed", ...(verb ? { mcpVerb: verb[2] } : {}) };
  }
  return base;
}

function targetContext(input: RiskInput): TargetContext {
  return { workingDir: input.workingDir, writeRoots: input.writeRoots, vars: new Map() };
}

function shellFeatures(command: string, input: RiskInput): Partial<RiskFeatures> {
  const trimmed = command.trim();
  const dangling = isDanglingOperator(trimmed);
  const longCommand = command.length > 2000;
  if (trimmed === "") return { parse: "failed", longCommand, interpreterInline: false };

  const leading = splitLeading(trimmed);
  // bash-normalize anchors its wrapper detection on the bare spelling, and
  // deliberately so: its approval patterns are built against `bash -c '…'`,
  // and `/bin/bash` would produce a different subject. For *recognition* the
  // two are the same call, so the interpreter token is folded to its bare form
  // here — only when it is the wrapper itself and carries `-c`, so
  // `/bin/bash script.sh` is left as the opaque binary it is. The visible
  // consequence is that `absBinary` does not see a path-qualified shell.
  const commandText = leading.rest.replace(/^\S+\/(bash|sh)(\s+-c\s+)/, "$1$2");
  const { text, failedUnwrap } = detectWrapper(commandText);
  // A `bash -c '…'` whose body contains a substitution cannot be unwrapped as
  // an approval subject (bash-normalize's extractQuotedArg refuses it), but the
  // body is still *visible*, and reading it can only add risk, never remove it.
  // So the features are extracted from it and the parse is reported as failed:
  // `bash -c 'D=$(pwd); rm -rf "$D"'` blocks, and `bash -c "$(cat x)"` stays the
  // fail-closed confirm it already was.
  const body = failedUnwrap ? extractQuotedArgLoose(commandText) : text;
  if (body === null) return { parse: "failed", longCommand, interpreterInline: false };

  const rawSegments = splitCompound(body);
  const stripped = rawSegments.map(stripRedirects);
  const cleanedSegments = stripped.map((s) => s.cleaned).filter((s) => s !== "");
  if (cleanedSegments.length === 0) return { parse: "failed", longCommand, interpreterInline: false };

  // The leading assignments are part of the command's variable environment:
  // `D=$(pwd) rm -rf "$D"` resolves the same way as the two-statement form.
  const ctx: TargetContext = {
    ...targetContext(input),
    vars: new Map([...leading.envAssigns, ...collectVars(cleanedSegments)]),
  };
  const segments = cleanedSegments.map((segment) =>
    segmentFeatures(segment, stripped.flatMap((s) => s.redirects), ctx, leading.wrappers),
  );

  // Redirect targets need the same path classification the command's own
  // arguments get, so `> /etc/hosts` and `rm -rf /etc` are measured against
  // the same boundary (§5.2 fs.write-outside-roots).
  const redirects: RiskRedirect[] = stripped
    .flatMap((s) => s.redirects)
    .map((r) => (r.target ? { ...r, class: classifyTarget(r.target, ctx, { cwdCritical: false }).class } : r));

  const { interpreter, inline } = interpreterOf(segments);
  const specialVars = unique([
    ...leading.envAssigns.map(([name]) => name),
    ...cleanedSegments.flatMap(specialVarNamesOf),
  ]).filter(isSpecialVar);

  return {
    parse: failedUnwrap ? "failed" : parseStatus(cleanedSegments, command.length, dangling),
    segments,
    redirects,
    wrappers: unique([...leading.wrappers, ...cleanedSegments.flatMap((s) => stripWrappersFor(s).wrappers)]),
    ...(interpreter !== undefined ? { interpreter } : {}),
    interpreterInline: inline,
    runner: runnerOf(segments),
    expansion: hasExpansion(body),
    substitution: hasSubstitution(body),
    glob: hasUnquotedGlob(body),
    absBinary: absBinaryOf(segments),
    envAssign: toEnvAssign(leading.envAssigns[0]) ?? leadingEnvAssign(cleanedSegments),
    specialVars,
    longCommand,
    pipeToShell: hasPipeToShell(segments),
    secretEgress: hasSecretEgress(segments),
    tmpWildcardDelete: hasTmpWildcardDelete(segments),
    preSessionTarget: hasPreSessionTarget(segments, input.session.createdThisSession),
    unassignedVars: unassignedDeleteVars(segments, ctx.vars),
  };
}

function stripWrappersFor(segment: string): StrippedSegment {
  const tokens = tokenize(segment) ?? segment.trim().split(/\s+/).filter(Boolean);
  return stripWrappers(tokens);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

/**
 * §4.1 `parse`. A dangling operator (`npm test &&`) is a parse failure even
 * though the segments that survive splitting tokenize cleanly: the shell
 * would not run that line, so the visible tokens are not the whole call.
 * §7 resolves every parse failure to `confirm`.
 */
function parseStatus(segments: string[], length: number, dangling: boolean): RiskParseStatus {
  if (dangling) return "failed";
  if (length > 10_000) return "failed";
  if (segments.length === 0) return "failed";
  const parsed = segments.filter((s) => tokenize(s) !== null).length;
  if (parsed === 0) return "failed";
  return parsed === segments.length ? "parsed" : "partial";
}

/** A trailing `&&`/`||`/`|`/`;`/`&` — a line the shell would reject. */
export function isDanglingOperator(command: string): boolean {
  return /(?:&&|\|\||[|;]|&)\s*$/.test(command.trim());
}

function hasExpansion(command: string): boolean {
  if (hasSubstitution(command)) return true;
  if (/\$\{/.test(command)) return true;
  // An unquoted $VAR, as opposed to one a shell would not re-split.
  return /(^|[^"'])\$[A-Za-z_][A-Za-z0-9_]*/.test(command);
}

function hasSubstitution(command: string): boolean {
  return /\$\(|`|<\(|>\(/.test(command);
}

function hasUnquotedGlob(command: string): boolean {
  let quote: "'" | '"' | null = null;
  for (const ch of command) {
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === "*" || ch === "?" || ch === "[") return true;
  }
  return false;
}

/**
 * §4.1 `interpreter`. The program name plus whether an inline script follows
 * (`python -c`, `node -e`) — the inline form is a confirm of its own (§5.2)
 * because the code being run is not in the command's visible argv at all.
 */
function interpreterOf(segments: SegmentFeatures[]): { interpreter?: string; inline: boolean } {
  for (const segment of segments) {
    if (!INTERPRETERS.has(segment.program)) continue;
    const tokens = segment.text.trim().split(/\s+/).filter(Boolean);
    const inline = tokens.slice(1).some((t) => INTERPRETER_INLINE_FLAGS.has(t));
    return { interpreter: segment.program, inline };
  }
  return { inline: false };
}

/** §4.1 `runner`: the opaque launchers, matched on the two-token forms too. */
function runnerOf(segments: SegmentFeatures[]): string | undefined {
  for (const segment of segments) {
    const program = segment.program;
    const second = segment.text.trim().split(/\s+/)[1]?.toLowerCase();
    if (RUNNER_PROGRAMS.has(program)) return program;
    if (program === "pnpm" && second === "dlx") return "pnpm dlx";
    if (program === "docker" && second === "exec") return "docker exec";
    if (program === "mise" && second === "exec") return "mise exec";
  }
  return undefined;
}

function absBinaryOf(segments: SegmentFeatures[]): boolean {
  for (const segment of segments) {
    const first = segment.text.trim().split(/\s+/)[0] ?? "";
    if (first.includes("/") && !first.startsWith("/bin/") && !first.startsWith("/usr/bin/")) return true;
  }
  return false;
}

function leadingEnvAssign(segments: string[]): RiskFeatures["envAssign"] {
  for (const segment of segments) {
    const assign = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(segment.trim());
    if (!assign) continue;
    const name = assign[1];
    const value = segment.trim().slice(name.length + 1).split(/\s+/)[0];
    return { name, value, safe: SAFE_ENV_VARS.has(name) };
  }
  return undefined;
}

/** The names an assignment-token list defines, e.g. ["PATH", "LD_PRELOAD"]. */
function specialVarNamesOf(segment: string): string[] {
  const names: string[] = [];
  for (const token of segment.trim().split(/\s+/)) {
    const assign = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(token);
    if (assign) names.push(assign[1]);
  }
  return names;
}

function isSpecialVar(name: string): boolean {
  return SPECIAL_VARS.has(name) || name === "LD_PRELOAD" || name.startsWith("DYLD_");
}

/**
 * §4.2 `pipeToShell`: a network program on the left of a pipe and an
 * interpreter on the right. Splitting happens quote-aware in bash-normalize,
 * so segment order survives the `|` and the pair can be read positionally.
 */
function hasPipeToShell(segments: SegmentFeatures[]): boolean {
  for (let i = 0; i < segments.length; i++) {
    if (!segments[i].net) continue;
    for (let j = i + 1; j < segments.length; j++) {
      if (INTERPRETERS.has(segments[j].program)) return true;
    }
  }
  return false;
}

/**
 * §4.2 `secretEgress`: a credential reference in a command that also reaches
 * the network. Reading your own .env is a prompt (fs.secret-ref); moving it
 * out of the machine is a block. `git add .env` is the former — git staging
 * is not egress, and the push that would carry it out is a separate call the
 * rules see on its own.
 */
function hasSecretEgress(segments: SegmentFeatures[]): boolean {
  const refs = segments.flatMap((s) => s.secretRefs);
  if (refs.length === 0) return false;
  return segments.some((s) => s.net);
}

function hasTmpWildcardDelete(segments: SegmentFeatures[]): boolean {
  const tmpRoots = [tmpdir(), "/tmp", "/private/tmp"];
  return segments.some((segment) => {
    if (!segment.deletes) return false;
    const inTmp = segment.targets.some((t) =>
      tmpRoots.some((root) => t.resolved === root || pathWithin(root, t.resolved)),
    );
    return inTmp && (segment.findMtime || segment.targets.some((t) => t.raw.includes("*")));
  });
}

function hasPreSessionTarget(segments: SegmentFeatures[], created: Set<string>): boolean {
  return segments.some((segment) => {
    if (!segment.deletes) return false;
    return segment.targets.some(
      (t) => t.class !== "build-dir" && !created.has(t.resolved) && !isBuildDirPath(t.resolved),
    );
  });
}

function isBuildDirPath(abs: string): boolean {
  return [...BUILD_DIRS].some((d) => new RegExp(`(^|/)${d.replace(".", "\\.")}($|/)`).test(abs));
}

/** §5.1 `rm.unassigned-var`: the target depends on a variable this command never sets. */
function unassignedDeleteVars(segments: SegmentFeatures[], vars: Map<string, string>): string[] {
  const found = new Set<string>();
  for (const segment of segments) {
    if (!segment.deletes) continue;
    for (const target of segment.targets) {
      const match = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/.exec(stripQuotes(target.raw));
      if (match && !vars.has(match[1])) found.add(match[1]);
    }
  }
  return [...found];
}
