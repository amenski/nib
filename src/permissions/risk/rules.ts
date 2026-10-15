import { isFileWriteRedirect, type RiskFeatures, type RiskInput, type SegmentFeatures } from "./features.js";

/**
 * The rule-based half of the risk classifier (docs/command-risk-classifier.md
 * §5). Every predicate reads the deterministic feature vector — nothing here
 * parses shell text, and nothing here calls a model.
 *
 * The component is *narrowing-only* by construction: it names a tier, and the
 * caller (risk/index.ts) clamps that tier into the engine's own action. A
 * `block` never becomes an allow and a `confirm` never becomes one either, so
 * no rule added here can widen access. That is locked Decision 5 in
 * docs/security-architecture-plan.md and the reason this file can be read and
 * reviewed rule by rule.
 *
 * Two deliberate departures from the proposal's wording, both noted at the
 * rule that makes them:
 *   - `shell.runner-opaque` does not fire for `make`, which §4.1 lists as a
 *     runner but §10.1 row 40 needs to stay benign.
 *   - `git.push-other-branch` cannot compare against the current branch,
 *     because RiskInput carries no branch (§3.1) — see the rule.
 */

export type RiskTier = "safe" | "benign" | "confirm" | "block";

export interface RiskRule {
  /** The tag the model and the audit row see, e.g. "rm.critical-path". */
  tag: string;
  test: (f: RiskFeatures, input: RiskInput) => boolean;
}

/** §5.1. Ordered: the first hit is the primary reason. */
export const BLOCK_RULES: RiskRule[] = [
  {
    // Another agent started with its own gate disabled: the call hands the
    // rest of the session to a process this policy cannot see.
    tag: "agent.unsafe-spawn",
    test: (f) =>
      f.segments.some(
        (s) => AGENT_PROGRAMS.has(s.program) && s.disarm.some((d) => SKIP_PERMISSION_FLAGS.has(d)),
      ),
  },
  {
    // `curl … | bash`: the body is whatever the network served.
    tag: "net.pipe-to-shell",
    test: (f) => f.pipeToShell,
  },
  {
    // A credential read that also leaves the machine, including the cloud
    // metadata endpoints whose whole purpose is handing out credentials.
    tag: "net.secret-egress",
    test: (f) => f.secretEgress,
  },
  {
    // Declared before rm.critical-path: a wildcard delete in tmp is the more
    // specific description of the same call (§10.1 row 17 names this tag).
    tag: "tmp.wildcard-delete",
    test: (f) => f.tmpWildcardDelete,
  },
  {
    // Recursive force against a path that cannot be lost and recovered —
    // the root, a top-level directory, $HOME, the cwd or its parents, or a
    // variable-driven `"$VAR"/*` that expands to one of those. The tag says
    // `rm` because that is the shape that motivated it; the predicate also
    // covers the recursive mutators (`chmod -R 777 /`, §10.1 row 47), which
    // is what "generalise to recursive on critical" asks for.
    tag: "rm.critical-path",
    test: (f) =>
      f.segments.some(
        (s) =>
          (s.deletes || s.writesFs) &&
          s.recursiveForce &&
          s.targets.some((t) => t.class === "critical"),
      ),
  },
  {
    tag: "rm.unassigned-var",
    test: (f) => f.unassignedVars.length > 0 && f.segments.some((s) => s.deletes),
  },
  {
    // Irreversible block-device writes and the fork bomb. The engine already
    // denies these through BUILTIN_DESTRUCTIVE_RULES; the classifier agrees so
    // that the shadow log and the decision do not disagree about them.
    tag: "disk.raw",
    test: (f) =>
      f.segments.some(
        (s) =>
          /^mkfs(\.|$)/.test(s.program) ||
          (s.program === "dd" && s.text.includes("of=/dev/")),
      ) || f.segments.some((s) => s.text.trim() === ":(){ :|:& };:"),
  },
  {
    tag: "git.force-push",
    test: (f, input) =>
      f.segments.some(
        (s) => s.gitDiscard.includes("push-force") && !remoteNamedByUser(input, s),
      ),
  },
  {
    // `reset --hard`, `checkout -- .`, `restore .`, `clean -f`, `stash drop`:
    // each discards uncommitted work with no undo. Phase 3 may soften these to
    // confirm behind a `git status` probe (proposal §12.10); in the MVP the
    // block reason tells the model to ask the user.
    tag: "git.history-rewrite",
    test: (f) =>
      f.segments.some((s) =>
        s.gitDiscard.some((d) =>
          ["reset-hard", "checkout-dot", "restore-dot", "clean-force", "stash-drop"].includes(d),
        ),
      ),
  },
  {
    tag: "git.remote-repoint",
    test: (f, input) =>
      f.segments.some((s) => s.gitRemoteWrite && !remoteNamedByUser(input, s)),
  },
  {
    tag: "infra.destroy",
    test: (f) => f.segments.some((s) => s.infraDestroy),
  },
  {
    // A security check turned off by hand (`curl -k`, `--no-verify`), unless
    // the user asked for that exact flag in this session.
    tag: "sec.disarm",
    test: (f, input) =>
      f.segments.some((s) => s.disarm.some((flag) => !userSaid(input, flag))),
  },
  {
    tag: "sec.priv-esc",
    test: (f, input) =>
      f.segments.some((s) => s.privEsc) && input.sandbox.level !== "unrestricted",
  },
  {
    // Writing into `.git/` is installing code that runs on the user's next
    // command (hooks, config) — not an ordinary edit, whatever the file.
    tag: "fs.git-protected-path",
    test: (f) => f.path?.protectedPath === "git",
  },
  {
    // nib's own configuration and session transcripts. A model editing the
    // policy it is judged by, or the log of what it did, has left the task.
    tag: "agent.self-modify",
    test: (f) => f.path?.protectedPath === "nib",
  },
  {
    // A sub-agent spawned to do something the same rules would block as a
    // shell call (§4.3 new_task row).
    tag: "spawn.unsafe-text",
    test: (f) => f.spawnText !== undefined && SPAWN_BLOCK_RE.test(f.spawnText),
  },
];

/** §5.2. Ordered: the first hit is the primary reason, the rest are secondary. */
export const CONFIRM_RULES: RiskRule[] = [
  {
    // Declared first so a 12 000-char command reports the length rather than
    // the parse failure it also causes (§10.1 row 44 names this tag).
    tag: "longCommand",
    test: (f) => f.longCommand,
  },
  {
    // `python -c …`, `node -e …`: the code that runs is not in argv.
    tag: "shell.interpreter-inline",
    test: (f) => f.interpreterInline,
  },
  {
    // npx / bunx / docker exec / devbox run: the inner command is opaque, so
    // it is judged as the runner rather than as itself — never benign, and
    // never trusted enough to block on either (§12.1).
    // `make` is excluded: its recipes live in the repository, and §10.1 row 40
    // needs `make test 2>&1 | tee build.log` to stay benign.
    tag: "shell.runner-opaque",
    test: (f) => f.runner !== undefined && f.runner !== "make",
  },
  {
    tag: "shell.special-var",
    test: (f) => f.specialVars.length > 0,
  },
  {
    tag: "shell.expansion",
    test: (f) => f.substitution,
  },
  {
    // Closes the documented guarded.ts gap (`cat .env` through bash is not
    // covered by the static glob rules).
    tag: "fs.secret-ref",
    test: (f) => f.segments.some((s) => s.secretRefs.length > 0) || f.path?.secretRef === true,
  },
  {
    tag: "fs.write-outside-roots",
    test: (f) =>
      f.redirects.some((r) => isFileWriteRedirect(r) && r.class !== undefined && !INSIDE_CLASSES.has(r.class)),
  },
  {
    tag: "fs.protected-path",
    test: (f) => {
      const p = f.path?.protectedPath;
      return p !== undefined && p !== "git" && p !== "nib";
    },
  },
  {
    tag: "fs.deletes-tests",
    test: (f) => f.deletesTests === true,
  },
  {
    tag: "fs.delete-pre-session",
    test: (f) => f.preSessionTarget && f.segments.some((s) => s.recursiveForce),
  },
  {
    tag: "net.egress",
    test: (f) => f.segments.some((s) => s.netEgress),
  },
  {
    tag: "net.private-host",
    test: (f) => f.host !== undefined && HOST_CONFIRM_CLASSES.has(f.host.class),
  },
  {
    tag: "pkg.install-named",
    test: (f) => f.segments.some((s) => s.pkgInstall && !s.pkgFromLock),
  },
  {
    tag: "pkg.publish",
    test: (f) => f.segments.some((s) => s.pkgPublish),
  },
  {
    tag: "git.amend",
    test: (f) => f.segments.some((s) => s.gitAmend),
  },
  {
    // `--force-with-lease` is the safe spelling of a force push: it refuses
    // when the remote moved. Still a prompt — the remote history is the
    // user's, not the agent's — but not the block a bare `--force` earns.
    tag: "git.force-push-lease",
    test: (f) => f.segments.some((s) => s.gitDiscard.includes("push-force-lease")),
  },
  {
    // A push to a branch whose whole purpose is to be shared (a release line,
    // or the gh-pages site). The proposal also asks for `main` "when the cwd
    // branch differs", and RiskInput carries no branch (§3.1), so that half
    // cannot be evaluated here — `git push origin main` from main is routine
    // and is deliberately not a prompt.
    tag: "git.push-other-branch",
    test: (f) => f.segments.some((s) => s.program === "git" && pushRefspecIsShared(s)),
  },
  {
    tag: "mcp.mutating-verb",
    test: (f) => f.mcpVerb !== undefined,
  },
  {
    // A sub-agent asked to do something wide and destructive in prose. The
    // description is checked at spawn time, like Claude Code does, because the
    // child inherits the session's approvals.
    tag: "spawn.risky-text",
    test: (f) => f.spawnText !== undefined && SPAWN_CONFIRM_RE.test(f.spawnText),
  },
  {
    // The call runs outside the OS sandbox: the one layer that makes the
    // prompt-shaping above a backstop rather than the boundary is gone.
    tag: "unsandboxed",
    test: (_f, input) => input.unsandboxed !== undefined,
  },
  // Declared last on purpose. Every rule above is a more specific description
  // of the same call, and "we could not fully parse this" is the weakest thing
  // the classifier can say about it — useful only when nothing else matched.
  // The tier is identical either way, so this ordering costs nothing and
  // gives the model a reason it can act on (§10.1 rows 13 and 16).
  {
    tag: "parse.failed",
    test: (f) => f.parse === "failed",
  },
  {
    tag: "parse.partial",
    test: (f) => f.parse === "partial",
  },
];

/** The ruleset version stamped on every verdict, so a row is self-describing. */
export const RISK_RULESET_VERSION = "risk-1";

const AGENT_PROGRAMS = new Set(["nib", "claude", "codex", "aider", "cursor-agent", "gemini", "opencode"]);
const SKIP_PERMISSION_FLAGS = new Set(["--dangerously-skip-permissions", "--yolo"]);

/** Target classes that need no confirm: the call stays inside the boundary. */
const INSIDE_CLASSES = new Set(["inside-cwd", "build-dir", "write-root"]);
const HOST_CONFIRM_CLASSES = new Set(["private", "metadata", "localhost"]);

/** Branch names that exist to be shared, so pushing to one is not routine. */
const SHARED_BRANCHES = new Set(["prod", "production", "release", "gh-pages"]);

/**
 * A spawn-time text check on a sub-agent's description. Deliberately narrow:
 * it matches the block-tier shell shapes verbatim, not a general reading of
 * prose. A classifier that guessed at intent from a task description would
 * deny ordinary work ("clean up the old branches") — §12.3's consent-scope
 * failure mode, arrived at from the other side.
 */
const SPAWN_BLOCK_RE = /\brm\s+-[a-z]*r[a-z]*f|rm\s+-[a-z]*f[a-z]*r|git\s+push\s+(--force|-f)\b|git\s+reset\s+--hard|git\s+clean\s+-[a-z]*f|drop\s+database/;

const SPAWN_CONFIRM_RE =
  /\b(delete|remove|destroy|drop|purge|wipe|reset|rewrite)\b[^.]{0,40}\b(all|every|each|entire|whole|history|branches|repo|repository|database|users|everything)\b/;

export interface RuleEvaluation {
  tier: RiskTier;
  /** Tags of every hit in the winning tier, primary first. */
  reasons: string[];
  score: number;
}

/**
 * §5.5 precedence over one feature vector: block beats confirm beats the
 * ordinary tiers. A compound command is as risky as its riskiest segment
 * because every predicate quantifies over `f.segments`.
 *
 * `benign` is the fall-through rather than a predicate of its own. §5.3 states
 * it as a list of conditions ("no net", "no secrets"), and the first of those
 * cannot be a condition: `git push origin feature` reaches the network and is
 * explicitly benign (row 24). The conditions that do carry weight — an
 * outside-roots write, a secret reference, an unparsed command — each have
 * their own confirm rule above, so the fall-through reaches the same verdicts
 * §5.3 asks for without a second, contradictory test.
 */
export function evaluateRiskRules(f: RiskFeatures, input: RiskInput): RuleEvaluation {
  const blockHits = BLOCK_RULES.filter((r) => r.test(f, input));
  if (blockHits.length > 0) {
    return {
      tier: "block",
      reasons: blockHits.map((r) => r.tag),
      score: 1,
    };
  }

  const confirmHits = CONFIRM_RULES.filter((r) => r.test(f, input));
  if (confirmHits.length > 0) {
    return {
      tier: "confirm",
      reasons: confirmHits.map((r) => r.tag),
      score: Math.min(0.7 + 0.1 * (confirmHits.length - 1), 0.95),
    };
  }

  if (isSafe(f)) return { tier: "safe", reasons: [], score: 0 };
  return { tier: "benign", reasons: [], score: 0.2 };
}

/**
 * §5.4 `safe`: proven read-only, no redirect, and every path it names inside
 * the workspace. Read-only is the engine's own proof
 * (`classifyCommandSegment`), not a second list — a command the engine cannot
 * prove read-only is never called safe here.
 */
export function isSafe(f: RiskFeatures): boolean {
  if (f.kind === "shell") {
    if (f.parse !== "parsed") return false;
    if (f.segments.length === 0) return false;
    if (f.redirects.some((r) => r.target !== "" || r.heredoc)) return false;
    if (f.segments.some((s) => !s.readOnly)) return false;
    return f.segments.every((s) => s.targets.every((t) => INSIDE_CLASSES.has(t.class)));
  }
  if (f.kind === "path-read") return f.path !== undefined && f.path.class === "cwd";
  return false;
}

/**
 * The remote a segment acts on, read from its argument positions:
 * `git push <remote> <ref>` and `git remote <add|set-url> <remote> <url>`.
 */
function remoteNamedByUser(input: RiskInput, segment: SegmentFeatures): boolean {
  const nonFlags = segment.text.trim().split(/\s+/).filter((t) => t !== "" && !t.startsWith("-"));
  const remote = segment.verb === "remote" ? nonFlags.slice(2)[1] : nonFlags[2];
  return userSaid(input, remote ?? "");
}

function userSaid(input: RiskInput, token: string): boolean {
  if (!token) return false;
  const needle = token.replace(/[\^$.*+?()[\]{}|\\]/g, "\\$&");
  const re = new RegExp(`(^|[^\\w-])${needle}([^\\w-]|$)`, "i");
  return input.session.userMessages.some((m) => re.test(m));
}

/** A push whose refspec names a branch that exists to be shared. */
function pushRefspecIsShared(segment: SegmentFeatures): boolean {
  if (segment.verb !== "push") return false;
  return segment.text
    .trim()
    .split(/\s+/)
    .some((token) => {
      const [, branch] = token.split(":");
      return SHARED_BRANCHES.has((branch ?? token).toLowerCase());
    });
}
