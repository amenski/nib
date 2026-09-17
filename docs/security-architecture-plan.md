# Nib security architecture plan

**Status:** implemented (phases 0–4) · verified 2026-09-16 · listed release
gates measured on their stated scope, four residuals recorded

This is the reviewed architecture and release-gate record. Phases 0–4 have
implementation commits, but their checklist completion does **not** imply that
the release security objective is met — the release probes found real defects
and the record below is written from measurements, not from the checkboxes.

As of 2026-09-16 the measured probes establish: a contained child cannot read
`$HOME` secrets, cannot write `.git` metadata, and cannot connect — ten egress
mechanisms, each with an unsandboxed control proving it otherwise could. The
macOS "Seatbelt cannot apply" case was also measured in the managed runner,
which refuses nested profiles; see the release-gate verdict. Four residuals
are recorded rather than hidden: the `$HOME`-shaped read boundary, the
system-resolver path, the forgeable untrusted delimiter, and the
registry-delivery gap in the dependency probe. See "Release-gate verdict" and
"Recorded residuals". Code and tests take precedence over the
target architecture here. **Update 2026-09-17:** residual 3's falsified clause is
fixed — the untrusted delimiter is now nonce-matched, so a payload can no longer
close the block early, and the duplicated wrappers are consolidated. Residual 3
remains recorded in its reduced form: the delimiter is still a convention, not a
parser.

**CI observation 2026-09-17:** the commits carrying the T12 change, its docs, and
the two load-sensitive test fixes are pushed and green on CI
(`.github/workflows/build.yml` — install, typecheck, test, build on
`ubuntu-latest` across Node 20.x/22.x/24.x, run 35257701449; the separate
`Registry guard` workflow passed as well). What CI observes is bounded by
platform, and the bound is wide here: on Linux it reports **2158 passed / 63
skipped** (2221) across 147 files, against **2218 passed / 3 skipped** (2221)
across 150 files on macOS. The extra 60 skips are the macOS-only sandbox suites —
`child-paths` (8/8 skipped), `egress` (10/10), `sandbox-unavailable` (1/1),
`seatbelt` (37 of 57) — plus 7 individual tests across `hostile-input`, `jobs`,
`bash`, `exec-runner`, and `launcher`. **CI therefore does not validate Seatbelt
enforcement, egress policy, or child-path containment.** Those remain macOS-local
measurements, not CI-verified, and CI exercised the cumulative tip rather than
each intermediate commit.

## Final decision

Build a capability-based authorization kernel and default OS sandbox first.
Add a small deterministic command classifier afterward as a prompt-reduction
feature, never as the security boundary.

The original P0 empty-scope and policy-parity defects were fixed in Phases
0–1. Do not treat that as proof that arbitrary child processes are confined —
the gate-1..4 measurements below are that proof, and they are narrower than the
architecture's ambitions: read containment is `$HOME`-scoped.

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

**Subprocess launch paths (gate 3) — addressed.** The read boundary and the
`.git` denies live in the shared launcher (`src/sandbox/launcher.ts`), so every
surface was believed to inherit them. What was missing was enforcement
evidence: the only assertions for the non-Bash surfaces were at the argv level
(`expect(cmd).toBe("/usr/bin/sandbox-exec")`), which proves the launcher was
*called*, not that a child could *run* under the profile it produced. Each
surface now runs the same probe through its **real production entry point** —
a synthetic sibling canary read, a `.git/hooks/pre-commit` write, and one
allowed ordinary operation:

| Launch path (entry point exercised) | Canary read | `.git/hooks` write | Allowed operation |
|---|---|---|---|
| Foreground Bash (`runBashTimed`) | Denied | Denied | stdout + workspace report write |
| Background job (`jobManager.start`) | Denied | Denied | job stdout + report |
| Timeout-migrated descendant, post-adoption | Denied | Denied | job stdout + report |
| npm lifecycle script (`npm run`) | Denied | Denied | script ran, report landed |
| Local stdio MCP (`MCPClient.connect`) | Denied | Denied | JSON-RPC `initialize` + `tools/list` completed |
| Lifecycle hook (`HookRunner.dispatch`) | Denied | Denied | hook stdout reached model context |
| Statusline provider command (`defaultCommandRunner`) | Denied | Denied | stdout resolved |
| Notification script (`fireNotify`) | Denied | Denied | script ran, report landed |

Each row is paired with an **unsandboxed control through the same entry
point** that reads the canary and writes the hook successfully, so a denial can
never be a fixture that was never readable. The report file is both the allowed
operation and the evidence channel: a surface that failed to spawn cannot pass
by producing nothing, because each test waits for the report. Permanent tests
live in `src/sandbox/child-paths.test.ts`.
Contained rows now pass a private session scratch directory, matching
production's write-root profile rather than the no-session-temp fallback.

**Finding from this pass (fixed the same day): a contained stdio MCP server
could not launch at all.** `prepareSandboxedCommand` strips the shell form of
the argv `sandboxPrefix` emits — `[sandbox-exec, -p, profile, /bin/sh, -c,
command]` — but kept three elements instead of two, so `/bin/sh` survived and a
contained MCP server was spawned as `sh <command> <args>`. Measured: `<node>:
cannot execute binary file`, exit 126, no handshake, `initialize` timing out
after 10 s. The same off-by-one governed `notify`'s spawn, which is why a
contained notify script was interpreted by `/bin/sh` rather than executed —
the opposite of its documented contract (`docs/notify-spec.md`: "a path to an
executable script", "`shell: false` and an explicit empty argv"). Fixed to
`slice(0, 2)`; MCP and notify are the only two callers. The regression guard is
`src/sandbox/launcher.test.ts` (the configured argv survives byte-for-byte with
no `/bin/sh` inserted), and the MCP row above is the end-to-end proof: it failed
before the fix and passes after. Note which row is *not* evidence: the notify
row passed both before and after, because `sh <script.sh>` happens to work for a
shell script — the launcher assertion is what pins that consumer.

This was a launcher defect, not a containment or policy one, and it is exactly
the class the gate-3 review exists to find. Residual: a contained notify script
must be executable, exactly as the unsandboxed path has always required
(`chmod +x`, per the spec); a non-executable script that previously ran only by
virtue of the accidental `sh` wrapper now fails.

**Sandbox-unavailable and unsupported-platform behavior (gate 3, second half).**
Confirmed already asserted end to end; no new tests were needed, so each link
was checked rather than re-covered:

- `sandboxPrefix` returns `null` **only** when `isSandboxedLevel` is false —
  an absent or `unrestricted` level, or a non-darwin platform. On darwin with a
  sandboxed level there is no fallible branch, so the callers'
  `sandbox ? spawn(sandbox…) : spawn(command, {shell: true})` fallback is
  unreachable for a sandboxed level: containment is never silently dropped.
- Both no-prefix shapes are asserted in `src/sandbox/seatbelt.test.ts`
  ("unrestricted (or absent level) returns no prefix"; "non-macOS: levels below
  unrestricted are policy-only"). The unsandboxed controls in
  `child-paths.test.ts` are that same row executed against a real child — the
  canary is read and the hook is written, which is containment honestly absent
  rather than claimed.
- `hasActiveSandboxContainment` is false off darwin, for `unrestricted`, and
  when the sandbox is disabled (`src/config/loader.test.ts`), and
  `containmentWarning` names which of the two states applies.
- Auto-approval is refused in that state: `cli.tsx` passes `autoApproveAllowed:
  hasActiveSandboxContainment(...)` and `src/ui/App.tsx` gates the auto-approve
  shortcut on it, asserted in both directions in `App.streaming.test.tsx`. A
  platform that cannot enforce the profile therefore cannot auto-approve either;
  the fallback is an ordinary consent prompt, not a silent unconfined run.

Residual recorded, **not** closed: "macOS is supported but Seatbelt cannot
apply" (the managed-runner `sandbox_apply: Operation not permitted` case) is not
demonstrated here. On darwin `sandboxPrefix` always emits the prefix, and if
`sandbox-exec` cannot apply a profile the child fails to start — that is the
OS's fail-closed behavior, and nib's contribution to it is structural: no caller
re-spawns without the profile, so an application failure is closed rather than
open. Reproducing the failure itself needs a host where nesting is refused
(in this session's shell nesting succeeds, so it cannot be reproduced here) —
residual for the gate-5 review.

### Direct egress (gate 4) — addressed

Claim verified, from `docs/security-network-broker.md`: sandboxed children
cannot connect directly, including via DNS, proxies, Unix helpers, or spawned
descendants. No broker is shipped, so direct egress must be closed.

**Why the original probe proved nothing, and what replaced it.** The release
probe recorded that Git-to-loopback failed and could not separate Seatbelt
denial from connection refusal. It cannot be separated by reading the child:
measured 2026-09-16, git's contained failure reads `Failed to connect to
127.0.0.1 port N … Couldn't connect to server` — byte-identical to a refused
connection — and both directions exit non-zero (the control fails on the HTTP
protocol error). Every row in `src/sandbox/egress.test.ts` (new, macOS-gated,
one `describe` per mechanism so a failure names it) therefore measures the
**destination's own counter**: a hermetic local listener counts connections or
datagrams, and each mechanism runs twice — an unsandboxed control that must
register, and a contained run that must register nothing.

| Mechanism | Control (no level) | Contained (`workspace-write`) | Evidence |
|---|---|---|---|
| Node `fetch` → loopback TCP | `REACHED 200` | `BLOCKED` (EPERM) | listener +1 / +0 |
| Python `socket.create_connection` | `PYREACHED` | `PYFAIL EPERM` | listener +1 / +0 |
| Git `ls-remote` over HTTP | connects | "Couldn't connect" | listener +1 / +0 |
| npm lifecycle script (child of a child) | `REACHED` | `BLOCKED` | listener +1 / +0 |
| local stdio MCP server's own `fetch` | `REACHED` | `BLOCKED` | listener +1 / +0 |
| `curl` through a local proxy | `CURL-REACHED` | `CURL-FAILED` | listener +1 / +0 |
| UDP send to loopback | `UDPSENT` | `bind EPERM` | datagrams +1 / +0 |
| UDP send to 192.0.2.1 (TEST-NET-1) | `UDPSENT` | `bind EPERM` | n/a — reserved, unrouted |
| Unix-domain daemon socket under `$HOME` | `UNIXREACHED` | `UNIXFAIL EPERM` | listener +1 / +0 |
| DNS A query via a local c-ares resolver | `ENODATA` (fixture answered) | `ECONNREFUSED` | datagrams +1 / +0 |

Three details that are load-bearing rather than incidental:

- **UDP is closed at socket creation, not at send.** The contained child fails
  at `bind` with EPERM before any datagram exists, so "no UDP egress" is a
  stronger statement than the send path alone would support.
- **DNS is where the counter is indispensable.** Control and contained both
  print `DNSFAIL`, differing only in errno; the control's `ENODATA` *is* the
  arrival proof, because that is the fixture's own empty answer coming back.
- **No public endpoint exists in any probe.** The proxy target is
  `http://egress.invalid/` (RFC 2606) and the resolver's name is
  `egress.fixture.test`, both answered only by the local fixture; the one
  non-loopback address is TEST-NET-1, reserved and guaranteed unrouted.

Residual recorded, **not** closed: `dns.lookup`/`getaddrinfo` resolves through
the system resolver (mDNSResponder), which performs its network I/O *outside*
the contained process, where no Seatbelt rule can apply. Whether a
resolver-mediated lookup still succeeds under containment is therefore not
demonstrated — establishing it would need either a public DNS query or a
reconfigured system resolver, both excluded by the probe rules. The broker
claim is accordingly recorded as "a direct connect is denied", not "no name can
be resolved", and the difference is left for the gate-5 review rather than
papered over.

### Hostile input and availability limits (gate 4, second half) — addressed

Bounded synthetic fixtures throughout; nothing probes real credentials, real
shell startup files, or another real project, and no fixture generates load.

- `src/tools/untrusted-content.test.ts` (new) covers the T12/T14 primitives with
  synthetic payloads: CSI/SGR colour escapes, an OSC 52 clipboard write, C0, C1
  and DEL stripping, LF/TAB preservation, astral-character preservation
  (iterating by code point rather than UTF-16 unit), and the delimiter
  convention including `stripUntrustedMarkers` for the UI preview path.
- **Recorded residual, measured (2026-09-16):** the delimiter was a convention,
  not a parser. A payload containing the end marker closed the block early — one
  BEGIN paired with two ENDs — so its remaining text was positioned after an
  apparent close and read as though it were outside the untrusted region. The
  enforced control remains the permission prompt plus the standing base rule
  that external content is data. It was pinned by a characterization test named
  as a residual rather than enshrined as correct. **Addressed 2026-09-17** — the
  product decision this bullet recorded for gate 5: the two private copies of
  `wrapUntrusted` (`web-fetch.ts`, `web-search.ts`) are consolidated onto
  `untrusted-content.ts`, and the wire format now carries a per-call 12-hex id in
  both markers, so an end marker a payload emits no longer matches the enclosing
  block and cannot close it. The characterization test is replaced by a
  regression (`src/tools/untrusted-content.test.ts`), and
  `src/sandbox/hostile-input.test.ts` proves it end-to-end on real `run_bash`
  output. **What this does not buy:** the block is still a convention the model is
  asked to respect — the id rule lives in `getBaseRules()`, and model compliance
  is not a security boundary. Residual 3 is restated, not deleted, under
  "Recorded residuals" below.
- `src/sandbox/hostile-input.test.ts` (new) covers three shapes of input a user
  has not read. **A hostile repository's content:** its README carries an
  instruction override plus an OSC 52 escape, and read through the real
  `read_file` handler it arrives inside the untrusted delimiters with ESC/BEL
  stripped and the injection text present as data. **A hostile repository's
  code:** a `.git/hooks/post-commit` that runs on an ordinary `git commit` —
  git's own spawn path, which no other probe in this release covers — and
  cannot read the sibling canary, cannot write `.git/hooks`, and cannot reach
  the listener, while the unsandboxed control on the identical repository does
  all three; the commit itself succeeds in both directions (`GIT-EXIT 0`), so
  containment did not break the workflow. **A hostile dependency:** a local
  package whose `postinstall` runs during `npm install`. A real hostile
  dependency arrives from a registry, which these probes may not contact, but
  `npm install ./local-dir` runs the same install-script machinery with no
  network at all — so the mechanism is measured rather than inferred, and
  measured it behaves like every other package-script surface: canary read
  denied, `.git/hooks` write denied, connect denied, with an unsandboxed
  control doing all three and `EXIT 0` in both directions (containment is
  achieved by denying effects, not by breaking the install). The settings half
  of a hostile repository (a committed `permissions`, `sandbox`, or
  `permissionProfile` attempting to self-grant) is already measured in
  `src/permissions/settings-trust.test.ts` and is referenced rather than
  duplicated.

  One property of these fixtures is deliberate and worth stating: every canary
  lives under the real `$HOME`. Because the child read boundary is `$HOME`-shaped
  (the gate-1 residual below), a canary under `$TMPDIR` is readable in *both*
  directions — measured while building this fixture — so a `$TMPDIR` canary
  would silently test the recorded residual instead of the mechanism.
- Availability limits are exercised as arithmetic with small deterministic caps,
  never by resource exhaustion: `appendCapped` — the shared bound behind the
  background job streams (1 MiB) and `run_bash`'s foreground buffers (512 KiB) —
  is pinned in `src/tools/jobs.test.ts` with a ten-character cap: the tail is
  kept, the truncation flag is raised once per crossing, a buffer sitting
  exactly at the cap is neither trimmed nor flagged, and an empty chunk is a
  no-op that flags nothing.

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
3. ~~Verify every subprocess launch path — foreground and background Bash,
   timeout-migrated descendants, stdio MCP, lifecycle hooks, statusline
   providers, notification scripts, npm/build scripts — with a secret read, a
   forbidden write, and one allowed operation each.~~ **Done 2026-09-16** — see
   the launch-path table above and `src/sandbox/child-paths.test.ts`; the pass
   also found and fixed the contained-MCP launcher defect.
4. ~~Extend the synthetic detached and package-script probes to Git/DNS egress,
   MCP child reads/connects, prompt injection, and resource limits in isolated
   fixtures. Do not write to the real home or contact external endpoints.~~
   **Done 2026-09-16** — see the two gate-4 sections above: ten egress
   mechanisms each with an unsandboxed control and a destination-side counter,
   the hostile-input and injection fixtures (including a hostile dependency's
   install script), and the capped-stream tests. Three residuals are recorded
   rather than closed: the system resolver (mDNSResponder) path, the delimiter
   convention (narrowed 2026-09-17 — no longer forgeable with an end marker of a
   payload's own, but still a convention the model must respect), and the
   `$HOME`-shaped read boundary that bounds how far a canary can be placed.
5. Re-run the full suite and focused Seatbelt probes after fixing these gaps.

### Release-gate verdict, 2026-09-16

Environment: this host is a capable runner — nested Seatbelt applies and
loopback binds, so the macOS probes ran for real rather than being skipped
(149 files, 2,203 passed, 2 skipped; `tsc --noEmit` clean; `npm run build` →
`dist/cli.js` 10.31 MB). A gate is closed only where the evidence below
demonstrates it.

- **No P0 issue remains open — closed.** P0.1–P0.4 were fixed in Phases 0–1 with
  their acceptance tests. The release probes (gates 1–4) found *new* defects —
  the unbounded child read, the `.git` write, the contained-MCP launcher
  off-by-one — and none of them re-opened a P0.
- **All security fixes have exploit tests in both directions — closed.** Every
  gate 1–4 fix ships a hostile case and an unsandboxed control through the same
  entry point: sibling read, `.git` write, egress (ten mechanisms), hostile
  repository hook, hostile dependency install script. The controls are what make
  the denials meaningful — a failed command is not evidence of containment.
- **Registry-wide capability coverage is complete — closed.**
  `src/permissions/capabilities.test.ts` pins the guarantee mechanically: the
  sample-args map's keys must equal the registered tool names, so adding a tool
  without capability data fails the suite, and every registered tool must
  extract a `known`, non-empty plan. Foreground and background Bash are asserted
  to produce identical process capabilities. Scope of the claim: coverage is
  over *registered tools*, which is what the kernel authorizes.
- **Normal, auto-approve, plan, and headless modes have explicit tests —
  closed.** 306 tests across `App.streaming.test.tsx` (normal, auto-approve,
  plan posture), `exec-runner.test.ts` and `exec-runner.subagent.test.ts`
  (headless, including subagents), with `permissions/profile.test.ts` and
  `permissions/capabilities.test.ts` covering the policy layer they share.
- **macOS sandbox-unavailable behavior is tested — closed for fail-closed
  execution.** The managed runner refuses nested Seatbelt. In
  `src/sandbox/sandbox-unavailable.test.ts`, an unsandboxed control creates a
  marker; the same command under `/usr/bin/sandbox-exec` exits 71 with
  `sandbox_apply: Operation not permitted` and creates none. The real
  `runBashTimed` path also creates no marker and returns the error. The
  focused test passed in that runner and skips on a runner that permits
  nesting. This proves no fallback execution in the tested Bash path; it does
  not provide a distinct application-failure signal for the proposed session
  grant, which remains future work in `docs/permission-ux-redesign.md`.
- **Unsupported platforms display honest guarantees and fail closed where
  needed — closed** (gate 3, second half): `hasActiveSandboxContainment` is
  false off darwin and for `unrestricted`, `containmentWarning` names which
  state applies, and auto-approval is refused in that state, asserted in both
  directions.
- **A manual adversarial pass covers prompt injection, malicious repositories,
  malicious dependencies, MCP, network exfiltration, persistence, and resource
  exhaustion — closed for all seven, one nuance recorded.** Gates 1–4 now
  automate every category: prompt injection
  and malicious repositories in `src/tools/untrusted-content.test.ts` and
  `src/sandbox/hostile-input.test.ts`, malicious dependencies in that file's
  `npm install` row, MCP reads in `child-paths.test.ts` and connects in
  `egress.test.ts`, network exfiltration across ten mechanisms in
  `egress.test.ts`, persistence (`.git`) in `seatbelt.test.ts`, and resource
  limits in `jobs.test.ts`. The one category not measured *in its real delivery
  form* is a registry-served dependency: the probe installs a local package,
  because contacting a registry is out of scope for these fixtures. The
  install-script mechanism itself — the part that executes attacker code — is
  measured directly.)*

### Recorded residuals

**Seatbelt failure evidence (gate 5).** The managed runner supplies the
previously missing refusing environment: control exit 0 and marker present;
direct contained exit 71 and marker absent; `runBashTimed` marker absent with
the application error returned. The capable runner instead runs all real
Seatbelt integration tests. The current error is generic command failure
output, not a dedicated signal that a future session grant could safely use
for revocation. That new UX requires an in-sandbox readiness handshake and
its own verification before it ships.

**Residual 1 — the child read boundary is `$HOME`-shaped.** Reads under the real
`$HOME` are denied except for a toolchain allowlist, but the profile's core still
allows `file-read*` generally, so a secret outside `$HOME` (under `/tmp`, `/opt`,
`/Volumes`, or another configured write root) remains readable by a contained
child. Measured while building the hostile-dependency fixture: the same probe
reads a `$TMPDIR` canary under `workspace-write` (and is denied the same canary
under `$HOME`) — see the gate-4 fixture note. This
matches the plan's threat model — account secrets and sibling projects live under
`$HOME` — but it is a real limit on the claim. Product decision required if a
broader boundary is wanted: the options are (a) deny `file-read*` outside the
workspace plus a toolchain allowlist, which is the strongest and will break
under-specified toolchains; (b) deny a configurable list of sensitive roots
(`/etc/ssh`, `/opt/secrets`, user-nominated paths) and keep the rest readable;
(c) keep the current shape and warn when a workspace sits outside `$HOME`, so a
user knows containment is weaker there. Option (c) is the chosen scope for
this release and the proposed Bash session grant, and the warning is
implemented (measured 2026-09-17): `workspaceOutsideHomeWarning`
(`src/config/loader.ts`) reports the residual at startup in both the interactive
scrollback (`cli.tsx`) and headless stderr (`exec-runner.ts`), comparing the
realpath-resolved trusted root against the same real home the Seatbelt deny
subtracts (`seatbelt.ts`'s `realpathNearestAncestor(homedir())` — not
`NIB_HOME`). It is gated on `hasActiveSandboxContainment`, so it speaks only
where a boundary actually exists: off darwin, and wherever `containmentWarning`
already reports no boundary, it stays silent. Added roots (`--add-dir`,
`sandbox.writeRoots`) do not affect it, and it discloses the boundary without
narrowing it. `src/sandbox/seatbelt.test.ts` pins the residual with a synthetic
canary whose contained read succeeds.

**Residual 2 — `dns.lookup` performs its network I/O outside the process.**
`getaddrinfo` resolves through mDNSResponder, so no Seatbelt rule applies to it.
Direct connects are denied (ten mechanisms measured), but "no name can be
resolved" is not demonstrated. See the gate-4 section.

**Residual 3 — the untrusted delimiter is a convention, not a parser.**
*(Narrowed 2026-09-17; still recorded.)* The falsified half of this residual —
"a payload containing the end marker can close the block early" — is fixed. Both
markers now carry the same per-call 12-hex id, so an `END` a payload emits, with
a made-up id or with none at all, does not match the enclosing block and is not
its terminator; the duplicated wrappers in `web-fetch.ts`/`web-search.ts` are
consolidated onto `untrusted-content.ts`; and `getBaseRules()` states that a
delimiter whose id differs from the enclosing block, or a second BEGIN inside
one, is attacker-supplied text. What remains is the half that gives the residual
its name: the boundary is a convention the model is *asked* to respect, not a
parser that enforces it on the model's behalf, and the id rule is only as good as
the model's compliance with one sentence in the system prompt. It is therefore
still recorded rather than closed — model compliance is not a security boundary,
and the OS sandbox remains the limit on what a command can do. See
`docs/permission-ux-redesign.md` for the prerequisite this discharged, and for
the `web-fetch-guard.ts` sanitizer duplication it still records as outstanding.

**Residual 4 — a registry-served dependency is not probed.** The install-script
mechanism is measured with a local package; the delivery path through a real
registry is out of scope for these fixtures. See the adversarial-pass note.

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
