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
  "find", "grep", "head", "id", "ls", "pwd", "readlink", "realpath", "rg", "sort", "stat",
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

/**
 * Global git flags that only change how output is shown (`git --no-pager log`).
 * Skipped when looking for the subcommand; every other leading option, `-C` and
 * `-c` included, still leaves the subcommand unreadable and so unknown.
 */
const GIT_PAGER_FLAGS = new Set(["--no-pager", "-P"]);

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
 *
 * Exported for git-config-operations.ts, which needs the same conservative
 * reading of a segment rather than a second, differently-buggy tokenizer.
 */
export function tokenize(segment: string): string[] | null {
  return scan(segment)?.map((token) => token.text) ?? null;
}

/** A word with the one fact quoting hides from `text`: whether the shell would glob it. */
interface ScannedToken {
  text: string;
  /** An unquoted `*`, `?` or `[` — a quoted one is a literal character. */
  unquotedGlob: boolean;
}

function scan(segment: string): ScannedToken[] | null {
  const tokens: ScannedToken[] = [];
  let token = "";
  let hasToken = false;
  let glob = false;
  let quote: "single" | "double" | null = null;

  const push = () => {
    if (hasToken) tokens.push({ text: token, unquotedGlob: glob });
    token = "";
    hasToken = false;
    glob = false;
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
    if (ch === "*" || ch === "?" || ch === "[") glob = true;
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

/**
 * Programs whose own argument syntax gives `*`, `?` and `[` meaning even
 * inside quotes (a `find -name` pattern, a `sed` script, a `sort` key, a git
 * pathspec). For these a glob character is dynamic however it is quoted; for
 * everything else only the shell's own globbing matters, which quoting turns off.
 */
const QUOTE_BLIND_GLOB_COMMANDS = new Set(["find", "git", "sed", "sort"]);

/**
 * Programs whose every flag is read-only and none executes or writes, so a
 * shell glob in their arguments only widens which files are read. The
 * classifier accepts it; keeping the literal part of the glob inside the
 * workspace is the risk layer's job (features.ts), which knows the cwd.
 */
const GLOB_TOLERANT_COMMANDS = new Set(["cat", "grep", "head", "ls", "tail", "wc"]);

function hasExpansionOrGlob(token: ScannedToken, quoteBlind: boolean, globTolerant: boolean): boolean {
  // Globs and tilde expansion make the actual read targets dependent on the
  // shell/filesystem. A classifier must not claim those targets are known.
  const glob = globTolerant ? false : quoteBlind ? /[*?[]/.test(token.text) : token.unquotedGlob;
  return glob || token.text.startsWith("~") || token.text.includes("${");
}

function classifyTokens(scanned: ScannedToken[]): CommandClassificationResult {
  const tokens = scanned.map((token) => token.text);
  const first = tokens[0];
  const name = commandName(first);

  if (first.includes("/") && !first.startsWith("/usr/bin/") && !first.startsWith("/bin/")) {
    return unknown("non-system executable path is not proven read-only");
  }
  if (INTERPRETERS_AND_WRAPPERS.has(name)) return unknown("interpreter or command wrapper");
  if (/\.(?:sh|bash|zsh|fish|py|pl|rb|php|js|mjs|cjs)$/.test(name)) return unknown("script execution is not proven read-only");
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(first)) return unknown("environment assignment is dynamic");
  const quoteBlind = QUOTE_BLIND_GLOB_COMMANDS.has(name);
  const globTolerant = GLOB_TOLERANT_COMMANDS.has(name);
  if (scanned.some((token) => hasExpansionOrGlob(token, quoteBlind, globTolerant))) return unknown("shell expansion or glob is dynamic");

  if (name === "git") {
    let subcommandIndex = 1;
    while (GIT_PAGER_FLAGS.has(tokens[subcommandIndex])) subcommandIndex++;
    const subcommand = tokens[subcommandIndex];
    if (!subcommand || subcommand.startsWith("-") || !READ_ONLY_GIT_SUBCOMMANDS.has(subcommand.toLowerCase())) {
      return unknown("git subcommand is not on the read-only allowlist");
    }
    if (tokens.includes("-c") || tokens.some((token) => token.startsWith("-c"))) {
      return unknown("git configuration override is dynamic");
    }
    if (tokens.some(isGitOutputOption)) return unknown("git output option can write a file");
    return readOnly("allowlisted git read-only subcommand");
  }

  if (name === "sed") return classifySed(tokens);
  if (!READ_ONLY_COMMANDS.has(name)) return unknown("command is not on the read-only allowlist");
  if (name === "find" && tokens.some((token) => /^-(?:exec|execdir|ok|okdir|delete|fls|fprint)/.test(token))) {
    return unknown("find action can execute or write");
  }
  if (name === "head" || name === "tail") {
    if (tokens.some((token) => token === "-o" || token === "--output" || token.startsWith("--output="))) {
      return unknown("output option can write a file");
    }
  }
  if (name === "rg" && tokens.some((token) => token.startsWith("--pre") || token.startsWith("--hostname-bin"))) {
    return unknown("rg option runs a program");
  }
  if (name === "uniq" && tokens.slice(1).filter((token) => !token.startsWith("-")).length > 1) {
    return unknown("uniq output operand writes a file");
  }
  if (name === "file" && tokens.some((token) => /^-[A-Za-z]*C/.test(token) || (token.length >= 4 && "--compile".startsWith(token)))) {
    return unknown("file option writes a compiled magic file");
  }
  if (name === "sort" && tokens.some(isSortWriteOption)) {
    return unknown("sort option can write a file or run a program");
  }
  return readOnly("allowlisted read-only command");
}

/**
 * `sed` is read-only only as a line printer: `sed -n '10,40p' file`,
 * `sed -n '/start/,/end/p' file`. Its script language can write (`w`, `s///w`,
 * `-i`) and run commands (`e`), so the script has to be nothing but one address
 * or address range followed by `p` — no other command can be spelled — and the
 * only options are the ones that change how it is read, never `-i`, `-f` or `-e`.
 */
const SED_PRINT_OPTION = /^-[nEr]+$|^--(?:quiet|silent|regexp-extended)$/;
const SED_ADDRESS = String.raw`(?:\d+|\$|/[^/\\]*/)`;
const SED_PRINT_SCRIPT = new RegExp(`^${SED_ADDRESS}(?:,${SED_ADDRESS})?p$`);

function classifySed(tokens: string[]): CommandClassificationResult {
  const args = tokens.slice(1);
  const script = args.findIndex((token) => !SED_PRINT_OPTION.test(token));
  if (script === -1 || !SED_PRINT_SCRIPT.test(args[script])) {
    return unknown("sed script is not a plain line print");
  }
  if (args.slice(script + 1).some((token) => token.startsWith("-"))) return unknown("sed option after the script");
  return readOnly("sed restricted to printing lines");
}

/**
 * `--output=FILE` of the diff family (`git diff|log|show|whatchanged`). git
 * accepts abbreviations, so every `--out…` spelling counts; only the
 * `--output-indicator-*` options, which take a character, are exempt.
 */
function isGitOutputOption(token: string): boolean {
  return token.startsWith("--out") && !token.startsWith("--output-indicator-");
}

/**
 * `-o FILE`, `--output`, and `--compress-program` (which executes its argument).
 * getopt accepts any unambiguous prefix of a long option, so `--out=f` counts.
 */
function isSortWriteOption(token: string): boolean {
  if (token.startsWith("--")) {
    const name = token.split("=")[0];
    return name.length >= 3 && ("--output".startsWith(name) || "--compress-program".startsWith(name));
  }
  return /^-[A-Za-z]*o/.test(token);
}

/** Classify one independent shell segment. */
export function classifyCommandSegment(segment: string): CommandClassificationResult {
  const tokens = scan(segment.trim());
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
