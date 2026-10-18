# Permission Specification

**Status:** current · verified 2026-10-17 · covers `src/permissions/{engine,rules,bash-normalize,destructive,guarded,builtin-allow,profile}.ts`, `src/permissions/risk/auto.ts`, `src/exec-runner.ts`, `src/ui/App.tsx`

## 1. Overview

The permission system: rule-based pattern matching on tool + argument
(exact/prefix/glob/any), a builtin destructive-command deny tier, a builtin
secret-adjacent/network-egress ask tier, and a session-level posture overlay
that makes the agent usable without editing config mid-session. The
**auto** posture (§9) is the one place a model, not a human, answers an ask.

Threat model and known permission-engine defects:
[security-spec.md](./security-spec.md). The builtin destructive and guarded
tiers take precedence over ordinary rule resolution as specified in §7.

### The gate, end to end (`gateCall` in `src/agent.ts`)

![nib permission gate: the gate, the stage-2 model judge, and where a FLAG changes the outcome](./diagrams/nib-permission-gate.png)

Source: [`diagrams/nib-permission-gate.excalidraw`](./diagrams/nib-permission-gate.excalidraw)
(open it at excalidraw.com, then re-export the PNG after editing). The Mermaid
flows below are the text versions and the ones to keep in step with the code;
the PNG predates the auto posture (§9), which the flows below include.

Every tool call passes these layers in order, and each one can only tighten the
decision (`allow < ask < deny`) — except the auto posture's judge, which can turn
an ask into an allow (§9, docs/command-risk-classifier.md §15). The engine is §6,
the ask branch is §10, and the classifier is docs/command-risk-classifier.md.

```mermaid
flowchart TD
  TC([model emits tool call]) --> AUTH
  subgraph L1["authorize() · permissions/profile.ts"]
    AUTH{"profile.decide()"} -- deny --> PD[deny-by-profile]
    AUTH -- pass --> ENG["engine.resolve() · §6"]
  end
  ENG -->|"action, winningRule,<br/>wasUnresolved, isGuarded"| UNS{"unsandboxed<br/>run?"}
  UNS -- "yes + engine allow" --> FORCEASK["engineAction = ask"]
  UNS -- no --> CL
  FORCEASK --> CL
  CL{"classifier.mode<br/>(auto forces the rules to run)"} -- off --> CLAMP
  CL -- "shadow / enforce" --> RISK["classifyRiskWithModel()"]
  RISK -->|RiskVerdict| CLAMP["applyRiskVerdict()<br/>enforce: max(engine, tier)<br/>shadow: identity"]
  RISK -. "shadow + would be stricter" .-> EVID[(appendClassifierEvidence)]
  CLAMP --> UNA{"unsandboxed requested<br/>but not allowed?"}
  UNA -- yes --> DENYU[UNSANDBOXED_NOT_ALLOWED]
  UNA -- no --> ARB{"auto active and<br/>rules tier block?"}
  ARB -- yes --> DENYA["deny-by-classifier<br/>(any classifier.mode)"]
  ARB -- no --> ACT{action}
  ACT -- deny --> DENY["PERMISSION_DENIED"]
  ACT -- ask --> ASK["ask branch · §10"]
  ACT -- allow --> AR["audit allow-by-rule"]
  AR --> PTU{"PreToolUse hook"}
  ASK -->|approved| PTU
  PTU -- blocks --> HD[denied by hook]
  PTU -- passes --> EXEC([execute])
  classDef deny fill:#b4231822,stroke:#b42318;
  classDef ask fill:#b5470822,stroke:#b54708;
  classDef ok fill:#06764722,stroke:#067647;
  class PD,DENYU,DENY,DENYA,HD deny
  class ASK,FORCEASK ask
  class EXEC,AR ok
```

Every branch writes an audit row carrying the full `RiskVerdict`, shadow mode
included. A hook `allow` never upgrades an ask.

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

**External reads scope to the enclosing project.** Approving a read outside the
working directory stores a grant for the project that path lives in — the
nearest ancestor carrying a `.git` entry, or the start directory itself when
there is none — as a `glob` on `<project>/**` (`buildPathRule`). The
`search`/`glob`/`list_files` grant also stores the project root itself, because
`<base>/**` does not match `<base>` and those tools resolve their subject to
exactly that directory (`withCompanion`). This is what makes exploring a
sibling repository one prompt instead of one per folder; the scope is bounded
by construction — a start at `$HOME`, an ancestor of it, or `/` falls back to
the previous narrower scopes (exact for search/glob, one directory level for
the rest). The search for the root runs on realpaths (only they see a symlinked
parent) and the result is translated back into the caller's spelling, which is
what subjects are matched in; when the two disagree — a symlink whose target
sits deeper than the path reaching it — the walk cannot say what the lexical
path covers, so it grants nothing and the narrow scope stands. Per tool, as
always: a `search` grant is not a `read_file` grant. Writes are unaffected — an
external write approval is still exact.

The guard that fires for those calls is the dynamic out-of-workspace rule
(§7), tagged `externalRead: true` on the rule so `narrowToExact` leaves the
grant broad. That tag exists on this one rule and nowhere else: static secret
guards still narrow approvals to the exact subject.

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
to whatever rule happens to match its visible first token. The UI never skips
its prompt on a posture's account. Under the auto posture (§9) the judge, not
the user, answers it: `wasUnresolved` is not one of its hard stops, and the
judge reads the unresolved shape in the feature summary (`parse`,
`substitution`, `wrappers`).

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
   a later narrower allow. Two cases are excluded from that escape hatch: an
   `any`-kind tier rule (below), and a **guarded** ask, which only an *exact*
   allow out-specifies — a broad grant never answers a secret-path prompt
   (§7).
4. Ties (identical specificity, same tier) break by rule order (global
   config → project config → session, in append order within each).
5. **The risk classifier's clamp** (docs/command-risk-classifier.md), applied
   after the unsandboxed override and before the call is executed. It can only
   make the result *more* restrictive: `confirm` turns an `allow` into an
   `ask`, `block` denies. It can never quiet a prompt the rules asked for.
   Inactive under `classifier.mode: shadow` (the default), where the verdict is
   recorded on the audit row and the engine's action stands unchanged. With
   `classifier.model.enabled` the same step may also consult a small model, which
   is *additive* to the clamp: it can move `safe|benign` to `confirm` and nothing
   else, so it has no path to an allow and none to a deny
   (docs/command-risk-classifier.md §6).

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
         │ else ask tier (guarded/unresolved are always asks; auto's judge: §9)
         │ else allow tier (specificity; narrow allow escapes broad ask)
       ▼
  { action, winningRule, wasUnresolved, isGuarded }
         │
         └─ classifier clamp (enforce only; narrowing-only)
              allow ──confirm──► ask     ask ──block──► deny
```

The same algorithm at the level of `resolveSubject()`, including the escapes the
sketch above leaves out (builtin read-allow, the `web_search` session escape,
the dynamic-guard escape):

```mermaid
flowchart TD
  R["resolve(tool, args)"] --> K{tool kind}
  K -- "run_bash / _background" --> B["buildBashSubject()<br/>split into segments"]
  K -- apply_patch --> P["extractApplyPatchPlan()<br/>one subject per target file"]
  K -- "web_fetch / remote view_image" --> D["subject = hostname"]
  K -- "file tools" --> F["subject = normalized path"]
  B --> RS
  P --> RS
  D --> RS
  F --> RS
  RS["resolveSubject() per segment/target"] --> M["matching rules:<br/>BUILTIN_DESTRUCTIVE · BUILTIN_GUARDED<br/>config · session<br/>+ dynamic out-of-workspace guard (search/glob)<br/>+ dynamic write-boundary rule (write tools)"]
  M --> Z{any match?}
  Z -- no --> BA{"BUILTIN_ALLOW<br/>(reads in ./**)?"}
  BA -- yes --> AL1[allow]
  BA -- no --> DM{"defaultMode allowAll<br/>and tool has a user rule<br/>(or MCP server configured)?"}
  DM -- yes --> AL2[allow]
  DM -- no --> AS1[ask]
  Z -- yes --> DN{deny match?}
  DN -- yes --> T1["resolveTier(deny)"]
  DN -- no --> WS{"web_search with<br/>session any-allow?"}
  WS -- yes --> AL3[allow]
  WS -- no --> AK{ask match?}
  AK -- no --> AL4["allow<br/>(highest-specificity allow)"]
  AK -- yes --> DY{"only dynamic guards<br/>+ a path-scoped allow?"}
  DY -- yes --> AL5[allow]
  DY -- no --> T2["resolveTier(ask)"]
  T1 --> TR
  T2 --> TR
  TR{"resolveTier:<br/>kind:any in tier → tier wins<br/>guarded + no exact allow → tier wins<br/>allow strictly more specific → allow"}
  classDef ask fill:#b5470822,stroke:#b54708;
  classDef ok fill:#06764722,stroke:#067647;
  class AS1 ask
  class AL1,AL2,AL3,AL4,AL5 ok
```

Bash segments combine most-restrictive (any deny → deny, else any ask → ask),
and an unparseable segment (`wasUnresolved`) can only push the result up.

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
sees this," not "this never runs": a guarded match resolves to `ask` exactly
like an unresolved bash segment, regardless of `defaultMode: allowAll`, and no
posture ever approves it on its own. The one place a guarded ask is answered
without a human is the auto posture (§9): one that is not a hard stop (curl,
`web_search`, `node_modules` reads) is decided by the judge, and a credential
file path stays a stop that always prompts.

**A guarded ask is not out-specified by a broad grant.** Step 3's
narrow-allow escape hatch (§5) requires an **exact** allow for that path:
a `glob` or `prefix` allow — an ordinary folder grant, or the project tree an
external read approval stores — leaves the guarded ask in force
(`resolveTier`). Without this, "read anything in this project" would silently
answer "may I read this project's `.env`", because a tree glob long enough to
name a project outscores a short guard pattern like `**/.env*`. Approving that
one secret path deliberately still works: the exact rule it stores out-
specifies the guard.

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
discipline. The one exception is the dynamic out-of-workspace read guard,
tagged `externalRead` — its approval is meant to broaden to the enclosing
project (§4).

The rule *passed in* for such an approval must already be exact, so callers
build it with `buildDefaultRule(tool, args, { exactOnly: true })` (App.tsx
does this whenever the winning rule narrows). Broadening first and narrowing
the pattern afterwards leaves an "exact" rule whose pattern is a glob string,
which matches no real path — pressing "always" on a `.env` prompt would then
grant nothing, forever re-prompting.

## 9. Posture (Shift+Tab)

Posture is **session state held outside the engine** (`ctx.mutable.posture`,
read by `src/ui/App.tsx` and, per call, by the agent's auto gate) — the engine has
no session-wide flag. Three values, cycled with Shift+Tab in this order:
`normal → auto → plan`; the status bar shows non-default state (`auto`,
`auto · paused`, `plan`).

- **Session-scoped.** A session starts `normal`, or `auto` when the global-only
  `classifier.defaultPosture` is `"auto"` (docs/config-spec.md). `plan` is never
  a starting posture. Nothing else is persisted; entering `auto` resets its
  block counters.
- **`normal`.** Every ask is answered by the user (§10), except an edit inside the
  profile write set, which the UI allows without a prompt (`"posture"`, below).
  A credential or protected path is never in that set for this purpose
  (`isSensitiveEditPath`, `src/permissions/risk/features.ts`): an edit of
  `.env`, `.husky/*`, `.vscode/*`, `.github/workflows/*`, a shell rc file,
  `id_rsa`, `*.pem` or `credentials*` shows the normal prompt in every posture.
- **`plan`.** Read-only; see mode-spec.md.
- **`auto`.** A model judge, not the user, answers an engine `ask`. The decision
  is made in `gateCall` (`decideAuto`, `src/agent.ts`), never in the UI: the UI
  does not skip a prompt on this posture's account. Full design:
  docs/command-risk-classifier.md §15. In order:
  1. A rules-tier `block` is denied in every `classifier.mode` (an engine
     `deny` keeps its own message), with one exception: a block whose reasons
     are exactly `["net.secret-egress"]` (a credential variable sent over the
     network, `isJudgeableBlock`) becomes an ask and goes on to step 2, even over
     a user allow rule or `enforce` mode. Engine `deny` is unchanged, and an
     engine `allow` otherwise runs with no judge.
  2. After the PermissionRequest hook and the sandboxed-Bash session-grant
     reuse, **hard stops** go to the real prompt with a note, never to the
     judge: a credential path (a Bash command that references a credential
     file, such as `cat .env` or `~/.aws/credentials`, is a stop exactly as
     `read_file` of `.env` is; a credential variable such as `$GITHUB_TOKEN` is
     not, and is judged), a protected
     path, a git config operation, and any call outside the OS sandbox
     (requested or excluded). Plain `isGuarded` (curl, `web_search`,
     `node_modules`) is **not** a stop; those are judged.
     **A call whose winning rule is an `ask` the user wrote** (`action: "ask"`,
     `origin` anything but `builtin-guarded`) is a stop too, because an `ask`
     rule is an instruction to be asked and the judge never overrules it. The
     audit row is `{stage: "fallback", outcome: "hard-stop"}` and the note reads
     "Auto mode: your ask rule matched (`<tool>: <pattern>`)." No winning rule
     at all (the `defaultMode` fallthrough) still goes to the judge.
  3. Once 3 consecutive or 20 total judge blocks have accumulated, auto is
     **paused**: every ask prompts until the user approves a call.
     Steps 2 and 3 pass `AutoHandoff` (`"hard-stop"` | `"paused"`) as the sixth
     argument of `askUser`; the UI then shows the real prompt and never
     resolves `"posture"` (the write-set overlay), so an edit of `.env` or
     `.husky/*` is asked about rather than allowed silently. A judge failure
     (timeout, error, unparseable) carries no handoff.
  4. Rules tier `safe`, an edit inside the profile write set, or
     `ask_user_question` (interactive: the user answers it anyway) or
     `check_job` (read-only job status; `kill_job` stays judged)
     (`skipsAutoJudge`) runs with no judge call.
  5. Otherwise the two-stage judge decides. ALLOW runs the call, BLOCK denies it
     with the tag's canonical sentence, and a timeout, an error or an
     unparseable stage-2 answer falls back to the ordinary prompt (an
     unparseable stage-1 answer goes on to stage 2 first).
  An auto allow never grants the per-call exec widening: no `envelopeHash`, no
  `approvedGitConfigWrite`, so a judged call runs under the profile as it stands.
  It still passes the PreToolUse hook.
- **`autoApprove` is removed** (2026-10-17). It waved ordinary rule-derived asks
  through in the UI, excluding `deny`, `wasUnresolved`, `isGuarded` and every
  `run_bash` ask, and was refused when no OS containment was active, so on an
  unsandboxed session it did nothing for Bash. The auto posture replaces it with
  a judged decision that works with the sandbox off. `permission_mode` in hook
  payloads is now `"auto"` where it was `"autoApprove"`.
- **What `"posture"` means now.** `askUser` still resolves `"posture"` for one
  case, whatever the posture: the UI allowed an edit inside the profile's write
  set without showing a prompt (permission-profile.md §5). It is no longer an
  approve-all outcome. The overlay is skipped when `askUser` receives an
  `autoHandoff`, and `editTargetInWriteSet` returns false for a credential or
  protected path (`isSensitiveEditPath` on the canonical cwd-relative path, so a
  workspace ancestor named `credentials-api/` does not match, while
  `src/credentials.ts` does and prompts). Not a deny: the edit reaches the
  ordinary prompt. `.git/` and `.nib/settings.json` stay always denied.
- Sub-agent calls (threaded through `src/orchestrator/index.ts`) share the same
  `askUser` callback as the top-level agent — a sub-agent's ask-tier call
  surfaces to the same prompt flow, labeled with which sub-agent is asking,
  rather than being silently denied headlessly. Under auto they share the one
  `AutoModeState` too, and the judge sees the delegated task labelled as
  written by the main agent, not the user.
- **Headless (`nib -p`) does not use auto** (§Headless Interaction).

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

### The sandboxed-Bash session grant

An **eligible** ask — `run_bash` or `run_bash_background` (one shared grant;
both run under the same envelope), under an active sandbox level on a
platform where the profile is applied, not guarded, not a config-authored rule,
not the widened `.git/config` variant (docs/permission-ux-redesign.md) — replaces
`s/Yes, for this session/Yes, sandboxed Bash in this workspace for this session/`
and drops `Yes, always allow`:

```
  [run_bash] timeout 60 python3 mcp_probe.py --check
  Execute timeout 60 python3 mcp_probe.py --check
  1. Yes, just once
  2. Yes, sandboxed Bash in this workspace for this session
  3. No
```

The session answer is a different decision, not a persisted rule (`askUser`
resolves `"envelope-grant"` and no UI row is written; the agent writes the
canonical row). The prompt carries the envelope the launch would run under, and
the consent copy is generated from the profile's own write set, so the prompt and
the profile cannot disagree. See §11 for the resulting vocabulary and
`src/ui/PermissionPrompt.tsx` `grantConsentLines` for the disclosure text.

### The ask branch in `gateCall`

```mermaid
flowchart TD
  A([action = ask]) --> PR{"PermissionRequest<br/>hook blocks?"}
  PR -- yes --> X1[ask-denied]
  PR -- no --> HL{"askUser present?"}
  HL -- "no (headless)" --> X2["headless-deny<br/>classifier reason if it caused the ask"]
  HL -- yes --> EL{"isEligibleForGrant()<br/>sandboxed · run_bash(/_background)<br/>not guarded · not a user rule ·<br/>not git-config · not unsandboxed"}
  EL -- no --> PROMPT
  EL -- yes --> LK{"grant lookup for<br/>(session, profileHash)"}
  LK -- hit --> RE["allow-by-envelope-grant<br/>(reuse)"]
  LK -- miss --> INV["invalidateOther(): drop a grant<br/>approved for a different hash"]
  INV --> AG{"sandbox.autoAllowBash?"}
  AG -- yes --> NG["grant() → allow-by-envelope-grant"]
  AG -- no --> AU{"auto posture<br/>active?"}
  AU -- no --> PROMPT["askUser(tool, args, envelope,<br/>askOrigin, policyRisk)"]
  AU -- yes --> HS{"hard stop, your ask rule<br/>or paused?"}
  HS -- "yes (autoHandoff:<br/>no write-set overlay)" --> PROMPT
  HS -- no --> RO{"tier safe or<br/>write-set edit?"}
  RO -- yes --> AC["allow-by-classifier<br/>(stage readonly, no exec grant)"]
  RO -- no --> JG{"two-stage judge<br/>docs/command-risk-classifier.md §15"}
  JG -- allow --> AC
  JG -- block --> DC["deny-by-classifier<br/>canonical tag sentence"]
  JG -- "timeout / error /<br/>unparseable" --> PROMPT
  PROMPT -- false --> X3[ask-denied by user]
  PROMPT -- posture --> PO["allow-by-posture<br/>(write-set edit, no exec grant)"]
  PROMPT -- envelope-grant --> NG
  PROMPT -- true --> AP["ask-approved / unresolved-ask<br/>git config op → approvedGitConfigWrite"]
  RE --> EH["exec.envelopeHash = profileHash"]
  NG --> EH
  EH --> PTU{PreToolUse hook}
  PO --> PTU
  AC --> PTU
  AP --> PTU
  PTU -- passes --> GO([execute])
  PTU -- blocks --> X4[denied]
  classDef deny fill:#b4231822,stroke:#b42318;
  classDef ok fill:#06764722,stroke:#067647;
  class X1,X2,X3,X4,DC deny
  class GO,RE,NG,PO,AP,AC ok
```

A changed envelope drops the old grant *before* the prompt, so a "No" cannot
leave it to re-arm later. At launch, Bash refuses to run if the profile no
longer hashes to `envelopeHash`.

When auto falls back to the prompt, the prompt carries a note saying why
("Auto mode: this touches a credential file, so auto mode leaves it to you.",
"Auto mode paused after repeated blocks.", "Auto mode could not decide
(timeout)."), and the audit row for the eventual answer carries the `auto`
trace. A user "yes" on such a prompt clears the consecutive-block count.

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
| `allow-by-posture` | `resolve()` returned `ask`, `askUser` → `"posture"` (the UI allowed an edit inside the profile write set, no prompt shown) | `allowed by the UI without a prompt (edit inside the profile write set)` |
| `allow-by-classifier` | auto posture: an engine `ask` that the read-only tier (`auto.stage: "readonly"`) or the judge (`"stage1"` / `"stage2"`) allowed; no `exec` grant | `auto mode judge allowed the call` / `auto mode: read-only call or edit inside the write set` |
| `deny-by-classifier` | auto posture: the judge blocked the call (`auto.stage` `"stage1"` / `"stage2"`), or a rules-tier `block` was denied in any `classifier.mode` (`"rules"`); the tool result is the rule message or the tag's canonical sentence, never the judge's text | `auto mode judge blocked the call (auto.destruction)` / `denied by the risk classifier in auto mode (git.force-push)` |
| `allow-by-envelope-grant` | `askUser` → `"envelope-grant"` (the session consent, `envelopeGrant: "granted"`), or an eligible ask covered by the session grant with no prompt at all (`envelopeGrant: "reuse"`) | `session grant granted for the current sandbox envelope` / `session grant reused (approved <ts>)` |
| `grant-invalidated` | the session grant was dropped: the envelope it was approved against no longer matches this launch's profile (before the re-ask), or the spawn-time profile hash check refused the launch | `session grant invalidated: the envelope … no longer matches` / `the sandbox envelope changed after the grant was approved` |
| `grant-revoked` | the user revoked the session grant in `/permissions`; written only by that panel | `revoked by the user in /permissions; eligible foreground Bash asks prompt again` |
| `sandbox-failure` | a contained launch's child never confirmed its profile: the command did not run, and no unsandboxed retry exists | `the macOS sandbox profile was not confirmed inside the child` |

`winningRule` is attached whenever the resolution had one (absent only for a
`defaultMode` fallthrough with no matching rule).

**The `auto` field.** A row the auto gate handled carries
`auto: { stage, outcome, latencyMs, tag?, reason?, judge? }`: `stage` is
`readonly | rules | stage1 | stage2 | fallback`, `outcome` is
`allow | block | timeout | error | unparseable | suspended | hard-stop`, `judge`
the judge model's id, `reason` the judge's one-liner (secret-redacted, cut to
200 characters; audit only, never shown to the agent). A call that fell back to
the prompt keeps the trace on the `ask-approved` / `ask-denied` row that follows:
`stage: "fallback"` with outcome `hard-stop` (a stop, or a call matched by the
user's own `ask` rule) or `suspended`, or the judge's own
stage with outcome `timeout`, `error` or `unparseable`. `computeSessionPermissionMetrics` counts these as `autoAllows`,
`autoBlocks`, `autoFallbacks`, `autoJudgeCalls`, `autoStage2Calls` and
`autoP95Ms`; `/permissions` shows `auto N allowed · N blocked · N asked`.
An `allow-by-classifier` row counts as an approval and a `deny-by-classifier`
row as a denial, neither as a prompt.

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
- **`allow-by-posture`.** When the UI short-circuits an edit inside the profile
  write set, `App.tsx`'s `askUser` resolves `"posture"` **without** showing a
  prompt or writing any row, and `agent.ts` records `allow-by-posture`. It is
  never taken for a credential or protected path, nor for a call auto handed to
  the user (`autoHandoff`). It is not an auto-posture outcome: auto's allows are `allow-by-classifier` rows
  written by the agent, with no UI involvement. `ask-approved` is therefore
  exclusively an interactive yes. Headless `askUser` implementations (e.g.
  `exec-runner.ts`) never resolve `"posture"` — there is no posture to
  consult.
- **The session-consent answer.** `askUser` resolving `"envelope-grant"`
  likewise writes no UI row — unlike `once`/`session`/`always`, there is no
  persisted rule to record — so a consent produces the agent's single
  `allow-by-envelope-grant` row. The panel counts that row as a **prompt** (the
  user was interrupted for it) while a `"reuse"` row counts as an **approval**
  with no prompt, which is what makes the before/after prompt count in
  docs/permission-ux-redesign.md comparable. A settings change that rewrites the
  profile invalidates the grant and prompts again, so it is never a permanent
  waiver.

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
- **No auto posture.** `exec-runner.ts` passes no `autoMode`, so
  `classifier.defaultPosture: "auto"` does not apply to `nib -p`: an ask is a
  denial as above. Auto in headless is out of scope for now; the intended route
  is an explicit `--permission-mode auto` flag, not the global setting, since an
  unattended run should not silently inherit a model that answers asks.
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
4. **Posture is not engine state.** The engine has no notion of "auto this
   session" — the decision is made once, at the point an `ask` result reaches
   the gate (`decideAuto`), after the hard stops. This keeps the engine
   deterministic and testable independent of any UI or model; a judge failure
   degrades to the ordinary prompt rather than to either answer.
5. **Approval narrows, never broadens.** Every persistence path (session
   or always) defaults to the narrowest rule that satisfies the specific
   call just approved — an exact match on the literal subject text unless a
   broader `winningRule` already existed to approve. A destructive or
   guarded match is *always* narrowed to exact on approval, regardless of
   what rule shape was offered.
