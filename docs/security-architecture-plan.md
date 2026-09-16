# Nib security architecture plan

**Status:** partially implemented · verified 2026-09-16 · release gates open

This is the reviewed architecture and release-gate record. Phases 0–4 have
implementation commits, but their checklist completion does **not** imply that
the release security objective is met. The real macOS child-process probes in
the release-gate section below found residual confidentiality and persistence
gaps. Code and tests take precedence over the target architecture here.

## Final decision

Build a capability-based authorization kernel and default OS sandbox first.
Add a small deterministic command classifier afterward as a prompt-reduction
feature, never as the security boundary.

The original P0 empty-scope and policy-parity defects were fixed in Phases
0–1. Do not treat that as proof that arbitrary child processes are confined:
the release gates below remain open.

## Architectural decisions to lock before implementation

These decisions deliberately keep the first release small and make its security
claim testable:

1. **Authorization is over capabilities, never raw command text.** Raw text may
   remain in the audit record and UX, but it is not the thing that a persistent
   permission grants.
2. **A single tool call has one extracted, immutable plan.** Policy, approval UI,
   sandbox launcher, and handler must all use that plan. No layer may re-parse a
   more permissive view of the original arguments.
3. **Unknown means no persistent grant.** It may be approved once with an honest
   full-risk prompt, but cannot create a session, permanent, or auto-approve
   permission.
4. **The first sandbox promise is filesystem containment plus no direct egress.**
   Seatbelt cannot safely implement hostname allowlists for arbitrary binaries.
   A host-aware network broker is a later, separately designed component; until
   it exists, any profile allowing direct network must say that it allows broad
   network access.
5. **The classifier has no authority to widen access.** It can reduce prompts
   only after the kernel and sandbox already bound the operation. A false
   classifier result therefore changes UX, not machine authority.

### Explicit non-goals for the first security release

- Do not attempt to infer arbitrary Python, Node, shell-script, package-manager,
  or binary behavior from command strings.
- Do not offer a global "always allow Bash" or "always allow patches" switch.
- Do not retrofit a host allowlist by matching `curl`, `wget`, or a small set of
  executables; interpreters, Git, DNS, and dependencies bypass that model.
- Do not promise that approval can undo a remote mutation, data exfiltration, or
  background process.

## Assumptions and security objective

- Repository files, project instructions, web results, command output, MCP
  output, dependencies, and model-generated tool arguments are untrusted.
- Nib may run on a developer account that can access valuable source code,
  credentials, browser/application data, cloud tooling, and Git remotes.
- A user approval is consent, not containment. A mistaken approval must not give
  an operation unlimited access to the computer.
- The primary objective is to bound confidentiality, integrity, persistence,
  network, and availability damage even after prompt injection or model error.

## Historical P0 defects (fixed in Phase 0–1)

### P0.1 — Background Bash policy bypass

`PermissionEngine.resolve()` applies Bash normalization only when the tool name
is exactly `run_bash`. `run_bash_background` falls through the generic subject
path, so destructive patterns, guarded network commands, compound segmentation,
and unresolved-wrapper handling do not apply.

Approving one background call creates an exact rule with an empty subject. A
direct engine probe confirmed that this rule then authorizes unrelated future
background commands, including destructive or interpreter commands.

### P0.2 — `apply_patch` target bypass

Patch targets are embedded in `args.patch`, but the permission engine and
profile inspect only `args.path` or `args.filePath`. The handler extracts paths
from `+++ b/...` and reads/writes them without an independent containment check.

Approving one patch creates an empty-subject rule. A direct engine probe
confirmed that it then authorizes unrelated patches, including a patch whose
target contains `../../`.

### P0.3 — Auto-approve amplifies missing classifications

Auto-approve upgrades an ordinary `ask` when it is neither marked unresolved
nor guarded. Because the affected tools never reach the correct classifiers,
their initial asks can be silently upgraded.

### P0.4 — No active containment in the configuration at discovery

At discovery, the user configuration had no explicit containment settings.
The effective defaults now enable workspace-write and Seatbelt on macOS unless
the user explicitly opts out. This does not override the residual gaps below.

## Complete threat surfaces

1. Foreground and background shell execution.
2. Built-in read/write/edit/search/image tools.
3. Project instructions and repository prompt injection.
4. Package managers, build systems, tests, compilers, and lifecycle scripts.
5. MCP server startup and MCP tool calls.
6. Hooks, statusline providers, notification scripts, and custom agents/skills.
7. Web fetch/search, Bash networking, DNS, proxies, and SSRF.
8. Model-provider requests containing files, outputs, images, and secrets.
9. Git worktree, `.git` metadata, hooks, remotes, credentials, and pushes.
10. Shell startup files, LaunchAgents/cron, SSH files, browser/application data,
    package caches, PATH executables, and other persistence targets.
11. Session transcripts, prompt history, debug logs, memory, and checkpoints.
12. CPU, memory, process, background-job, disk, network, and API-cost exhaustion.
13. Sandbox-unavailable and cross-platform degradation paths.
14. Misleading prompts, over-broad persistent grants, and approval fatigue.
15. External irreversible effects: cloud, database, deployment, email, Git
    hosting, containers, clusters, and other remote systems.

## Target architecture

```text
untrusted input
      |
model proposes tool call
      |
tool-specific capability extraction
      |
canonical capability plan
      |
policy decision + human consent where required
      |
OS-enforced sandbox / network broker
      |
handler revalidates authorized targets
      |
execution + secure audit
```

### 1. Canonical capability plan

Every effectful tool must declare all intended effects before authorization:

- `fs.read(path)`
- `fs.write(path)`
- `net.connect(host, port)`
- `process.execute(command)`
- `secret.read(resource)`
- `external.mutate(service, target)`
- `persistence.create(target)`

Requirements:

- Canonicalize paths using nearest-existing-ancestor realpath resolution.
- Represent multi-target calls as multiple capabilities.
- Missing or unparseable targets fail closed.
- Empty subjects can never be stored as allow rules.
- Authorization and handler execution consume the same immutable plan.
- The handler revalidates paths immediately before access.
- Adding a new effectful tool without a capability extractor is a test/build
  failure, not a permissive runtime fallback.

### 2. OS containment as the enforcement boundary

Target coding profile (not all properties are implemented):

- Write only to the project and a per-session temporary directory.
- Read the project and explicit SDK/toolchain roots; deny sensitive home paths.
- Deny generic access to `.git`, shell startup files, SSH/cloud credentials,
  browser profiles, login items, LaunchAgents, and user executable locations.
- Deny direct network access by default.
- Do not claim per-domain enforcement unless the command is routed through a
  purpose-built broker. In the interim, a network-enabled profile is an explicit
  broad-egress exception; do not depend on recognizing `curl` because Python,
  Node, Git, package managers, and arbitrary binaries can create connections.
- Apply containment to foreground Bash, background Bash, MCP servers, hooks,
  statusline providers, and notification scripts.
- If containment is unavailable, auto-approve fails closed.

Child-process reads are now bounded (2026-09-16): both sandboxed levels
subtract `$HOME` from the blanket `(allow file-read*)` grant and re-allow only
the workspace, the level's authorized roots, and a narrow documented set of
Git/npm home subpaths. A sandboxed child can no longer read a sibling project
or a `$HOME` credential. This boundary is `$HOME`-shaped, not a general
filesystem allowlist — reads outside `$HOME` remain broad, other-user homes
under `/Users` are not covered, and file existence/metadata outside `$HOME`
leaks. An attempt to enumerate every read root a macOS toolchain needs was
abandoned the same day: the profile aborts before `exec`.

The workspace write grant includes `.git`, so tool-level guards do not
constrain an interpreter or package script writing hooks. That gap is now
closed mechanically rather than by a classifier: both sandboxed levels emit
Git integrity rules that deny writes to hook files, the `hooks` directory
node, `config` (and `config.lock`), and `credentials` under any `.git`
directory at any depth — a regex, not a fixed `<root>/.git` path, because
nested repositories and submodule gitdirs live at arbitrary depth. Hook
templates (`*.sample`) stay writable, and the index, objects, refs, HEAD,
and logs are untouched, so ordinary `add`/`commit`/`stash`/`branch`/`tag`/
`checkout`/`worktree` need no exception at all.

Two limitations are recorded rather than claimed closed:

- **Repository creation and wiring needed a trusted path — now implemented
  (2026-09-16, same day).** `git init`, `git remote add`,
  `git config <write>`, `git clone`, and `git submodule add` all write `.git`
  config, so all five fail under the deny. The deny does not get to break a
  workflow silently, and it no longer does: an explicit one-time approval of
  one of those commands now runs it under a workspace-scoped variant that
  re-allows `.git/config` (and the `hooks` directory node, which `git init`
  needs for its templates). See "The approved-operation variant" below.
- **A repository whose `.git/hooks` is already a symlink** to a directory
  outside `.git` still resolves hook writes to ordinary workspace paths,
  which no path-based SBPL rule can distinguish. A child can no longer
  *create* that shape (the `hooks$` rule denies the node, so it cannot
  create, rename, or remove anything named `.git/hooks`), but a user who
  set it up deliberately is outside the deny.

#### The approved-operation variant (gate 2, trusted half)

The rule the design obeys: **the classifier decides what the prompt offers;
the user's explicit approval is the grant.** `isGitConfigOperation`
(`src/permissions/git-config-operations.ts`) is a pure, conservative
predicate over the whole command — every segment of a compound command must
qualify, wrappers/sudo/env-prefixes/command substitution disqualify it, the
executable must be a bare `git` or one under a standard bin directory (so
`./git` inside the workspace gets nothing), and no global Git option may
precede the subcommand. It is not an authorization decision: it only decides
whether the prompt offers the variant.

The grant flows one way and does not outlive the call: `gateCall`
(`src/agent.ts`) sets `ToolExecOptions.approvedGitConfigWrite` **only** in the
branch reached when `askUser` returned a plain `true` — auto-approve posture
returns `"posture"` and never grants, and a persisted rule resolves to
`action: "allow"` and never reaches that branch at all. `App.tsx` marks these
calls `oneTimeOnly` (the same suppression `run_bash_background` and
`apply_patch` already use), so the prompt offers only once/deny and there is
no session/always answer to persist in the first place. The value is a
per-call argument (`ToolExecOptions`), deliberately not a `ToolContext` field:
that object is a per-run module singleton and could not express "this call
only". The whole chain is covered by tests in `src/agent.test.ts`
("approved-operation grant"), `src/permissions/git-config-operations.test.ts`,
and the "approved variant" cases in `src/sandbox/seatbelt.test.ts`.

Measured both directions (2026-09-16, disposable fixtures, unsandboxed
controls):

| Case | Without grant | With grant |
| --- | --- | --- |
| `git remote add origin ./path` in the workspace | denied | runs; `remote.origin.url` lands in `.git/config` |
| `mkdir fresh && cd fresh && git init -q` | fails; no `.git/config` | succeeds; config and hook templates exist |
| `git config nib.probe yes` in the workspace | denied | runs; value readable back |
| `.git/hooks/pre-commit` and `.git/credentials` by a Node child | denied | **still denied** |
| `.git/config` under a configured external write root | denied | **still denied** |
| workspace path containing regex metacharacters (`ws.v1`) | — | grant works in `ws.v1` and does **not** match the sibling `wssv1` |

Scope is the workspace root alone, not the whole `resolveWriteRoots` set —
the external-write-root row above is the deliberate consequence, and it is
the fail-closed direction. `strict-sandbox` ignores the flag entirely
(asserted in the profile-text test): widening a read-only level into "may
write `.git/config`" would be a different level's contract. The `hooks`
directory allow exists only so `git init` can lay down `*.sample` templates;
hook *files* and `credentials` are not re-allowed, which the test asserts by
enumerating every `(allow file-write* (regex …))` line in the granted profile.

### 3. Consent and approval semantics

- Prompts describe actual effects: files, domains, secrets, persistence, and
  external mutations.
- `once` approves only the current immutable capability plan.
- `session` and `always` grants use canonical resources, never raw UI strings.
- Do not offer persistent approval for unknown targets, unresolved shell,
  secrets, persistence, project-boundary crossings, or irreversible external
  effects.
- Auto-approve applies only to low-risk capabilities already confined by the
  sandbox. It never upgrades an arbitrary ordinary ask.

### 4. Conservative deterministic classifier

Classifier outputs:

- proven read-only
- confined project write
- network
- sensitive read
- destructive or persistent
- irreversible external effect
- unknown

Rules:

- Unknown always prompts.
- Parse the whole compound command; most restrictive segment wins.
- Recursively unwrap only wrappers whose structure is fully understood.
- Redirection, substitution, interpreters, executable scripts, aliases,
  command-carrying wrappers, and dynamic evaluation are unknown unless their
  effects come from a stronger execution manifest.
- `timeout 60 python3 mcp_probe.py ...` is arbitrary program execution after
  unwrapping `timeout`; it is not proven read-only. Prompt reduction for such a
  command comes from containment, not optimistic classification.
- Risk copy is generated from classified capabilities, not a static tool label.

## Implementation phases and acceptance criteria

### Phase 0 — Immediate containment

1. [DONE] Reject empty-subject approval rules.
2. [DONE] Force background Bash and `apply_patch` to prompt without persistent-grant
   options until their capability extraction is fixed.
3. [DONE] Prevent auto-approve from upgrading calls with missing capability data.
4. [DONE] Warn prominently when Nib starts without active containment.
5. [DONE] Add a regression test that rejects an allow rule whose target is empty,
   missing, or non-canonical before it can be persisted.

Verify:

- Approving one background call does not authorize a different command.
- Approving one patch does not authorize a different target.
- No effectful tool can resolve `allow` from an empty subject.
- An unknown or uncontained call offers only one-time consent and clearly states
  that no sandbox boundary is active.

### Phase 1 — Unified capability kernel

1. [DONE] Add the capability-plan type and tool extractor contract.
2. [DONE] Route foreground and background Bash through one shell-policy function.
3. [DONE] Parse and authorize every `apply_patch` target before preview/execution.
4. [DONE] Revalidate containment in every file-writing handler.
5. [DONE] Add cross-tool policy-parity tests generated from the registry.

Verify:

- `../../`, absolute paths, and symlink escapes are blocked or explicitly
  approved at their real target.
- Every registered effectful tool has a non-empty capability plan.
- Foreground/background versions of the same command receive the same decision.

### Phase 2 — Default sandbox and network broker

1. [DONE] Enable the safe workspace profile by default.
2. [DONE] Add direct-tool sensitive-read denials and per-session temp storage.
   Child-process sensitive-read containment remains an open release gate.
3. [DONE] Block direct egress by default. A temporary broad-egress exception
   is deliberately deferred: it requires a host-aware broker that mediates all
   child-process egress. See `docs/security-network-broker.md`.
4. [DONE] Fail closed for auto-approved execution when sandboxing is unavailable.
5. [DONE] Contain MCP servers and lifecycle subprocesses with appropriate profiles.

The host-aware broker remains deliberately out of this phase unless a concrete
design can prove that all egress-capable processes are forced through it. It is
not a shortcut for Phase 2 acceptance.

Verify with real exploit attempts:

- Write `~/.zshrc`, `~/.ssh/authorized_keys`, a LaunchAgent, `.git/hooks`, and
  a sibling-project file. Use synthetic paths only until a safe isolated home
  fixture can be constructed; never put a probe in the real user account.
- Exfiltrate through curl, Python, Node, Git, DNS, and a package lifecycle
  script.
- Spawn a detached/double-forked process and verify containment persists.
- Start a malicious MCP server and verify that it cannot read secrets or make
  unapproved connections.

### Phase 3 — Persistence and recovery hardening

1. [DONE] Use `0700` state directories and `0600` files.
2. [DONE] Redact debug requests/tool arguments or label raw debug mode explicitly.
3. [DONE] Add retention controls and checkpoint total-byte limits.
4. [DONE] Expand checkpoint secret exclusions while documenting that filename lists
   are defense in depth, not a complete secret detector.
5. [DONE] Make undo UI explicit about processes, network calls, remote mutations, and
   excluded/untracked data that cannot be restored.

Verify:

- State permissions are correct under a permissive umask.
- Representative arbitrary secrets do not appear in normal logs.
- Huge-file workspaces cannot exhaust disk through checkpoints.

### Phase 4 — Classifier and approval UX

1. [DONE] Add the deterministic classifier behind the capability kernel.
2. [DONE] Fix exact compound-command approval semantics.
3. [DONE] Replace generic risk copy with capability summaries.
4. [DONE] Measure prompt count and classifier false-allow rate separately.

Verify:

- Read-only pipelines avoid unnecessary prompts when fully understood.
- Wrappers, interpreters, substitutions, redirections, aliases, and encoded
  commands never receive a false safe classification.
- A classifier bug cannot escape the sandbox boundary.

## Release gates (2026-09-16 review)

The implementation checklist above is complete, but this is **not ready for a
security release**. An elevated test runner was needed because the managed
runner cannot nest Seatbelt or bind a loopback listener. The following probe
used the actual `sandboxPrefix` with a disposable workspace, sibling directory,
private scratch, and a synthetic canary; it removed all fixture files afterward:

| Probe | Observation |
|-------|-------------|
| Workspace control write | Allowed |
| Sibling write | Denied (`Operation not permitted`) |
| Sibling canary read via Node | **Allowed** — confidentiality gate failed |
| `.git/hooks/pre-commit` write via Node | **Allowed** — persistence gate failed |
| Node direct loopback connect | Denied (`EPERM`) |
| Python direct loopback connect | Denied (`Operation not permitted`) |
| Git HTTP to loopback port 9 | Failed to connect, but output did not prove the denial was specifically Seatbelt |
| npm script writing `.git/hooks/post-checkout` | **Allowed** — same persistence gap through a dependency script |
| Detached Node descendant writing sibling | Denied (`EPERM`); in-workspace result marker succeeded |

The fixture used only disposable canaries, not the user's actual credentials.
The npm script and detached-descendant cases exercised child-process
inheritance. Local stdio MCP's specific launcher still needs a two-direction
adversarial integration pass. Git's failure alone is not evidence of a
Seatbelt network denial, and DNS, remote destinations, or all egress mechanisms
were not demonstrated by these loopback probes.

The complete Vitest run in the elevated macOS test runner passed: 144 files,
2,092 tests passed, two skipped. The managed runner's run failed its Seatbelt
integration file because nested `sandbox_apply` and loopback `listen` were
denied by that runner; this was not a product-test failure in the elevated run.

### Re-probe, 2026-09-16 (same day, implementing agent)

Correction to the environment note above: nested Seatbelt **does** work in the
session shell used for this work, and loopback `listen` binds. Both were
verified directly — a `deny default` profile killed a denied read with
`SIGABRT` while the `(allow file-read*)` control read the same file, so the
denials below are causally attributable to the profile rather than to the
runner. The "managed runner cannot nest Seatbelt" observation is therefore
environment-specific, not a property of the product tests.

**Child read boundary (gate 1) — addressed.** The profile now subtracts
`$HOME` from `(allow file-read*)` and re-allows only the workspace, the level's
authorized roots, and a narrow Git/npm home set. Probed with a disposable
fake-home fixture containing synthetic canaries only:

| Probe | Before | After |
|-------|--------|-------|
| Sibling canary read (Node) | Allowed | **Denied** |
| Sibling canary read (shell `cat`) | — | **Denied** |
| Sibling canary via workspace symlink | — | **Denied** |
| Sibling directory `readdir` | — | **Denied** |
| Synthetic `$HOME` canary (outside workspace) | — | **Denied** |
| `$HOME` shell expansion to the canary | — | **Denied** |
| `~/.ssh`, `~/.aws`, `~/.zshrc` canaries | Allowed | **Denied** |
| Toolchain battery (25 commands: shell, Git, Node + module resolution, Python, npm, temp, subprocess) | Allowed | Allowed (25/25) |

Control direction: every canary leaks under `(allow default)` and under
`unrestricted`, so the denials are not fixture artifacts. Permanent regression
tests live in `src/sandbox/seatbelt.test.ts` ("child read boundary").

Residuals recorded for this gate: the boundary is `$HOME`-shaped, so reads
outside `$HOME` (`/tmp`, `/private`, other-user homes under `/Users`) stay
broad; file existence and metadata outside `$HOME` leak. Gate 1 is therefore
**closed for `$HOME`-resident secrets and siblings**, which is the release
scenario, but the weaker non-`$HOME` claim is not made.

Full suite after the change: 144 files, 2,098 tests passed, two skipped.

**Correction to the gate-1 implementation (found in review, same day).** The
read boundary's re-allow list originally resolved each entry through its
nearest *existing* ancestor. That is a latent bypass: an absent `~/.cache`
resolves to `$HOME`, which emits `(allow file-read* (subpath "$HOME"))`
*after* the deny, and last-matching-rule-wins then voids the entire
boundary. The probe passed only because every entry happened to exist on the
test machine. The re-allow list now resolves each entry with `realpathSync`
and skips it when absent — a path that does not exist needs no read grant.
A platform-independent regression test asserts the profile never contains an
`(allow file-read* (subpath "<home>"))` line for the real home directory.

**Git integrity (gate 2, deny half) — addressed.** Both sandboxed levels now
deny writes to hook files, the `hooks` directory node, `config`/`config.lock`,
and `credentials` under any `.git` directory. Probed with disposable local
repositories (synthetic content, offline; `protocol.file.allow=always` and
local paths only):

| Probe | Before | After |
|-------|--------|-------|
| `.git/hooks/pre-commit` write (Node) | Allowed | **Denied** |
| `.git/hooks` write (npm lifecycle script) | Allowed | **Denied** |
| `.git/hooks/*` write (shell redirect) | — | **Denied** |
| `.git/config` write (Node) | Allowed | **Denied** |
| `.git/credentials` write | — | **Denied** |
| Nested repo `sub/.git/hooks/pre-commit` | — | **Denied** |
| Submodule gitdir `.git/modules/sub/hooks/pre-commit` | — | **Denied** |
| Submodule gitdir `.git/modules/sub/config` | — | **Denied** |
| Child re-points `.git/hooks` at a writable directory, writes through it | — | **Denied** (hooks dir node) |
| `git status` / `log` / `diff` / `add` / `commit` / `stash` / `branch` / `tag` / `worktree add` | Allowed | Allowed (all) |

Every deny case is paired with an unsandboxed control that performs the same
write successfully, so a passing test cannot be a fixture that was never
writable. Permanent tests live in `src/sandbox/seatbelt.test.ts` ("git
integrity"). The trusted half of gate 2 — the narrow route back for the five
workflows this deny breaks — is "The approved-operation variant" above, with
its own measured table.

Two corrections were made *because* the probes were two-directional. First,
the round-1 regex (anchored on a literal `.git/hooks/`) was measured to
**miss** submodule gitdirs at `.git/modules/<name>/`, leaving the escape open
one level down; the shipped rule allows a `(/.*)?` hop. Second, the first
symlink probe used a dangling relative link, so its apparent denial proved
nothing; with a valid link the write **succeeded**, which is what led to
denying the `hooks` directory node.

Remaining work before declaring the gates below passed:

1. ~~Enforce a narrow child-process read boundary for account secrets,
   including symlink and home-directory variations; test denied canaries and
   allowed ordinary project/toolchain reads.~~ **Done 2026-09-16** — see the
   re-probe table above and the `child read boundary` tests. The non-`$HOME`
   residual remains open and is recorded rather than claimed closed.
2. ~~Build the trusted path for explicitly approved Git operations.~~ **Done
   2026-09-16** — see "The approved-operation variant" above: the five
   repository-creation/wiring workflows run under a workspace-scoped profile
   variant granted only by an explicit one-time approval of that exact
   command, with hooks, credentials, external write roots, and
   `strict-sandbox` all unaffected (measured both directions). The design
   point that made this reachable without changing the approval contract:
   marking these calls `oneTimeOnly` removes the session/always answer, so a
   plain `true` from `askUser` is unambiguously a per-call approval, and
   `ToolExecOptions` (per call) rather than `ToolContext` (per run) carries
   it. The once/session/always distinction still dies at the `askUser`
   boundary — untouched, and no longer load-bearing for this grant.
3. Extend the synthetic detached and package-script probes to Git/DNS egress,
   MCP child reads/connects, prompt injection, and resource limits in isolated
   fixtures. Do not write to the real home or contact external endpoints.
4. Re-run the full suite and focused Seatbelt probes after fixing these gaps.

Original gates (open until demonstrated, not implied by phase checkboxes):

- No P0 issue remains open.
- All security fixes have exploit tests in both directions.
- Registry-wide capability coverage is complete.
- Normal, auto-approve, plan, and headless modes have explicit tests.
- macOS sandbox-unavailable behavior is tested.
- Unsupported platforms display honest guarantees and fail closed where needed.
- A manual adversarial pass covers prompt injection, malicious repositories,
  malicious dependencies, MCP, network exfiltration, persistence, and resource
  exhaustion.

## Existing protections to preserve

- Plan mode removes command/edit tools mechanically.
- Headless unresolved asks fail closed.
- Project execution-capable settings use trust-on-first-use checks.
- Web fetching has HTTPS, redirect, response-size, and SSRF protections.
- Terminal control characters and tool output sizes are bounded.
- Credentials and trust stores already use restrictive file modes.

## Handoff

This repository document supersedes the temporary planning file. Keep the
release-gate observations current as containment changes; the checkboxes alone
are historical implementation progress, not certification.
