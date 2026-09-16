const FORK_BOMB = ":(){ :|:& };:";

const WRAPPER_RE = /^(bash|sh)\s+-c\s+|^eval\s+/;

/** Extracts the quoted argument to `bash -c` / `sh -c` / `eval`, one level deep only. */
export function extractQuotedArg(command: string): string | null {
  const trimmed = command.trim();
  const match = trimmed.match(WRAPPER_RE);
  if (!match) return null;
  const rest = trimmed.slice(match[0].length).trim();
  if (!rest) return null;

  const quote = rest[0];
  if (quote !== "'" && quote !== '"') return null;

  const closeIdx = rest.indexOf(quote, 1);
  if (closeIdx === -1 || closeIdx !== rest.length - 1) return null;

  const inner = rest.slice(1, closeIdx);
  if (inner.includes("$(") || inner.includes("`")) return null;

  return inner;
}

export interface UnwrapResult {
  text: string;
  /** True when a bash -c / sh -c / eval wrapper was detected but couldn't be cleanly unwrapped. */
  failedUnwrap: boolean;
}

export function detectWrapper(command: string): UnwrapResult {
  const trimmed = command.trim();
  if (!WRAPPER_RE.test(trimmed)) {
    return { text: command, failedUnwrap: false };
  }
  const inner = extractQuotedArg(trimmed);
  if (inner === null) {
    return { text: command, failedUnwrap: true };
  }
  return { text: inner, failedUnwrap: false };
}

/**
 * Splits a normalized shell command into independent segments on top-level
 * &&, ||, ;, |, newlines, and a single trailing/standalone &. Quote-aware:
 * operators inside '...' or "..." are not split points. The fork-bomb
 * literal is special-cased before splitting since it contains a bare `|`.
 */
export function splitCompound(command: string): string[] {
  if (command.trim() === FORK_BOMB) return [FORK_BOMB];

  const segments: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let depth = 0;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    const next = command[i + 1];

    if (inSingle) {
      current += ch;
      if (ch === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      current += ch;
      if (ch === '"') inDouble = false;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      current += ch;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      current += ch;
      continue;
    }
    if (ch === "(" || ch === "{") {
      depth++;
      current += ch;
      continue;
    }
    if (ch === ")" || ch === "}") {
      depth = Math.max(0, depth - 1);
      current += ch;
      continue;
    }

    if (depth === 0) {
      if ((ch === "&" && next === "&") || (ch === "|" && next === "|")) {
        segments.push(current);
        current = "";
        i++;
        continue;
      }
      if (ch === ";" || ch === "|" || ch === "\n") {
        segments.push(current);
        current = "";
        continue;
      }
      if (ch === "&") {
        segments.push(current);
        current = "";
        continue;
      }
    }

    current += ch;
  }
  segments.push(current);

  return segments.map((s) => s.trim()).filter(Boolean);
}

export function stripSudo(segment: string): string {
  return segment.replace(/^sudo\s+/, "");
}

const COMMAND_CARRYING_FIRST_TOKENS = new Set([
  "env",
  "nice",
  "nohup",
  "timeout",
  "command",
  "xargs",
]);

const FIND_EXEC_ACTIONS = new Set(["-exec", "-execdir", "-ok", "-okdir"]);

/**
 * Detects segments containing a construct bash-normalize can't safely
 * resolve to a real subject: inline command substitution, process
 * substitution, leading env-assignment, or a command-carrying wrapper
 * (env/nice/nohup/timeout/command/xargs/find -exec/bare sh/bash). These
 * always resolve to "unresolved-ask" rather than falling through to
 * whatever rule matches the visible first token.
 */
export function isUnresolved(segment: string): boolean {
  if (segment.includes("$(") || segment.includes("`") || segment.includes("<(") || segment.includes(">(")) {
    return true;
  }

  const tokens = segment.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return false;

  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) return true;

  const first = tokens[0];

  // A first token that isn't a bare command word (leading backslash escape,
  // a quote character, or any other non-identifier leading character) can't
  // be safely resolved against a literal-token destructive rule — "\rm" and
  // "rm" are different strings even though a shell treats them identically.
  // Fail closed rather than silently falling through defaultMode unchecked.
  if (!/^[A-Za-z0-9_./~-]/.test(first)) return true;

  if (COMMAND_CARRYING_FIRST_TOKENS.has(first)) return true;
  if (/^sudo\b/.test(first)) return true;
  if (first === "find" && tokens.some((t) => FIND_EXEC_ACTIONS.has(t))) return true;
  if ((first === "sh" || first === "bash") && !WRAPPER_RE.test(segment.trim())) return true;

  return false;
}

export interface BashSubjectResult {
  /** Normalized, per-segment subjects ready for rule matching. */
  segments: string[];
  /** True if any segment is unresolved (see isUnresolved). */
  wasUnresolved: boolean;
}

/**
 * Prefix for the persisted exact-match representation of a resolved compound
 * Bash call. The JSON array is deliberately kept in the existing `pattern`
 * field so settings files need no schema migration; the prefix makes this
 * representation unambiguous and prevents it being confused with a literal
 * shell command.
 */
export const BASH_COMPOUND_PATTERN_PREFIX = "nib-compound-v1:";

/**
 * Canonical exact-match subject for an approval. A single resolved segment
 * keeps the historical literal pattern. Multiple segments use a versioned
 * JSON array so matching is segment-aware and an edited segment cannot reuse
 * the approval. Unresolved shell has no canonical approval subject.
 */
export function buildBashApprovalPattern(command: string): string | null {
  const result = buildBashSubject(command);
  if (result.wasUnresolved || result.segments.length === 0) return null;
  if (result.segments.length === 1) return result.segments[0];
  return `${BASH_COMPOUND_PATTERN_PREFIX}${JSON.stringify(result.segments)}`;
}

export function buildBashSubject(command: string): BashSubjectResult {
  const { text, failedUnwrap } = detectWrapper(command);
  if (failedUnwrap) {
    return { segments: [], wasUnresolved: true };
  }

  const rawSegments = splitCompound(text);
  // Run isUnresolved BEFORE stripSudo so checks like sudo detection see the
  // original first token. Unresolved segments keep their original text;
  // only resolved segments get sudo stripped for clean rule matching.
  const wasUnresolved = rawSegments.some(isUnresolved);
  const segments = rawSegments.map((s) => (isUnresolved(s) ? s : stripSudo(s)));

  return { segments, wasUnresolved };
}

export { FORK_BOMB };
