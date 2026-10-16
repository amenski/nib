import { execFile } from "node:child_process";
import type { ToolOutput, ToolDef } from "../types.js";
import type { ToolHandler } from "./types.js";
import { ToolRegistry } from "./registry.js";
import { wrapUntrusted, sanitizeControlChars } from "./untrusted-content.js";

const MAX_MATCH_LINES = 50;
// A line cap alone does not bound the result: one match in a minified file or
// a JSONL log can be hundreds of KB on its own.
const MAX_LINE_CHARS = 500;
const TIMEOUT_MS = 30_000;

function capLines(stdout: string): string {
  return stdout
    .split("\n")
    .slice(0, MAX_MATCH_LINES)
    .map((line) =>
      line.length > MAX_LINE_CHARS
        ? `${line.slice(0, MAX_LINE_CHARS)}…[line truncated, ${line.length} chars]`
        : line,
    )
    .join("\n");
}
// Generated, vendored and cached directories: never what a code search is
// after, and they dominate the cost of a recursive walk — a single
// node_modules or target/ can be most of a tree's bytes, and a match inside
// one is a copy of a match in the source that produced it. Skipping them is
// what keeps a search over a large project inside TIMEOUT_MS. `-I` skips
// binary files for the same reason.
//
// grep matches --exclude-dir against the directory's basename at any depth, so
// these apply throughout the tree. `bin` is deliberately absent: it is build
// output for .NET but hand-written scripts nearly everywhere else (bin/rails,
// bin/setup), and losing those to a search is worse than walking them.
const SKIP_DIR_NAMES = [
  // version control
  ".git", ".svn", ".hg",
  // JS/TS dependencies, build output and caches
  "node_modules", "bower_components", ".next", ".nuxt", ".svelte-kit",
  ".turbo", ".parcel-cache", ".yarn",
  // JVM
  "target", ".gradle", ".m2",
  // Python
  "__pycache__", ".venv", "venv", ".tox", ".mypy_cache", ".pytest_cache",
  // vendored dependencies (Go modules, Composer, CocoaPods)
  "vendor", "Pods",
  // generic build output
  "dist", "build", "out", "obj", "DerivedData",
  // caches, coverage and IDE state
  ".cache", "coverage", ".nyc_output", ".idea", ".terraform",
  // nib's own per-project state: --debug logs hold whole conversations on one
  // line, so a match there floods the context with an earlier session
  ".nib",
];
const SKIP_DIRS = SKIP_DIR_NAMES.map((d) => `--exclude-dir=${d}`);

/** Injectable for tests — default is node's execFile. */
type ExecFileFn = typeof execFile;
type NowFn = () => number;

/**
 * The search body with injectable dependencies — same split as runBashTimed,
 * so the kill paths (timeout, output cap) are testable without a 30s test.
 * `execFileFn` replaces subprocess execution; `nowFn` replaces `Date.now()`
 * so the timeout-math (`Date.now() - started >= timeoutMs`) can be driven to
 * true instantly in tests.
 */
export function runSearchTimed(
  pattern: string,
  dir: string,
  timeoutMs: number,
  execFileFn: ExecFileFn = execFile,
  nowFn: NowFn = Date.now.bind(Date),
): Promise<ToolOutput> {
  return new Promise<ToolOutput>((resolve) => {
    // execFile with shell:false (the default) passes pattern/dir as argv
    // entries — no shell parses them, so shell metacharacters in either
    // (", ;, $(...), backticks, ...) are inert literal bytes to grep, not
    // command syntax. This replaces the old `exec` shell-string pipeline
    // (grep ... 2>/dev/null | head -50), so stderr suppression and the
    // 50-line cap are reproduced in JS below instead of by the shell.
    const started = nowFn();
    execFileFn(
      "grep",
      ["-rn", "-I", ...SKIP_DIRS, pattern, dir],
      { maxBuffer: 512 * 1024, timeout: timeoutMs },
      (err, stdout) => {
        // grep exits 1 for "no matches" — not a failure, same as the old
        // code's blanket ignore of `err`. Only a genuine failure (bad dir,
        // invalid pattern, exit code >= 2, signal kill, etc.) surfaces as an
        // error; content in that case still favors any stdout grep produced.
        const noMatches = (err as (Error & { code?: number }) | null)?.code === 1;
        if (err && !noMatches) {
          // A run killed by the timeout or the output cap reports neither an
          // exit code nor stderr — Node's message is a bare "Command failed:
          // grep -rn <pattern> <dir>", which reads like a broken command or a
          // permission problem when it is really "this directory was too big
          // to finish". Name the real cause instead, and hand back whatever
          // grep managed to print before it was killed rather than dropping
          // matches the user already paid for.
          const killed = (err as Error & { killed?: boolean }).killed === true;
          const timedOut = killed && nowFn() - started >= timeoutMs;
          const message = timedOut
            ? `search timed out after ${timeoutMs / 1000}s in ${dir} — narrow the directory or the pattern`
            : killed
              ? `search produced too much output in ${dir} — narrow the directory or the pattern`
              // The message can embed grep's stderr (e.g. a path from the
              // filesystem) — sanitize defensively, same rationale as the
              // content path below.
              : sanitizeControlChars((err as Error).message);
          const partial = stdout
            ? `${wrapUntrusted(sanitizeControlChars(capLines(stdout)))}\n\nPartial results — ${message}`
            : `Error running search: ${message}`;
          resolve({ content: partial, error: message });
          return;
        }
        if (!stdout) {
          resolve({ content: "No matches found." });
          return;
        }
        const capped = capLines(stdout);
        resolve({ content: wrapUntrusted(sanitizeControlChars(capped)) });
      },
    );
  });
}

const searchHandler: ToolHandler = async (args) =>
  runSearchTimed(args.pattern as string, (args.dir as string) || ".", TIMEOUT_MS);

const searchDef: ToolDef = {
  name: "search",
  description: "Search for a regex pattern in files under a directory using grep. Prefer this over grep in run_bash.",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "The regex pattern to search for" },
      dir: { type: "string", description: "Directory to search in (defaults to cwd). Generated and vendored directories (node_modules, target, dist, build, .git, ...) are skipped." },
    },
    required: ["pattern"],
  },
};

export function registerSearch(registry: ToolRegistry): void {
  registry.register({ def: searchDef, handler: searchHandler, groups: ["read"] });
}
