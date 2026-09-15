# Permission Specification

**Status:** current · verified 2026-08-13 · covers `src/permissions/{engine,rules,bash-normalize,destructive,guarded,builtin-allow,profile}.ts`, `src/exec-runner.ts`, `src/ui/App.tsx`

## 1. Overview

The permission system: rule-based pattern matching on tool + argument
(exact/prefix/glob/any), a builtin destructive-command deny tier, a builtin
secret-adjacent/network-egress ask tier, and a session-level posture overlay
that makes the agent usable without editing config mid-session.

Threat model and known permission-engine defects:
[security-spec.md](./security-spec.md). The builtin destructive and guarded
tiers take precedence over ordinary rule resolution as specified in §7.

## 2. Two orthogonal axes

| Axis | Question it answers | Defined by |
|------|--------------------|-----------|
| **Mode** (persona) | Which tools *exist* this turn? | mode-spec.md groups |
| **Posture** | Do `ask` results actually prompt? | This doc §9, `App.tsx` UI state |

The `general` persona has no edit tools at all — posture is irrelevant there.
The axes never interact except that both must pass: a tool must be in the
persona's groups AND clear the permission check.

## 3. Data model

A **rule** is `{ tool, kind, pattern, action, origin }`:

- `tool` — a tool name, `"mcp__*"` (any MCP tool), or `"*"` (any tool).
- `kind` — `"exact"` (literal string equality), `"prefix"` (whole-token
  prefix match on `run_bash` command text — the final token may extend at a
  non-alphanumeric boundary, e.g. `~` matches `~/Documents`, `mkfs` matches
  `mkfs.ext4`), `"glob"` (POSIX-glob match against a resolved file path),
  `"any"` (matches every call to `tool`, ignoring pattern content).
- `action` — `"allow" | "ask" | "deny"`.
- `origin` — `"builtin-destructive" | "builtin-guarded" | "config" | "session"`.
  Determines override eligibility and forced-narrowing behavior.

On disk (`.nib/settings.json`), `permissions.rules` is an array of
`{ tool, pattern, action }`; `kind` is inferred at load time — a `:*` pattern
suffix means `prefix` (stripped before matching), a pattern containing `*`
or `?` means `glob`, an empty string means `any`, anything else is `exact`.

## 4. Subject construction

One normalized subject is built per call: `{ tool, text, resolvedPath? }`.
For `run_bash`, `text` is the literal command string (or, after
normalization, one independent segment of a compound command). For
path-bearing tools, `text` is the raw path argument and `resolvedPath` is
that path made relative to the working directory (`./src/main.ts`) when it
falls inside it — this is what lets a glob rule authored as `./**` match a
real absolute path argument. Paths outside the working directory are left
absolute, so a `./**`-rooted rule doesn't spuriously match them; an
absolute glob can still be authored to cover them explicitly.

**`web_fetch` is domain-scoped, not path-scoped.** Its `text` is the full
URL and its `resolvedPath` is the URL's lowercased **hostname**, so
approving `https://docs.python.org/3/library/os.html` for the session also
allows any other path on `docs.python.org` — but not `evil.com`, and not a
different subdomain. It is also exempt from the working-directory
relativize step, which would otherwise mangle a hostname into a
path-relative string. `buildDefaultRule` builds the "allow for
session/always" rule on the hostname for the same reason.

`web_search` is a guarded network tool and prompts on its first query. Choosing
"Yes, for this session" grants an in-memory allow for all subsequent
`web_search` queries in the current process. This exception is deliberately
session-only: choosing "always allow" stores the approved query narrowly and
does not disable the guarded first-use prompt for other queries.

## 5. `run_bash` command normalization

Raw `command` text is never compared directly:

1. **Unwrap** a `bash -c '...'` / `sh -c "..."` / `eval ...` wrapper, one
   level deep. If the quoted inner command can't be cleanly extracted (uses
   `$(...)`, is unquoted, concatenates), the whole call resolves to `ask`
   with no rule match possible (fail-closed, not fail-open).
2. **Split** on top-level `&&`, `||`, `;`, `|`, newlines, and a single
   standalone `&` (background), via a quote/paren-aware scanner — not a
   naive regex. Redirection targets stay attached to their segment. The
   fork-bomb literal (`:(){ :|:& };:`) is special-cased before splitting.
3. **Normalize** each segment: strip a leading `sudo` (so an allow rule for
   `npm test` also covers `sudo npm test` — privilege elevation shouldn't
   grant a *laxer* posture than the unprivileged form).
4. **Resolve each segment independently** against the same rule set, then
   combine via most-restrictive-wins: any segment `deny` → the whole call
   denies; else any segment `ask` → the whole call asks; else `allow`.

Bash pattern rules are prefix/exact text match only — no glob expansion
against shell text (ambiguous whether `*` is the user's shell glob or the
rule's wildcard).

### Unresolved-ask (fail-closed)

A segment containing a construct the normalizer can't safely classify
resolves to a distinct **unresolved-ask** marker rather than falling through
to whatever rule happens to match its visible first token. It is **never
bypassable by posture** — an unresolved segment always surfaces the real
prompt, regardless of auto-approve.

Triggers: inline command substitution (`$(`, backtick), process substitution
(`<(`, `>(`), a leading `NAME=value` assignment, a first token that isn't a
bare command word (leading backslash escape, a leading quote character —
`\rm`, `'rm'`), and a fixed set of command-carrying first tokens: `env`,
`nice`, `nohup`, `timeout`, `command`, `xargs`, `find` (only when `-exec`
is present), a bare `sh`/`bash` not already handled as a full wrapper. This
list is a heuristic, not exhaustive — arbitrary shell is not statically
analyzable — but the failure direction is conservative (ask), never
permissive.

`PermissionEngine.resolve()` returns `wasUnresolved: boolean` alongside the
action specifically so the UI can make this distinction without re-deriving
it from the raw command text.

## 6. Resolution algorithm

`PermissionEngine.resolve(toolName, args)`:

1. Collect all rules matching the subject, across three sources: builtin
   rules (destructive + guarded, always present) → `configRules` (loaded
   from `.nib/settings.json`, global then project, in append order) →
   `sessionRules` (in-memory, this process only, appended in approval
   order).
2. If zero rules match: fall through to `defaultMode` (`allowAll` → allow,
   `askAll` → ask) — **except** if `defaultMode` is `allowAll` but no
   *user-configured* rule exists anywhere for this tool (builtin rules
   don't count toward "recognized"), force `ask`. This is the
   unrecognized-tool safety net.
3. **Partition matches into `deny` / `ask` / `allow`.** Deny wins by
   default over ask, and ask wins by default over allow. Within the winning
   tier: if any matching rule has `kind: "any"`, it wins outright — an
   `any`-kind rule is an absolute kill-switch, never overridable by
   specificity. Otherwise, the highest-specificity rule in the tier wins,
   **unless** some `allow` rule is *strictly* more specific than every rule
   in that tier, in which case the allow rule wins — a deliberate, narrow
   escape hatch for a user overriding their own earlier broad deny/ask with
   a later narrower allow.
4. Ties (identical specificity, same tier) break by rule order (global
   config → project config → session, in append order within each).

```
resolve(tool, args)
  │
  ├─ normalize subject (bash segments, path resolution, domain scoping)
  │
  ├─ match against pools: builtin-destructive → builtin-guarded
  │                       → config → session
  │
  ├─ no matches ──► defaultMode (allowAll | askAll)
  │                  + unrecognized-tool safety net → ask
  │
  └─ matches:
       deny tier wins (any-kind = kill-switch)
         │ else ask tier (guarded/unresolved never posture-bypassed)
         │ else allow tier (specificity; narrow allow escapes broad ask)
       ▼
  { action, winningRule, wasUnresolved, isGuarded }
```

### Specificity

```
exact:  1000 + pattern.length
prefix: 500 + tokenCount * 10
glob:   globSpecificity(pattern), capped at 490
any:    0
```

`globSpecificity` scores a pattern by segment: a literal path segment is
worth 50, a single `*` segment is worth 5, a `**` segment is worth 1 — so a
narrow, mostly-literal glob scores near the prefix floor, and a broad `**`
scores near the `any` floor. The three kinds' ranges are deliberately
disjoint (glob's ceiling < prefix's floor < exact's floor) so a cross-kind
comparison can never invert regardless of pattern content.

## 7. Builtin tiers

Two builtin rule sets are always present, regardless of config, and cannot
be removed (only overridden per the rules below):

### Destructive tier (`src/permissions/destructive.ts`) — denies

`rm -rf /`, `rm -rf ~`, `git push --force`, `git push -f`,
`git reset --hard`, `git clean -fdx`, `mkfs`, `dd if=`, and the fork-bomb
literal. Each is `origin: "builtin-destructive"`, `action: "deny"`.

**Matching is hardened against known evasions**, not literal-string prefix
matching: the invoked command is resolved to its lowercase basename (so
`/usr/bin/rm -rf /` and `RM -RF /` both match `rm -rf /`), and a leading
short-flag cluster is canonicalized — sorted, lowercased, and merged across
separate tokens — so `-fr`, `-r -f`, `-f -r`, and `-rf` all match
identically. This hardening (`matchesBuiltinPrefix` in `rules.ts`) applies
only to builtin-origin prefix rules; ordinary user-authored rules keep
literal, case-sensitive, positional matching.

**Override policy**: not absolute — discarding your own uncommitted scratch
work via `git reset --hard` is common. A user-authored rule can only beat a
destructive deny by being *strictly* more specific (`git reset --hard
HEAD~1` beats `git reset --hard`; an equally-broad rule does not — ties go
to deny). Session-tier and always-tier approval of a destructive match are
both allowed, but the engine forces the approved rule to `kind: "exact"`
on the literal normalized command text — approving one instance never
silently broadens to "all matching commands."

### Guarded tier (`src/permissions/guarded.ts`) — always asks

Four categories, all `origin: "builtin-guarded"`, `action: "ask"`:

- **Secret-adjacent paths** (`read_file`/`write_to_file`/`edit`, glob-matched
  against the resolved path): `.env*`, `~/.ssh/*`, `~/.aws/*`, `id_rsa*`,
  `*.pem`, `credentials*`.
- **Dependency internals** (`read_file`/`list_files`, glob-matched against the
  resolved path): anything under `node_modules`. Discovery tools already
  skip `node_modules`; this closes the explicit-path hole so a human always
  sees a direct read into installed dependencies. Ask, not deny — reading
  an installed package's `.d.ts`/`package.json` is legitimate. The `search`
  tool is NOT covered: its subject carries no path (known gap).
- **Network egress** (`run_bash`, basename-matched): `curl`, `wget`, `nc`,
  `ssh`, `scp`, `rsync`.
- **Search egress** (built-in search tool, `kind: "any"`): `web_search` —
  the query string leaves the machine to the pinned search host
  (web-search-spec.md).

Guarded rules resolve to `ask`, not `deny` — reading your own `.env` or
curl-ing an API is common and legitimate. The guarantee is "a human always
sees this," not "this never runs": a guarded match is exempt from the
posture bypass exactly like an unresolved bash segment, so it can never be
silently auto-allowed regardless of posture or `defaultMode: allowAll`.

**Known gap**: the secret-path guard only covers the file-reading tools. A
`run_bash` command that reads a secret file as an argument (`cat .env`) is
not covered — see security-spec.md.

## 8. Persistence tiers

Chosen per-approval from the 4-option prompt:

- **Once** — no engine call at all; the turn just proceeds.
- **Session** — `engine.approveForSession(rule)` appends to an in-memory
  `sessionRules` array (`origin: "session"`). Never written to disk, cleared
  on process restart.
- **Always** — `engine.approveAlways(rule)` appends to `configRules` (live
  immediately, no reload needed) *and* persists to `.nib/settings.json`
  via an atomic write (temp file + `renameSync`), preserving all other
  top-level JSON keys.

Both session and always approval of a destructive- or guarded-origin match
force the approved rule to `kind: "exact"` on the literal subject text —
approving one instance never broadens to the whole category. Enforced at
the engine API level (`PermissionEngine.narrowToExact`), not left to UI
discipline.

## 9. Posture (Shift+Tab)

Posture is **UI-only state** (`App.tsx`), not engine state — the engine has
no session-wide auto-approve flag. Three values: `normal`, `autoApprove`,
`plan`. Cycled with Shift+Tab; the prompt shows non-default state.

- **Session-scoped. Never persisted** — a new session always starts
  `normal`.
- In `autoApprove`, the `askUser` callback bypasses an ordinary
  rule-derived `ask` result without prompting — **but never**:
  - a `deny` result (never bypassed, in any posture),
  - a result with `wasUnresolved: true`,
  - a result with `isGuarded: true`.

  This last exclusion is what prevents a secret-path read or network-egress
  command from being silently waved through in auto-approve posture.
- Sub-agent calls (threaded through `src/orchestrator/index.ts`) share the
  same `askUser` callback as the top-level agent — a sub-agent's ask-tier
  call surfaces to the same prompt flow, labeled with which sub-agent is
  asking, rather than being silently denied headlessly.

## 10. The ask prompt

Four options, cursor-navigable or number-keyed:

```
  [run_bash] npm install left-pad
  Risk: modifies state
  1. Yes, just once
  2. Yes, for this session
  3. Yes, always allow
  4. No
```

A destructive-origin match (`winningRule.origin === "builtin-destructive"`)
renders `DestructiveConfirmPrompt` instead — visually distinct (red border,
explicit warning banner) — with the same four options; the load-bearing
safety property is the engine forcing `kind: "exact"` on approval, not the
prompt's interaction style. Ctrl+E streams an AI explanation of the pending
action.

## 11. Audit trail

Every permission decision is recorded as a `permission` record in the
session's JSONL file (see [session-spec.md](./session-spec.md) for the
record shape and the read-side query API). `agent.ts` writes exactly one
row for **every** resolution path it handles, so the trail answers "why did
this run without asking me" and "what did I approve earlier this session".
`/permissions` opens a TUI view listing this session's decisions in order,
most recent selected by default; arrow keys browse, Esc closes.

Every resolution — sequential gate or parallel-batch pre-resolution — runs
through the composed `authorize()` (permission-profile.md §4): the profile
gate (layer 1) first — a deny is terminal, recorded as `deny-by-profile` —
then the unchanged rule engine. Absent `permissionProfile` config, layer 1
does not exist and the engine result is written exactly as before.

### Decision vocabulary — one value per resolution path

Each agent-side path emits a distinct `decision`, plus a human-readable
`reason` (both `subject` and `reason` are secret-redacted):

| `decision` | Path in `agent.ts` | `reason` (example) |
|---|---|---|
| `deny-by-profile` | profile gate (layer 1) denied before rule resolution — every `agent.ts` resolution goes through `authorize()` (permission-profile.md §4); no profile configured → layer 1 skipped | `deny by profile (layer 1)` |
| `deny-by-rule` | `resolve()` returned `deny` | `deny rule matched (builtin-destructive)` |
| `allow-by-rule` | `resolve()` returned `allow` (no prompt) | `allow rule matched (config)` |
| `ask-approved` | `resolve()` returned `ask`, `askUser` → true | `approved by user at prompt` |
| `ask-denied` | `resolve()` returned `ask`, `askUser` → false | `denied by user at prompt` |
| `unresolved-ask` | `ask` approved but a bash segment was `wasUnresolved` | `approved by user; bash segment was unresolved (fail-closed ask)` |
| `headless-deny` | `resolve()` returned `ask` with no `askUser` supplied | `resolved to ask with no interactive prompter (headless)` |
| `allow-by-posture` | `resolve()` returned `ask`, `askUser` → `"posture"` (auto-approve posture upgraded it, no prompt shown) | `auto-approve posture upgraded an ordinary ask` |

`winningRule` is attached whenever the resolution had one (absent only for a
`defaultMode` fallthrough with no matching rule).

### UI-side nuances (agent-side approximations)

Two distinctions are only knowable in the TUI, so `agent.ts` records its
best approximation and the finer detail is left to `App.tsx`:

- **Fine-grained approval (`once` / `session` / `always`).** `askUser`
  returns `true`/`false` (or `"posture"`), so the agent can't tell which
  button the user pressed; it records `ask-approved`. `App.tsx
  handlePermissionDecision` *additionally* writes a row carrying the
  precise `once` / `session` / `always` (or `deny`) value. An
  interactively-approved call therefore yields **two** rows — the agent's
  `ask-approved` and the UI's fine-grained one. Accepted on purpose: the
  agent's write is the one that guarantees coverage of paths the UI never
  logs.
- **`allow-by-posture`.** When the auto-approve posture short-circuits an
  ordinary ask, `App.tsx`'s `askUser` resolves `"posture"` **without**
  showing a prompt or writing any row, and `agent.ts` records
  `allow-by-posture`. `ask-approved` is therefore exclusively an
  interactive yes. Headless `askUser` implementations (e.g.
  `exec-runner.ts`) never resolve `"posture"` — there is no posture to
  consult.

### Token-usage trail

Alongside permission rows, `agent.ts` writes one `token` record per turn
(`turnTokens`, `totalUsed`, `budgetMax`; `remaining` derived on read). See
[session-spec.md](./session-spec.md) and `SessionStore.queryTokenUsage`.

## Headless Interaction

Headless mode removes the human, not the engine. Headless exec mode
(`src/exec-runner.ts`) constructs a `PermissionEngine` from the loaded
config exactly as the TUI does (`new PermissionEngine(config.permissions,
projectRoot)`) and passes it to `runAgent`, so every tool call is resolved
normally: explicit `allow` rules and `defaultMode` apply, and the
destructive-tier `deny` stays absolute.

- **Fail closed on any ask.** There is no one to prompt, so `runExecMode`
  supplies an `askUser` that always denies. Every result that would ask —
  an ordinary rule-derived `ask`, a guarded-tier match (secret-adjacent
  read / network egress), or an unresolved bash segment — resolves to deny;
  the tool does not run. `defaultMode: askAll` therefore denies any
  unmatched call.
- **One stderr line per denied ask**, `permission denied (headless): <tool>
  <subject>`, so a scripted user can see why a run did less than expected.
  (A destructive-tier `deny` blocks execution without reaching `askUser`,
  so it does not emit this particular notice.)
- **`runAgent` was already fail-closed** on `ask` when no `askUser` is
  supplied; the only defect was that exec mode passed no engine at all.
  Fixed 2026-07-31 (T11 in security-spec.md); regression coverage in
  `src/exec-runner.test.ts`.

## 12. Design decisions

1. **Rule-based, not scope-buckets.** The prior design classified every
   call into one of 11 coarse buckets (`read-in-cwd`, `write-in-cwd`, …);
   there was no way to allow `git status` forever without also exposing
   `git push --force` under the same bucket. Rules match tool + argument
   pattern directly.
2. **Deny wins by default, not raw specificity argmax.** An early design
   ranked all matching rules by specificity regardless of action and let
   the highest score win — this let a blanket glob allow numerically
   outrank a narrow deny, and let a global `any`-kind deny "lose" to any
   real allow rule. The action-tier partition plus the `any`-kind
   absolute-kill-switch exception fixes both.
3. **Two extra builtin tiers, not baked into ordinary config.**
   Destructive and guarded rules exist independent of what the user
   configures, and can't be silently removed — only overridden by a
   strictly narrower user rule, or (for guarded) simply answered "yes" at
   the prompt.
4. **Posture is UI state, not engine state.** The engine has no notion of
   "auto-approve this session" — that decision is made once, at the point
   an `ask` result reaches a UI, by checking `wasUnresolved`/`isGuarded`
   first. This keeps the engine deterministic and testable independent of
   any UI.
5. **Approval narrows, never broadens.** Every persistence path (session
   or always) defaults to the narrowest rule that satisfies the specific
   call just approved — an exact match on the literal subject text unless a
   broader `winningRule` already existed to approve. A destructive or
   guarded match is *always* narrowed to exact on approval, regardless of
   what rule shape was offered.
