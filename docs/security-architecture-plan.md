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

Current limitation: the Seatbelt profile has `(allow file-read*)`, so direct
tool-policy credential denials do not constrain arbitrary child-process reads.
Its workspace write grant includes `.git`; tool-level guards do not constrain
an interpreter or package script writing hooks. Resolving this requires a
mechanical boundary and an explicit Git workflow decision, not a classifier.

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

Remaining work before declaring the gates below passed:

1. Enforce a narrow child-process read boundary for account secrets, including
   symlink and home-directory variations; test denied canaries and allowed
   ordinary project/toolchain reads. Do not infer this from direct-tool policy.
2. Decide how approved Git operations will work while untrusted children
   cannot alter `.git` metadata or hooks. Test the negative and positive paths.
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
