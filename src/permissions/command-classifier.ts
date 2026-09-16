import { splitCompound } from "./bash-normalize.js";

/**
 * Advisory shell classification. This is deliberately not a capability or
 * permission decision: the process.execute capability remains authoritative.
 * The only positive result is a small, syntax-constrained read-only
 * allowlist. Everything else is unknown.
 */
export type CommandClassification = "proven-read-only" | "unknown";

export interface CommandClassificationResult {
  classification: CommandClassification;
  reason: string;
}

const READ_ONLY_COMMANDS = new Set([
  "basename", "cat", "cmp", "cut", "df", "diff", "dirname", "du", "echo", "false", "file",
  "find", "grep", "head", "id", "ls", "pwd", "readlink", "realpath", "rg", "stat",
  "tail", "test", "true", "uname", "uniq", "wc", "which", "whoami", "printf",
]);

const INTERPRETERS_AND_WRAPPERS = new Set([
  ".", "alias", "bash", "command", "env", "eval", "exec", "fish", "functions", "ksh", "nice", "nohup",
  "node", "perl", "php", "python", "python2", "python3", "ruby", "sh", "source", "timeout", "xargs", "zsh",
]);

const READ_ONLY_GIT_SUBCOMMANDS = new Set([
  "blame", "cat-file", "describe", "diff", "for-each-ref", "log", "ls-files", "name-rev", "rev-parse",
  "shortlog", "show", "status", "whatchanged",
]);

function unknown(reason: string): CommandClassificationResult {
  return { classification: "unknown", reason };
}

function readOnly(reason: string): CommandClassificationResult {
  return { classification: "proven-read-only", reason };
}

/**
 * Tokenize one shell segment only when its syntax is unambiguous. Shell
 * operators, expansion, redirection, comments, and incomplete quoting are
 * rejected instead of attempting to emulate a shell parser.
 */
function tokenize(segment: string): string[] | null {
  const tokens: string[] = [];
  let token = "";
  let hasToken = false;
  let quote: "single" | "double" | null = null;

  const push = () => {
    if (hasToken) tokens.push(token);
    token = "";
    hasToken = false;
  };

  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    const next = segment[i + 1];

    if (quote === "single") {
      if (ch === "'") quote = null;
      else token += ch;
      hasToken = true;
      continue;
    }
    if (quote === "double") {
      if (ch === '"') {
        quote = null;
      } else if (ch === "\\") {
        // Only consume a quoted character. Expansion characters are still
        // rejected below when unquoted; keeping this conservative avoids
        // pretending to model every double-quote escape rule.
        if (next === undefined) return null;
        token += next;
        hasToken = true;
        i++;
      } else if (ch === "$" || ch === "`") {
        return null;
      } else {
        token += ch;
        hasToken = true;
      }
      continue;
    }

    if (ch === "'") {
      quote = "single";
      hasToken = true;
      continue;
    }
    if (ch === '"') {
      quote = "double";
      hasToken = true;
      continue;
    }
    if (ch === "\\") return null;
    if (";|&<>\n".includes(ch)) return null;
    if (ch === "#") return null;
    if (ch === "$" || ch === "`") return null;
    if (/\s/.test(ch)) {
      push();
      continue;
    }
    token += ch;
    hasToken = true;
  }

  if (quote !== null) return null;
  push();
  return tokens.length > 0 ? tokens : null;
}

function commandName(token: string): string {
  const slash = token.lastIndexOf("/");
  return (slash === -1 ? token : token.slice(slash + 1)).toLowerCase();
}

function hasExpansionOrGlob(token: string): boolean {
  // Globs and tilde expansion make the actual read targets dependent on the
  // shell/filesystem. A classifier must not claim those targets are known.
  return /[*?[]/.test(token) || token.startsWith("~") || token.includes("${");
}

function classifyTokens(tokens: string[]): CommandClassificationResult {
  const first = tokens[0];
  const name = commandName(first);

  if (first.includes("/") && !first.startsWith("/usr/bin/") && !first.startsWith("/bin/")) {
    return unknown("non-system executable path is not proven read-only");
  }
  if (INTERPRETERS_AND_WRAPPERS.has(name)) return unknown("interpreter or command wrapper");
  if (/\.(?:sh|bash|zsh|fish|py|pl|rb|php|js|mjs|cjs)$/.test(name)) return unknown("script execution is not proven read-only");
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(first)) return unknown("environment assignment is dynamic");
  if (tokens.some(hasExpansionOrGlob)) return unknown("shell expansion or glob is dynamic");

  if (name === "git") {
    const subcommand = tokens[1];
    if (!subcommand || subcommand.startsWith("-") || !READ_ONLY_GIT_SUBCOMMANDS.has(subcommand.toLowerCase())) {
      return unknown("git subcommand is not on the read-only allowlist");
    }
    if (tokens.includes("-c") || tokens.some((token) => token.startsWith("-c"))) {
      return unknown("git configuration override is dynamic");
    }
    return readOnly("allowlisted git read-only subcommand");
  }

  if (!READ_ONLY_COMMANDS.has(name)) return unknown("command is not on the read-only allowlist");
  if (name === "find" && tokens.some((token) => /^-(?:exec|execdir|ok|okdir|delete|fls|fprint)/.test(token))) {
    return unknown("find action can execute or write");
  }
  if (name === "head" || name === "tail") {
    if (tokens.some((token) => token === "-o" || token === "--output" || token.startsWith("--output="))) {
      return unknown("output option can write a file");
    }
  }
  return readOnly("allowlisted read-only command");
}

/** Classify one independent shell segment. */
export function classifyCommandSegment(segment: string): CommandClassificationResult {
  const tokens = tokenize(segment.trim());
  if (!tokens) return unknown("empty or ambiguous shell segment");
  return classifyTokens(tokens);
}

/**
 * Classify a complete command after top-level compound splitting. The result
 * is positive only when every segment is independently proven read-only.
 * Compound approval and permission semantics remain owned by PermissionEngine.
 */
export function classifyCommand(command: string): CommandClassificationResult {
  const segments = splitCompound(command);
  if (segments.length === 0) return unknown("empty command");

  for (const segment of segments) {
    const result = classifyCommandSegment(segment);
    if (result.classification === "unknown") return result;
  }
  return readOnly("every command segment is independently allowlisted and read-only");
}
