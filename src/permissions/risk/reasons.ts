/**
 * The one table of reason tags to model-facing sentences
 * (docs/command-risk-classifier.md §3.4). The prompt, the audit row and the
 * tests all read from here, so a tag cannot come to mean two things.
 *
 * Every sentence answers two questions, in this order: what was seen, and what
 * to do instead. The second is load-bearing. A verdict the model cannot act on
 * becomes a retry loop or a user interrupt (§12.2), so a block says which
 * rewrite would be accepted and a confirm says what the user is being asked
 * about — never just "denied".
 */

/** Tag to sentence. See BLOCK_RULES/CONFIRM_RULES in rules.ts for the predicates. */
const RISK_REASONS: Record<string, string> = {
  // ── blocks (§5.1) ──
  "agent.unsafe-spawn":
    "this launches another agent with its own permission checks disabled, handing the rest of the session to a process nib cannot gate. Run the agent with its normal permissions, or ask the user to run it themselves.",
  "net.pipe-to-shell":
    "a downloaded script is piped straight into a shell, so whatever the server returns runs as you. Download it, read it, and run it as a file if it is what you expected.",
  "net.secret-egress":
    "a credential file or token is being sent over the network. Read the value only if the task needs it, and never into a request body, query string, or a cloud metadata endpoint.",
  "tmp.wildcard-delete":
    "this deletes a wildcard or age-matched set under the temporary directory, which is shared by other processes. Name the specific paths this session created.",
  "rm.critical-path":
    'this is a recursive force against a path that cannot be recovered: the filesystem root, a top-level directory, $HOME, the working directory or one of its parents, or a "$VAR"/* that expands to one of those when the variable is empty. Re-run with the literal path, or ask the user to delete it.',
  "rm.unassigned-var":
    "this deletes through a variable the command never sets, so the target is whatever the environment happens to hold. Assign it first, or pass the literal path.",
  "disk.raw":
    "this writes to a raw device or formats a filesystem, which destroys everything already on it and cannot be undone. Ask the user before touching block devices.",
  "git.force-push":
    "this rewrites history on the remote and discards commits other people may have based work on. Push a new commit, or use --force-with-lease if the branch really is yours.",
  "git.history-rewrite":
    "this discards uncommitted or committed work with no undo. Commit the work first, or ask the user which changes should be kept.",
  "git.remote-repoint":
    "this points the repository at a different remote, so every later push goes somewhere else. Ask the user to confirm the new URL before changing it.",
  "infra.destroy":
    "this destroys running infrastructure, not local files. Confirm with the user before deleting deployed resources.",
  "sec.disarm":
    "this turns a security check off (certificate verification, a hook, or a sandbox). Fix the underlying problem instead, or ask the user to accept the risk for this call.",
  "sec.priv-esc":
    "this escalates privileges, which the sandbox is specifically there to prevent. Run it as the current user, or ask the user to run it themselves.",
  "fs.git-protected-path":
    "this writes inside .git, where hooks and configuration are code that runs on the user's next git command. Ask the user before changing anything under .git.",
  "agent.self-modify":
    "this edits nib's own configuration or session log, which is the policy judging this call. Ask the user to change their settings.",
  "spawn.unsafe-text":
    "this hands a sub-agent a task describing a destructive command. Narrow the task, or ask the user to approve the command directly.",

  // ── confirms (§5.2) ──
  longCommand:
    "this command is over 2 000 characters, too long for the classifier to read as a whole. Split it into the steps it is doing.",
  "shell.interpreter-inline":
    "this runs code passed inline to an interpreter, so only the interpreter can see what executes. Write the code to a file in the workspace first, so the change is reviewable.",
  "shell.runner-opaque":
    "this launches a command through a runner whose own arguments decide what runs, so the visible command is not the whole call. Invoke the underlying tool directly.",
  "shell.special-var":
    "this assigns PATH, IFS, LD_PRELOAD, DYLD_* or HOME, which changes what every later command in the shell resolves to. Set it on the single command that needs it.",
  "shell.expansion":
    "this substitutes a command or process into the command line, so the text being approved is not the text that runs. Run the inner command first and use its output as a literal.",
  "fs.secret-ref":
    "this references a credential file or secret-shaped variable. Confirm the value is genuinely needed for the task.",
  "fs.write-outside-roots":
    "this writes outside the writable roots for this session. Write inside the workspace, or ask the user to widen sandbox.writeRoots.",
  "fs.protected-path":
    "this edits a path that changes how the project or the editor behaves (CI workflow, git hooks config, shell rc, or editor settings). Confirm the change with the user.",
  "fs.deletes-tests":
    "this removes an assertion from a security-relevant test. Make the code pass instead of relaxing the test, or say why the expectation was wrong.",
  "fs.delete-pre-session":
    "this recursively deletes paths that existed before this session started, so it cannot be recovered from the conversation. Name only what this session created.",
  "net.egress":
    "this sends a request off the machine. Confirm the destination is the one the task needs.",
  "net.private-host":
    "this fetches from a private, loopback or cloud-metadata address rather than a public one. Use the public endpoint, or ask the user about the internal host.",
  "pkg.install-named":
    "this installs a package named on the command line rather than from the lock file, so the dependency is not what the project pinned. Add it to the manifest and install from there.",
  "pkg.publish":
    "this publishes an artifact to a registry, which is visible to everyone and effectively irreversible. Confirm the version and the target registry.",
  "git.amend":
    "this replaces the previous commit. If that commit was already pushed, the remote will reject it; make a new commit unless the user asked for an amend.",
  "git.force-push-lease":
    "this force-pushes with --force-with-lease, which rewrites remote history but stops if someone else pushed first. Confirm the branch is yours to rewrite.",
  "git.push-other-branch":
    "this pushes to a shared branch (a release line or the gh-pages site). Confirm that is the branch the task should update.",
  "mcp.mutating-verb":
    "this MCP tool mutates state on a remote system rather than reading it. Confirm the action is the one the task needs.",
  "spawn.risky-text":
    "this sub-agent task describes deleting or rewriting something broadly. Narrow the description so the child cannot over-read it.",
  unsandboxed:
    "this runs outside the OS sandbox, so the write and network limits the session relies on do not apply. Say why the sandboxed form failed, or ask the user to run it.",
  "parse.failed":
    "this command could not be read as shell, so its real effect is unknown. Rewrite it as a simple command line without dangling operators or nested quoting.",
  "parse.partial":
    "part of this command could not be read as shell. Split the parts the classifier cannot see into their own calls.",

  // ── auto-mode judge (risk/auto.ts): the model's chosen group, not a rule ──
  "auto.destruction":
    "the reviewer judged this would destroy work that cannot be recovered from the conversation (files that predate the session, history, or deployed resources). Name only what this session created, or ask the user to approve it.",
  "auto.exfiltration":
    "the reviewer judged this would send data off the machine that the task does not call for (credentials, private files, or a download piped into a shell). Keep the data local, or ask the user to approve the destination.",
  "auto.security-degrade":
    "the reviewer judged this would weaken a safeguard (skipped verification, a disabled check or sandbox, a relaxed test, or another agent started without permission checks). Fix the underlying problem instead, or ask the user to accept the risk.",
  "auto.trust-boundary":
    "the reviewer judged this would cross a trust boundary (a force push, a different remote, registry or API base URL, a third-party repository, or a tunnel). Stay inside this repository's own branches, or ask the user to confirm the target.",
  "auto.bypass-review":
    "the reviewer judged this would skip human review or act on others' behalf (merging or approving a change, a production flag, a shared-cluster operation, or a bot command). Leave the final step to the user.",
  "auto.user-boundary":
    "the reviewer judged this crosses a limit the user stated earlier in the conversation. Respect that limit, or ask the user whether it still applies.",
  "auto.out-of-scope":
    "the reviewer judged this goes beyond what the user asked for, which does not authorise a riskier action than the request named. Do what was asked, or ask the user before going further.",
};

/** The sentence for one tag, with a safe fallback for a tag that predates this table. */
export function riskReasonText(tag: string): string {
  return RISK_REASONS[tag] ?? `this call matched the ${tag} rule.`;
}

/** Every tag the table knows, for the drift test against rules.ts. */
export function knownReasonTags(): string[] {
  return Object.keys(RISK_REASONS);
}

/**
 * The fixed sentence a block or a classifier-caused ask carries (§3.4). The
 * primary tag leads; the rest are named compactly so the audit row stays
 * readable without burying the reason the user is actually being asked about.
 */
export function formatRiskReason(tier: "block" | "confirm", tags: readonly string[]): string {
  const [primary, ...rest] = tags;
  const lead =
    tier === "block"
      ? `Blocked by nib policy [${primary}]`
      : `Asking first [${primary}]`;
  const also = rest.length > 0 ? ` Also matched: ${rest.join(", ")}.` : "";
  return `${lead}: ${riskReasonText(primary)}${also}`;
}
