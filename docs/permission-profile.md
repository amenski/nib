# Permission Profile — Parallel ACL Design

**Status:** shipped — all phases (a)–(e) complete 2026-08-13. Phases (b)
schema + config validation, (c) evaluation layer, and (d) posture/prompt/UI
integration shipped 2026-08-13 · phase (e) Seatbelt shipped 2026-08-13.

This is the design doc that feature-plans.md §9 requires as step 1 of the
PermissionProfile workstream (decision **K**: full parallel ACL model, Codex
style, beside the existing rule engine). It settles the two open decisions —
**L** (evaluation order) and **M** (subsumption) — as recommendations the
owner approves or redirects.

---

## 1. Problem & context

Nib's permission architecture today is the Claude-Code family:
pattern rules + approval posture + guarded tiers (permission-spec.md,
security-spec.md). Its protections are *behavioral* — they match what the
model asked to do (`run_bash` command text, edit-tool paths via
`isEditToolInWorkspace`) and decide allow/ask/deny.

What the rule engine does **not** provide is a *capability boundary*: a
declarative statement of what the agent may touch at all, independent of
which tool or phrasing it uses. Two real gaps follow:

- **Reachability.** Every path check is per-tool and per-rule. A path that
  no rule mentions is policy-free — `isEditToolInWorkspace` only knows
  "inside/outside the workspace," nothing finer, and it is consulted by the
  approval overlay, not as a hard boundary.
- **Network.** `web_fetch`/`web_search` have their own SSRF guards, and
  bash egress sits in the guarded tier — but there is no single place that
  says "this agent may talk to these hosts and no others."

The Codex CLI model (researched 2026-08-13) splits this cleanly:
`sandbox_mode` levels (read-only / workspace-write / danger-full-access)
set the *default capability* of the whole agent, PermissionProfile rules
(path globs, network domains) carve exceptions inside the level, and the OS
sandbox (macOS Seatbelt, Linux Landlock/seccomp) enforces it mechanically.
Approval prompts are a separate axis — how often the user is asked — layered
on top.

## 2. Two layers, two axes (the core insight)

| | Rule engine (exists) | PermissionProfile (proposed) |
|---|---|---|
| Question answered | *May this operation run?* | *Is this resource reachable at all?* |
| Matches on | tool name + command/path pattern | path globs, network domains |
| Outcomes | allow / ask / deny | allow / deny (per level default) |
| Nature | behavioral policy, fine-grained, posture-upgradable | capability boundary, coarse, absolute |
| Escalation path | ask → user prompt | none (deny is terminal, silent) |

They are **orthogonal axes**, not competitors: a profile says *what the
agent can see and touch*; the rule engine says *which of those touches are
polite enough to do silently vs. need a human nod*. Neither subsumes the
other — a profile cannot express "guarded `rm -rf` always prompts," and a
rule cannot express "no reads outside the workspace, regardless of tool."

## 3. Profile schema

Config key `permissionProfile` (settings.json, project > global merge like
permissions):

```yaml
permissionProfile:
  level: workspace-write        # strict-sandbox | workspace-write | unrestricted
  fs:
    - path: "**/*.env"          # gitignore-style globs, relative to workspace roots
      action: deny              # deny | read | write   (write implies read)
    - path: ".git/**"
      action: deny
    - path: "~/notes/**"        # home-relative allowed
      action: read
  network:
    allow: ["api.deepseek.com", "registry.npmjs.org"]
    deny: ["*"]                 # allowlist mode; omit deny for default-allow
```

**Project > global merge** (settings.json, like `permissions`; chosen rule,
simplest defensible — code in `loader.ts mergePermissionProfiles`):
`level` — project wins. `fs` — project entries append after global; a
project rule with the same `path` string replaces the global rule (one rule
per path; the later entry wins, replaced rules keep their original
position). `network` — `allow`/`deny` arrays union (deduped); when a host
is in both lists the more specific entry wins, ties go to deny.

**Implementation notes (shipped with (b)+(c), 2026-08-13):**
- `level` is **required** when the key is present; `permissionProfile`
  absent entirely disables the gate — layer 1 does not exist, today's
  behavior byte-for-byte (§9). The always-denied set (`.git/`, the profile
  file) applies at every level *once the gate is on*, including
  `unrestricted`.
- Because every level already permits reads anywhere, a `read` rule never
  changes an outcome, and a `write` rule is only valid within the level's
  write-set (enforced by validation) — so the fs rules that *act* are `deny`
  rules plus the level defaults. Read/write rules are accepted for
  explicitness and future levels.
- `network.allow` entries are honored where the level permits grants:
  `workspace-write` (the allowlist) and `unrestricted` (vacuous — the
  default already allows). Under `strict-sandbox` they are **inert**, not a
  config error — the level's network deny wins. A `*` deny is the least
  specific entry, so a specific allow carves the allowlist out of it
  (`deny: ["*"]` allowlist mode, above).
- `web_search` takes no host argument; the evaluator applies the network
  rules to the pinned search host (`www.bing.com`, web-search-spec.md §2),
  overridable in the `ProfileEvaluator` constructor for tests.

**Implementation notes (shipped with (d), 2026-08-13):**
- `authorize()` is the one composed resolution surface in the live loop:
  `agent.ts`'s sequential `gateCall` and the parallel-batch pre-resolution
  both call `authorize(call, engine, profile)` — profile absent runs the
  engine alone, byte-for-byte today (§9). A layer-1 deny emits the same
  `Permission denied for <tool>` tool message as a rule deny, with the audit
  row `deny-by-profile` / `deny by profile (layer 1)` (permission-spec.md
  §11). The decision value already lived in the session record union.
- Threading: the evaluator rides the same object channel as the
  `PermissionEngine` — constructed once in `cli.tsx` / `exec-runner.ts` from
  the merged `config.permissionProfile`, threaded through
  `runAgentTurnBridge` into `runAgent` options as `permissionProfile`,
  through the AppContext as `permissionProfile` (the overlay's M.1
  condition), and through the `Orchestrator`'s `profile` option so
  sub-agents inherit the boundary together with the rule engine (§6). No
  parallel context channel.
- The status line does NOT show the level (reversed 2026-08-14): static
  config belongs in `nib doctor` and `/permissions`, not the bar —
  the bar shows only session-mutable state.
- M.1 (in this phase): the approval overlay's edit-in-workspace condition is
  profile-derived — `ProfileEvaluator.editTargetInWriteSet`
  (workspace-write → workspace roots; strict-sandbox → no write-set, no
  edit overlay-auto-allowed; unrestricted → any path). An edit inside the
  write-set auto-allows without a prompt, resolved as `"posture"` so the
  agent records `allow-by-posture` (the established "allowed without showing
  a prompt" row).

**Level presets** set the implicit default the explicit rules carve into:

| Level | Default fs | Default network | Equivalent today |
|---|---|---|---|
| `strict-sandbox` | read-only (any path) | denied | plan posture, but absolute |
| `workspace-write` | read anywhere; write only inside workspace roots | default-deny + allowlist | current behavior + a network allowlist |
| `unrestricted` | read + write anywhere | default-allow | exactly today's behavior |

Explicit `fs`/`network` rules **narrow only** — they can deny within a
level's allowance or grant read within `strict-sandbox`; they can never
grant more than the level's default permits (a `write` rule under
`strict-sandbox` is a config error, caught by validation). `.git/` and the
profile file itself are always denied, as in Codex.

## 4. Evaluation order — decision L: profile-gate → rules → posture

**Recommendation: profile first.** One composed entry point — call it
`authorize(call)` — that runs:

```
1. profile.decide(call)      → deny ⇒ DONE (silent, audit row "deny-by-profile")
                               allow ⇒ continue
2. rules.resolve(call)       → deny ⇒ DONE   (deny-by-rule / guarded)
                               ask  ⇒ continue to posture overlay
                               allow ⇒ DONE (allow-by-rule)
3. posture overlay           → upgrades rule-ask to allow-by-posture or
                               stays ask → user prompt (ask-approved /
                               ask-denied / unresolved-ask)
4. headless                  → any surviving ask ⇒ deny (existing rule)
```

**Deny-absolute invariant (proved per layer):**
- Layer 1 emits only `deny` or pass-through — a profile has no `ask`, so
  nothing a profile allows bypasses layer 2.
- Layer 2 `deny` (rule or guarded tier) is untouched by posture — existing
  invariant, unchanged.
- Layer 3 upgrades only `ask` → `allow`; it can never see a profile deny.
- Therefore every deny produced anywhere is final. ∎

**Why not rules-first (the alternative for L):** rules-first would let a
coarse rule (`allow edit *`) outrank a profile deny unless we special-case
"profile denies are absolute," which is just profile-gate again with extra
steps — the composition becomes stateful and harder to audit. Gate-first
also makes the audit trail one-directional: every record names exactly one
winning layer.

## 5. Subsumption — decision M: keep both, one surface

**Recommendation: permanent parallelism, composed behind `authorize()`.**

The axes argument in §2 is the reason migration would lose information:
guarded tiers and command-pattern rules are not expressible as reachability
rules. But two concrete consolidations happen as the profile lands:

1. **`isEditToolInWorkspace` (security-spec D1) becomes profile-derived.**
   The workspace-write default *is* that check, generalized: profile fs
   rules subsume the realpath-escape logic, and the overlay's "edits
   inside cwd" condition reads the profile's effective write-set instead
   of re-implementing containment.
2. **Edit-tool path rules in the rule engine get flagged for dedup.** If a
   session rule matches only on edit paths, it may be expressible as an fs
   rule; measure after phase (c), don't pre-migrate.

Everything else in the rule engine (command patterns, guarded patterns,
secret-adjacent reads, session rules, audit) stays.

## 6. Interactions with existing surfaces

- **Approval posture × profile.** Posture stays a *prompt-frequency* knob
  (manual / autoApprove / plan) layered above both. `autoApprove` never
  touches a profile deny (layers 1–2 precede it). `plan` aligns naturally
  with `strict-sandbox` but does not set it — switching levels is explicit
  config, not a posture side effect. If the OS sandbox is disabled or
  unavailable, `autoApprove` does not bypass ordinary asks: policy still
  evaluates, but consent is not containment.
- **Guarded tiers.** Survive untouched and apply *after* the profile:
  `curl` egress remains always-prompt even under `unrestricted`, because
  bash's network reach is not profile-expressible (see §7).
- **Session rules** (`a` answers) stay in layer 2; they cannot reference
  the profile.
- **Headless.** Fail-closed unchanged: profile deny → deny; rule ask → deny.
- **MCP tools.** Profile does not gate MCP (their commands are already
  `strictMcpConfig`-allowlisted and their internal behavior is the server's
  contract); revisit if a server proves abusive.
- **Sub-agents.** Inherit the parent's profile and rule engine together
  (same object threading as today's permission inheritance).

## 7. Per-tool enforcement map

| Surface | Enforced by | Notes |
|---|---|---|
| edit-group tools (write targets) | profile fs rules (write) | replaces D1 containment as the boundary; D1 logic becomes the `workspace-write` default |
| read tools (`read_file`, `glob`, `search`, skills) | profile fs rules (read) | new: reads outside the workspace become profile-deniable |
| `web_fetch`, `web_search` | profile network rules | in front of the existing SSRF guard; both must pass |
| bash network egress (`curl`, `wget`, …) | rule-engine guarded tier (unchanged) | honest limitation: a shell has no tool-scoped network argument to gate; the profile cannot silently allow what the shell does. Documented, not fudged |
| `run_bash` fs side effects | rule engine only | same reason; Seatbelt phase closes this (below) |

## 8. Seatbelt phase (macOS)

The rules-first phase above is the *policy*; the OS sandbox is the
*mechanism*. `sandbox: { enabled: true }` launches the agent's bash child
processes under a Seatbelt profile per level — strict-sandbox: read-only fs +
no network; workspace-write: write only workspace roots + no direct network.
Non-macOS platforms run policy-only with a startup notice. This closes the
"bash can touch anything" gap from §7 without pretending a shell command has
a trustworthy hostname-level authority.

**Implementation notes (shipped with (e), 2026-08-13):**
- `src/sandbox/seatbelt.ts` builds the SBPL profile per level; the
  `run_bash` and `run_bash_background` spawns (`src/tools/bash.ts`,
  `src/tools/jobs.ts`) get the prefix
  `sandbox-exec -p <profile> /bin/sh -c <command>` whenever
  `sandbox.enabled` is true and the merged profile level is below
  `unrestricted` (wired at startup beside `timeoutToBackground`, cli.tsx /
  exec-runner.ts). Sandboxing is a spawn-time property — a timeout-migrated
  child is the same already-sandboxed process and keeps it naturally.
- **Profile semantics.** strict-sandbox: `(version 1)` + `(deny default)` +
  `(allow process*)` + `(allow file-read*)` + `(allow file-map-executable)` +
  `(allow sysctl-read)` + `(allow file-write* (literal "/dev/null"))` —
  reads anywhere, writes denied everywhere except the `/dev/null` discard
  (ubiquitous `2>/dev/null` redirects need it; even the Xcode `git` shim
  does one internally), network denied by default. workspace-write adds
  `(allow file-write* (subpath "<trusted root>"))` for the session
  workspace root fixed at startup — never the per-call `cwd` (SBPL subpath
  matching is directory-boundary aware) — the private session-temp root
  below. Neither sandboxed profile grants `(allow network-outbound)`.
  `unrestricted` gets no prefix at all.
  Verified empirically on macOS 2026-08-13: `ls`, `git status`,
  `node -e 'console.log(1)'` run under both sandboxed levels; writes
  outside the write-set and network connects fail with EPERM-equivalent
  denials (non-zero exit).
- **Private session temp.** At session start Nib creates a mode-0700
  directory under the OS temp directory and passes it to child processes as
  `TMPDIR`, `TMP`, `TEMP`, and the npm cache location. workspace-write emits
  that directory, rather than shared `/tmp`, the host `$TMPDIR`, or `~/.npm`,
  as its only non-workspace write root. Strict-sandbox gains none of this;
  read-only stays absolute. The directory is removed when the owning session
  ends.
- **Trusted-root invariant + cwd containment (item 8.6).** The Seatbelt
  write-set root is the trusted workspace root fixed at startup (the tool
  handler's `ctx.workingDir`, realpath-resolved via nearest-existing-
  ancestor) — a model-passed `cwd: "/"` or `cwd: "~"` can never widen the
  write-set. Before a sandboxed spawn, the requested cwd is realpath-
  resolved and checked: unless it equals or is a descendant of the trusted
  root — including a cwd symlinked out of it — the tool call is rejected
  with a tool error (no spawn, no profile). Same rule for background jobs
  (`run_bash_background`). Unchanged: cwd omitted → `ctx.workingDir`; a
  subdirectory cwd inside the root runs there with the write-set root still
  the trusted root; level absent/`unrestricted` or non-macOS hosts skip
  both the profile and the check.
- **Network: deny direct egress.** SBPL filters resolved IPs, not hostnames,
  so its network primitive cannot enforce `network.allow`. Both sandboxed
  profiles therefore deny direct egress. A temporary broad-egress exception
  is intentionally not shipped: granting it to a shell grants every child
  process arbitrary outbound access. A future host-aware broker must mediate
  all egress before Nib offers a scoped network exception; see
  [security-network-broker.md](./security-network-broker.md).
- **Residuals, stated honestly.** (1) The `.git` always-denied set is not expressed in
  SBPL — SBPL has no gitignore globs — so a workspace-write bash child
  could mechanically write `.git/…`; the policy layer denies it. (3) The
  profile's fs `deny` rules (`**/*.env` …) are likewise policy-layer only;
  SBPL expresses the level's defaults, not the rules. (4) macOS-only and
  flag-gated: on other platforms `sandbox.enabled` warns once at startup
  and runs policy-only. (5) Nib's session temp is process-private by mode
  and location, but an untrusted child can still access everything the
  Seatbelt profile otherwise permits.

## 9. Migration & back-compat

- `permissionProfile` absent ⇒ level `unrestricted` + empty rules ⇒
  **byte-for-byte today's behavior** (layers 2–3 only). The feature is
  additive; nothing existing changes until the owner sets a level.
- Setting a level below `unrestricted` is a deliberate, visible change —
  visible in `nib doctor` and `/permissions`, not the status line
  (the earlier status-line segment was removed 2026-08-14: the level is
  static config, and the bar shows only session-mutable state).

## 10. Phasing & verification

- **(a) this doc** — owner review of L, M, and the §7 bash-limitation
  honesty. **Verify:** review comments resolved.
- **(b) schema + config validation** — loader parses `permissionProfile`;
  invalid level/rule = fail fast naming file+field; narrowing-only
  violations rejected. **Verify:** loader tests.
- **(c) evaluation layer** — `authorize()` composition + audit rows
  (`deny-by-profile` decision value added to the session record union).
  **Verify:** engine tests incl. the deny-absolute matrix
  (profile-deny × posture, profile-deny × rule-allow, guarded ×
  unrestricted).
- **(d) posture/prompt/UI integration** — status-line level segment,
  headless wiring, `isEditToolInWorkspace` consolidation (M.1).
  **Verify:** App/headless tests + manual posture-matrix pass.
- **(e) Seatbelt** — flag-gated; profile fixtures per level.
  **Verify:** sandbox-escape fixture tests (write outside workspace,
  network to non-allowlisted host) fail closed. **Shipped 2026-08-13**:
  `src/sandbox/seatbelt.test.ts` (write-outside fails, local-server
  network tests fail closed under strict-sandbox, pass under
  workspace-write). **Hardened 2026-08-15 (pre-0.3.0)**: real
  dev-toolchain battery under the shipped profile proved the temp + npm
  carve-outs necessary (above); re-verified control (`~/` escape write)
  still denied, and a real `npm install` under the sandbox is now a
  regression test in the suite.

## 11. Owner review — resolved 2026-08-13

1. **L** — approved: profile-gate → rules → posture. (§4)
2. **M** — approved: keep both systems, one `authorize()` surface, with
   the two consolidations (`isEditToolInWorkspace` profile-derived;
   edit-path rule dedup measured post-build). (§5)
3. §7 honesty — accepted: bash egress and fs side effects stay
   rule-engine-governed until the Seatbelt phase.
4. Level names & defaults — Codex-compatible, `workspace-write` default.
   (§3)

Phase (b) is unblocked.
