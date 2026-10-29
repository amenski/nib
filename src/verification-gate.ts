import { splitCompound } from "./permissions/bash-normalize.js";

/**
 * Completion gate (docs/todo.md D2): the first attempt_completion after an
 * unverified edit returns a one-time reminder instead of ending the turn.
 */

export const EDIT_TOOLS = new Set([
  "edit",
  "edit_file",
  "write_to_file",
  "apply_diff",
  "apply_patch",
  "search_replace",
]);

/**
 * Verification = a test/typecheck/build/lint run. Conservative prefix
 * allowlist: `node src/check.js` is not verification even though it runs.
 * Known gap: this reads what ran, not whether it passed.
 */
const VERIFY_PREFIXES = [
  "npm run build",
  "npm run lint",
  "npm run typecheck",
  "npm test",
  "npx tsc",
  "tsc",
  "npx vitest",
  "npx jest",
  "npx eslint",
  "npx biome",
  "npx stylelint",
  "node --test",
  "go vet",
  "go test",
  "cargo build",
  "cargo check",
  "cargo test",
  "cargo clippy",
  "ruff",
  "mypy",
  "pyright",
  "pytest",
  "python -m pytest",
  "swift test",
  "swift build",
  "dart analyze",
  "dart test",
  "flutter analyze",
  "flutter test",
  "flutter build",
  "gradle test",
  "mvn test",
  "make test",
  "make check",
  "make lint",
  "mix test",
  "dotnet test",
  "dotnet build",
  "stack test",
  "cabal test",
  "hlint",
  "elm-test",
  "elm make",
];

const NON_VERIFY_INFIXES = ["--help", "--version"];

/** Any segment of a compound command counts: `echo done && npm test` verifies. */
export function isVerificationCommand(command: string): boolean {
  return splitCompound(command).some((segment) => {
    const text = segment.trim();
    if (text === "") return false;
    if (NON_VERIFY_INFIXES.some((infix) => text.includes(infix))) return false;
    return VERIFY_PREFIXES.some((prefix) => text.startsWith(prefix));
  });
}

export class VerificationGate {
  private lastEditDescription: string | undefined;
  private verified = false;
  private reminded = false;

  /** Called for every successfully executed call. */
  observe(toolName: string, args: Record<string, unknown>): void {
    if (toolName === "run_bash" || toolName === "run_bash_background") {
      const command = typeof args?.command === "string" ? args.command : "";
      if (isVerificationCommand(command)) this.verified = true;
      return;
    }
    if (toolName === "attempt_completion") return;
    if (EDIT_TOOLS.has(toolName)) {
      // An edit invalidates the check that ran before it, and re-arms the
      // reminder — once per edit, not once per turn.
      this.verified = false;
      this.reminded = false;
      const path = typeof args?.path === "string" ? args.path : undefined;
      this.lastEditDescription = path ? `${toolName} ${path}` : toolName;
    }
  }

  /** Interception for attempt_completion; null passes through unchanged. */
  check(): { content: string } | null {
    if (this.verified || this.lastEditDescription === undefined) return null;
    if (this.reminded) return null;
    this.reminded = true;
    return {
      content:
        `Your recent edit (${this.lastEditDescription}) has not been verified — ` +
        "no test/typecheck/build/lint command ran after it. Run one before attempt_completion " +
        "(call attempt_completion again to finish anyway).",
    };
  }
}
