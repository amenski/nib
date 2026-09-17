# Bash permission UX redesign

**Status:** proposal · reviewed against source 2026-09-16 · no behavior changed

## Problem

The deterministic `command-classifier.ts` returns `proven-read-only` or
`unknown`, but `PermissionEngine.resolveBash()` does not consume that result.
It is recorded in the capability plan, audit, and session metrics. It removes
no prompt. The original `timeout 60 python3 mcp_probe.py ...` call remains
unknown because the script can do anything, and the current Bash normalizer
forces `timeout` calls to ask. An executable-name allowlist cannot prove which
files a command reads or writes: even `cat` can read a project secret, and Git
behavior depends on repository configuration.

The product goal is fewer repeated prompts for an agent working inside a
bounded workspace, with the permission UI stating the actual authority given.
The goal is **not** to infer arbitrary program behavior from a command string.

## Recommended design

Use two execution paths, with one source of permission truth:

1. **First-party reads.** `read_file`, `list_files`, `glob`, and `search`
   already have path-aware permission handling and can read ordinary project
   data without prompts. Encourage the agent to call these for exploration.
   Secret-adjacent paths keep their existing guard. Add a dedicated Git read
   tool only if real usage shows `git status`/`diff` prompts remain a major
   source of friction; do not label arbitrary Git invocations read-only.
2. **Explicit sandboxed Bash session grant.** On the first eligible Bash ask,
   offer `Run once`, `Allow sandboxed Bash in this workspace for this session`,
   and `Deny`. The session choice covers later foreground `run_bash` calls
   under the *same effective sandbox envelope*, including opaque wrappers,
   interpreters, tests, and package scripts. It grants execution within that
   envelope, not a claim that the command itself is read-only.

An envelope is the canonical workspace root, profile level, effective write
roots, child read boundary, and network policy. Store the grant in memory for
this interactive session only. A change to any envelope field invalidates it.
Derive that comparison from the generated Seatbelt profile text, or a hash of
it, rather than from an enumerated field list: the write-set is computed per
launch (`src/sandbox/write-roots.ts`), so two launches of the same level can
produce different profiles, and a hand-maintained list can disagree with the
text Seatbelt was actually handed. This profile-hash approach is accepted for
the proposal. Key the grant by interactive session and foreground tool as
well; use the exact profile bytes passed to the spawn, not a separately
reconstructed profile. Each call still passes ordinary permission checks. A
newly added profile rule then invalidates stale grants automatically.
The grant is unavailable when containment is disabled, unrestricted, or
unsupported. Actual child launch must use the envelope that was approved.
If Seatbelt refuses to apply at spawn time, the child must not execute, the
session grant must be revoked, and the failure must be shown to the user.
There must be no unsandboxed retry. The existing fail-closed release gate was
measured in a managed macOS runner that refuses nested Seatbelt; this grant
adds the separate requirement to recognize the failure and revoke itself.

This needs a new detection path. Today `runBashTimed` reports a nonzero exit
and stderr from `sandbox-exec`, which could also be ordinary command output;
searching stderr for `sandbox_apply` is not a reliable distinction. Add a
trusted launch step *inside* the applied profile that signals readiness to
Nib over a dedicated pipe before executing the user command. The command must
not be able to forge or retain that pipe. Put this protocol in the shared
`src/sandbox/launcher.ts` launch boundary so Bash, MCP, hooks, statusline, and
notification children receive the same failure behavior; preserve direct
argv semantics for MCP and notifications. If readiness is absent, treat the
attempt as a containment failure, revoke any Bash grant, and show a specific
error. Verify this new signal in both capable and refusing macOS runners.

Every call still passes explicit deny rules, profile checks, and the built-in
guards. The grant satisfies only an ordinary or syntactically unresolved Bash
ask after those checks. It cannot approve an explicit deny, a guarded ask,
`run_bash_background`, a persistent rule, an MCP call, or the narrow
`.git/config` trusted profile variant. Those require their existing separate
decisions. The old `autoApprove` Bash bypass should be consolidated with this
grant rather than leaving two ways to bypass prompts; no existing setting
should silently acquire the broader grant.

**Subagent decision:** the grant belongs to the interactive root agent and is
not inherited by subagents. Subagents may still use existing first-party read
tools and exact permissions; an opaque Bash call without its own interactive
approval stays denied in headless execution. This avoids silently extending
one broad consent to autonomous delegated work. Revisit only with an explicit
subagent consent design.

## Consent text and limits

The prompt must say, in plain language, that subsequent commands may read and
change any file in the approved project and private scratch space, run project
scripts, and launch descendants. Writes outside the approved roots remain
denied by the active macOS sandbox: at `workspace-write` those roots are the
project and Nib's private per-session scratch directory — not the machine's
shared temporary directories and not the package-manager cache. Name that
set explicitly rather than implying it follows from the level; it is computed
per launch, and two launches of the same level can produce different sets. In
the user-facing copy, state the narrower observed network claim: direct child
connections are denied in the tested profile, while macOS system name
resolution may still occur outside the child. It must also say that current read containment is `$HOME`-shaped:
files outside `$HOME` can still be readable. Project secrets such as `.env`
are inside the approved workspace and can be read by a script, even though
direct file tools guard them. The user can revoke the grant for future
launches; revocation does not undo effects or stop a process already running.

For this release, retain the `$HOME`-shaped child read boundary and disclose
it. Warn when the workspace is outside `$HOME`, where the current home deny
does not protect sibling files near that workspace. Broader read isolation
would be a separate compatibility project, not an implied property of this
grant.

This is a deliberate broad session consent. If that scope is unacceptable,
keep per-command prompts for arbitrary code. A command classifier cannot
provide the missing isolation.

## What happens to the current classifier

Remove `proven-read-only` as a user-facing safety claim and remove its
false-allow metric once the new prompt path is measured. Keep the conservative
tokenizer where `git-config-operations.ts` needs it for its separate one-time
grant, or move it there. Permission metrics should count actual prompts,
session grants, grant reuses, denials, and invalidations. Do not turn the
classifier result into an allow rule.

## Untrusted output prerequisite

The current `--- END WEB CONTENT ---` marker can appear inside attacker
controlled tool output and make later text appear outside the untrusted block
(`docs/security-architecture-plan.md`, residual 3). A session grant removes a
human prompt that might otherwise interrupt the next Bash call after such
output. Before enabling the grant, consolidate the duplicated wrappers in
`untrusted-content.ts`, `web-fetch.ts`, and `web-search.ts` and the duplicated
control-character sanitizer in `untrusted-content.ts` and
`web-fetch-guard.ts`. Then make payloads unable to forge the trust boundary.
Keep the model-facing output clearly marked as data. Marker hardening reduces
one concrete spoofing route but does not make model behavior a security
boundary. The OS sandbox remains the limit
on what a prompted or unprompted command can do.

## Verification before shipping

- In a capable macOS runner, a first `timeout 60 python3 ...` asks once;
  later foreground commands under the same envelope reuse the explicit
  session grant. Denies and guarded asks still win, and a changed write root,
  profile, workspace, or network policy asks again.
- Verify that `run_bash_background`, `.git/config` trusted operations,
  headless mode, and unsupported platforms cannot use the grant. Inject a
  Seatbelt application failure through an injectable spawn seam or a process
  mock: assert no readiness signal, no command body, no fallback, a specific
  user-visible error, and grant revocation. `sandbox-exec` is invoked by
  absolute path (`/usr/bin/sandbox-exec`), so a PATH shim cannot inject this
  case. Also observe the real failure on a macOS runner that refuses nested
  Seatbelt before shipping. An already running child retains its OS profile
  after timeout migration or detachment.
- Extend the existing synthetic fixtures in `seatbelt.test.ts`,
  `child-paths.test.ts`, `egress.test.ts`, and `hostile-input.test.ts` for the
  grant path. They already prove ordinary workspace work succeeds while
  sibling and Git-hook writes, home canary reads, and direct connections fail
  under the profile. The outside-`$HOME` canary is now pinned in
  `seatbelt.test.ts` ("a canary outside $HOME is still readable when
  contained"): the contained read is asserted to **succeed**, with an
  unsandboxed control reading the same file. That characterizes the disclosed
  residual and fails if the boundary is tightened without a matching doc
  change, rather than leaving the previous one-off observation in the plan.
- Replace the marker-forgery characterization test with a regression showing
  that payload text cannot emit an apparent trusted block terminator through
  Bash, file, fetch, or search output. Test a subsequent proposed Bash call
  against the grant and sandbox boundary; do not infer model resistance from
  delimiter formatting alone.
- Compare prompts per 100 Bash calls before and after on realistic local
  traces. Count grant reuse separately from classifier labels; do not call a
  prompt reduction a safety improvement.

## Out of scope

No LLM permission judge, hostname guessing from command names, automatic
approval of arbitrary scripts, persistent `allow all Bash`, or new network
exception. The future network broker remains governed by
`docs/security-network-broker.md`.
