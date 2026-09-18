import { isSandboxedLevel, type SandboxLevel } from "../sandbox/seatbelt.js";
import { isGitConfigOperation } from "./git-config-operations.js";
import type { RuleOrigin } from "./rules.js";

/**
 * Foreground Bash session grants (docs/permission-ux-redesign.md).
 *
 * A grant says: "for this session, in this workspace, stop asking me about
 * eligible foreground `run_bash` calls — they are contained by the macOS
 * profile whose exact bytes are hashed here." It is the consent record for an
 * OS-enforced envelope, not a claim that a command is safe, and it is the only
 * thing that lets a Bash ask be skipped without the user seeing it again.
 *
 * Three properties are deliberate:
 *
 * - **In-memory only.** Nothing is written to disk, so a grant cannot outlive
 *   the process or leak into another project's session. An in-process resume
 *   keeps it; a new process starts with none.
 * - **Bound to the profile bytes.** {@link profileHash} is
 *   `sandboxEnvelopeHash(buildSandboxProfile(...))` for the launch this grant
 *   was approved against. Change a write root, the level, or the scratch
 *   directory and the hash changes, so the grant stops matching and the user is
 *   asked again — a grant can never silently widen the write set it was
 *   approved for.
 * - **One per (session, tool).** A grant for a different envelope is dropped as
 *   soon as the mismatch is seen ({@link SessionGrantStore.invalidateOther}),
 *   before the user is asked again — so no approval survives an envelope change,
 *   not even one the user then declines to renew.
 */

/** The only tool a grant currently covers — foreground `run_bash`. */
export type GrantableTool = "run_bash";

/**
 * The containment a launch will actually run under, described by the profile
 * bytes a grant is bound to. Built by the launch and handed to the gate, so the
 * gate compares the hash it was given with the hash the spawn produces rather
 * than reconstructing either one.
 */
export interface BashEnvelope {
  /** `sandboxEnvelopeHash` of the profile this launch will run under. */
  profileHash: string;
  level: SandboxLevel;
  /** Workspace root, for the consent text and the panel. */
  trustedRoot: string;
  /**
   * The write-set the profile actually grants (`profileWriteSet`), for the
   * consent text and the panel. Display only — the hash above is what binds the
   * approval, and it already covers these roots.
   */
  writeRoots: string[];
  /** Nib's private scratch directory, when the launch has one. Display only. */
  sessionTempDir?: string;
}

export interface BashEnvelopeGrant extends BashEnvelope {
  sessionId: string;
  tool: GrantableTool;
  grantedAt: number;
}

export type GrantInput = Omit<BashEnvelopeGrant, "grantedAt">;

/** NUL separator: it cannot occur in a session id or a tool name. */
function keyFor(sessionId: string, tool: GrantableTool): string {
  return `${sessionId}\u0000${tool}`;
}

export class SessionGrantStore {
  private grants = new Map<string, BashEnvelopeGrant>();

  /**
   * Records the user's consent for this session and tool. Callers drop a grant
   * for a *different* envelope first ({@link invalidateOther}) — this writes the
   * envelope the user has just approved, and does so unconditionally so a stale
   * grant can never be left behind by a refresh.
   */
  grant(input: GrantInput): void {
    this.grants.set(keyFor(input.sessionId, input.tool), { ...input, grantedAt: Date.now() });
  }

  /** The active grant for this session and tool, whatever envelope it covers. */
  active(sessionId: string, tool: GrantableTool): BashEnvelopeGrant | null {
    return this.grants.get(keyFor(sessionId, tool)) ?? null;
  }

  /**
   * The grant to *reuse* for a launch with this profile hash — null when there
   * is none, or when the stored grant was approved against different profile
   * bytes (in which case it must not be reused; see {@link invalidateOther}).
   */
  lookup(sessionId: string, tool: GrantableTool, profileHash: string): BashEnvelopeGrant | null {
    const grant = this.active(sessionId, tool);
    if (grant === null) return null;
    return grant.profileHash === profileHash ? grant : null;
  }

  /**
   * Drops a grant that was approved against a different envelope, reporting
   * whether one was dropped. Called when a launch's profile no longer matches
   * the stored grant: the approval covered bytes that no longer apply, so it
   * is revoked even if the user denies the prompt that follows. Forward-only —
   * it cannot undo effects or stop a child that is already running.
   */
  invalidateOther(sessionId: string, tool: GrantableTool, profileHash: string): boolean {
    const grant = this.active(sessionId, tool);
    if (grant === null || grant.profileHash === profileHash) return false;
    this.grants.delete(keyFor(sessionId, tool));
    return true;
  }

  /** Revokes the active grant, reporting whether there was one. */
  revoke(sessionId: string, tool: GrantableTool): boolean {
    return this.grants.delete(keyFor(sessionId, tool));
  }
}

export const bashEnvelopeGrants = new SessionGrantStore();

/**
 * Whether an ask is one the grant may satisfy (docs/permission-ux-redesign.md:
 * "only an ordinary or syntactically unresolved Bash ask, after the deny,
 * guarded, hook and headless checks").
 *
 * Every branch is fail-closed: a call this returns `false` for simply keeps
 * today's prompt. This is the *only* definition — the UI uses it too, so the
 * offer cannot appear on a call the gate would not honor.
 */
export function isEligibleForGrant(input: {
  toolName: string;
  args: Record<string, unknown>;
  /** The winning rule was `builtin-guarded` — a guarded prefix never gets quieter. */
  isGuarded: boolean;
  /** Origin of the winning rule, when one matched. */
  winningRuleOrigin?: RuleOrigin;
  /** The launch's containment, when the session has any. */
  envelope?: BashEnvelope;
}): boolean {
  const { envelope } = input;
  // No OS boundary to bind the consent to (non-macOS, no level, `unrestricted`).
  if (envelope === undefined || !isSandboxedLevel(envelope.level)) return false;
  // Foreground Bash only: background jobs never consume a grant, subagent runs
  // are never handed an envelope, and no other tool has a containment story.
  if (input.toolName !== "run_bash") return false;
  if (input.isGuarded) return false;
  // A rule the user wrote — in config, or accepted from an earlier prompt — is a
  // deliberate standing statement about that command; the grant does not
  // override it (decision 2 in the redesign plan).
  if (input.winningRuleOrigin === "config" || input.winningRuleOrigin === "session") return false;
  // The narrow `.git/config` variant runs under a *widened* profile, so its
  // approval is per-call by construction.
  if (isGitConfigOperation(input.toolName, input.args)) return false;
  return true;
}

/**
 * The refusal for a granted call whose profile is no longer the profile the
 * grant was approved against — a write root, the level, or the scratch
 * directory changed after consent. The command does not run: authority must
 * never be inherited across an envelope change.
 */
export function envelopeChangedError(): string {
  return (
    "SANDBOX_ENVELOPE_CHANGED: the sandbox profile this command would run under " +
    "is not the one the session grant was approved for — a write root, the level, " +
    "or the session scratch directory changed since then. The command was not run " +
    "and the grant was revoked; ask again to approve the current profile."
  );
}
