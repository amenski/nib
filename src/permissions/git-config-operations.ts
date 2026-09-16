import { isUnresolved, splitCompound } from "./bash-normalize.js";
import { tokenize } from "./command-classifier.js";

/**
 * Whether a bash call is a Git operation that must write `.git` config —
 * `init`, `clone`, `remote add`/`set-url`/`remove`/`rename`/`set-branches`,
 * `submodule add`, and `config <name> <value>`. This is the set of
 * *repository creation and wiring* commands the `.git` integrity denies
 * otherwise break (see GIT_INTEGRITY_DENIES in src/sandbox/seatbelt.ts and
 * release gate 2 in docs/security-architecture-plan.md).
 *
 * This is NOT an authorization decision and must never be read as one. It
 * answers exactly one question: should the approval prompt for this call
 * *offer* the widened Seatbelt variant that re-allows `.git/config` writes
 * inside the workspace? The grant itself comes only from an explicit
 * one-time approval of that exact call: the classifier decides what the
 * prompt offers, the user's yes is the authority. Keeping that split is why
 * a false negative here is merely inconvenient — the command still runs and
 * its config write simply fails closed under the default profile — while a
 * false positive would widen a profile without approval. Every ambiguity
 * therefore resolves to false.
 *
 * Conservative by construction:
 *   - Every segment of a compound command must qualify on its own, so
 *     `git init && curl …` is offered nothing.
 *   - `isUnresolved` must be false: sudo, env/nice/timeout wrappers, a
 *     leading env assignment, and command substitution are exactly the
 *     shapes whose real argv we cannot see.
 *   - The executable is a bare `git` or an absolute path under a standard
 *     bin directory. `./git` — a script inside the workspace — gets nothing.
 *   - No global Git option may precede the subcommand. `git -C /elsewhere
 *     config …` would target a config outside the workspace-scoped grant, so
 *     offering it a grant that cannot help it would be a misleading prompt.
 */
const GIT_BIN_DIRS = new Set([
  "/bin",
  "/usr/bin",
  "/usr/local/bin",
  "/usr/local/git/bin",
  "/opt/homebrew/bin",
]);

/**
 * `git config` flags that make the invocation a *read* — no config write is
 * coming, so no widened profile is warranted. `-l`/`-e` are Git's own
 * short forms for `--list`/`--edit`; `--edit` opens an editor, which is
 * interactive and can write arbitrary config, so it is excluded too.
 */
const CONFIG_READ_FLAGS = new Set([
  "-e",
  "-l",
  "--edit",
  "--get",
  "--get-all",
  "--get-color",
  "--get-colorbool",
  "--get-regexp",
  "--get-urlmatch",
  "--list",
  "--name-only",
  "--show-names",
  "--show-origin",
  "--show-scope",
]);

/**
 * `git config` flags that retarget the write at another file or scope:
 * `~/.gitconfig`, `/etc/gitconfig`, an arbitrary `--file`, or a blob. The
 * trusted variant is workspace-scoped, so it could not honour these — and a
 * `--global` write must not be shown a prompt implying it would.
 */
const CONFIG_OFF_TARGET_FLAGS = new Set([
  "-f",
  "--blob",
  "--file",
  "--global",
  "--system",
  "--worktree",
]);

/** `git remote` subcommands that write the repository's config. */
const REMOTE_WRITE_SUBCOMMANDS = new Set([
  "add",
  "remove",
  "rename",
  "rm",
  "set-branches",
  "set-url",
]);

function isStandardGitExecutable(token: string): boolean {
  if (token === "git") return true;
  if (!token.startsWith("/") || !token.endsWith("/git")) return false;
  return GIT_BIN_DIRS.has(token.slice(0, token.lastIndexOf("/")));
}

/** Whether one shell segment is a config-writing Git invocation. */
function isGitConfigWriteSegment(segment: string): boolean {
  if (isUnresolved(segment)) return false;
  const tokens = tokenize(segment.trim());
  if (!tokens || tokens.length < 2) return false;
  if (!isStandardGitExecutable(tokens[0])) return false;

  const subcommand = tokens[1].toLowerCase();
  const rest = tokens.slice(2);

  // Both lay down a fresh `.git` (config plus the hook templates).
  if (subcommand === "init" || subcommand === "clone") return true;
  if (subcommand === "submodule") return rest[0]?.toLowerCase() === "add";
  if (subcommand === "remote") {
    return REMOTE_WRITE_SUBCOMMANDS.has(rest[0]?.toLowerCase() ?? "");
  }
  if (subcommand !== "config") return false;

  // The write form is `git config <name> <value> […values]`. Read forms and
  // off-target scopes are excluded above; the remaining shape check requires
  // two non-flag arguments. A value that *looks* like a flag (`git config
  // alias.ci --stat`) is a deliberate false negative: unrecognized means no
  // grant, and the command fails closed rather than widening anything.
  const args = rest.filter((token) => token !== "--");
  if (args.some((token) => CONFIG_READ_FLAGS.has(token) || CONFIG_OFF_TARGET_FLAGS.has(token))) {
    return false;
  }
  return args.filter((token) => !token.startsWith("-")).length >= 2;
}

/**
 * Whether `toolName`/`args` is a bash call whose *entire* command is
 * config-writing Git operations. Only `run_bash` can qualify: a background
 * job has no per-call interactive approval to grant, so it stays on the
 * default profile.
 */
export function isGitConfigOperation(
  toolName: string,
  args: Record<string, unknown>,
): boolean {
  if (toolName !== "run_bash") return false;
  const command = args.command;
  if (typeof command !== "string" || command.trim() === "") return false;

  const segments = splitCompound(command);
  if (segments.length === 0) return false;
  return segments.every(isGitConfigWriteSegment);
}
