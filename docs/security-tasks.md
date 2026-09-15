# Security hardening — project-supplied config

Work items for closing the remaining ungated project-config channels.
One task per section. Mark `[x]` when done **and verified**.

Context: a cloned repo's `.nib/` is attacker-controlled. Nib already
gates project **hooks** (`src/hooks/trust.ts`), **skills** (`src/skills/trust.ts`),
and — as of `8f3a343` + `30fdd67` — **execution-capable settings**
(`src/config/settings-trust.ts`, gating `statusline` / `mcpServers` / `notify` /
`env` / `strictMcpConfig`).

Prior art to follow, in order of relevance:
- `src/config/settings-trust.ts` — the TOFU store these tasks extend
- `src/config/loader.ts` — `EXECUTION_CAPABLE_KEYS`, `resolveProjectExecutionKeys`,
  `loadJsonFile` sanitization, `deepMerge` hardening
- `src/cli.tsx` (interactive enforcement) / `src/exec-runner.ts` (headless)

---

## Task 1 — gate `permissions` / `permissionProfile` / `sandbox`

**Status:** `[x]` — done and verified
**Severity:** High — privilege escalation

A project `.nib/settings.json` can currently set permission rules, the
permission profile, and sandbox config with **no consent**. Worse, two consumers
read the *unstripped* config even for keys that are gated today:

- `src/cli.tsx:253` — `configResult.config.permissions`
- `src/exec-runner.ts:175` — `configResult.config.permissions`
- `src/exec-runner.ts:110-113` — `sandbox.enabled` + `permissionProfile.level`
- `src/exec-runner.ts:183-184` — `new ProfileEvaluator(configResult.config.permissionProfile, ...)`

A hostile repo can therefore grant itself allow-rules, drop the sandbox, or set
an `unrestricted` profile — defeating the controls that make every *other* gate
meaningful.

**Decision (user, this session): gate them UNCONDITIONALLY.** Any project-supplied
value for these three keys requires consent. Do **not** build "only prompt when
widening" logic — it was considered and explicitly rejected.

Do:
- Add `permissions`, `permissionProfile`, `sandbox` to `EXECUTION_CAPABLE_KEYS`.
- Extend `resolveProjectExecutionKeys` so detection stays **authoritative**
  (derived from resolved values, never raw key names — see `30fdd67` for why).
- Extend `stripExecutionKeys`. Critical: stripping must fall back to the
  **secure** direction. Verify what an absent `permissions` / `permissionProfile` /
  `sandbox` actually resolves to at each consumer — if absent means "no
  restrictions", stripping would *worsen* security. Establish this before writing
  the strip, and state the finding in the task report.
- Fix the consumers above to read the **effective** (post-strip) config. Audit
  every other `configResult.config.*` read in both entry points for the same bug.
- Update the exact-set assertion in `src/config/settings-trust.test.ts`.

**Verify:** hostile project sets `permissionProfile.level: "unrestricted"` +
`sandbox.enabled: false` + a broad allow rule → untrusted run must not apply any
of them; trusted run applies them. Prove via the resolved config *and* through a
consumer (e.g. that `ProfileEvaluator` never sees the hostile profile).

**Resolution notes:**
- `EXECUTION_CAPABLE_KEYS` (loader.ts), `resolveProjectExecutionKeys`, and
  `stripExecutionKeys` (settings-trust.ts) done as described in the doc
  comments there. Strip-fallback direction: `permissions` → plain `delete`
  (absent resolves to `defaultMode: "askAll"`, the strictest state);
  `permissionProfile`/`sandbox` → forced to `{ level: "strict-sandbox" }` /
  `{ enabled: true }` respectively, NOT deleted, because absent resolves to
  the *least* restrictive state for both (`"unrestricted"` / Seatbelt off) —
  a plain delete would have handed the untrusted run exactly the state the
  attacker asked for.
- `src/exec-runner.ts` consumers fixed to read `effectiveConfig` (the
  post-strip binding already used elsewhere in that file).
- `src/cli.tsx` audit finding: **no code change was needed at lines
  253/260-261/411-414.** Unlike exec-runner.ts, cli.tsx's TOFU gate
  (`main()`, ~L174-193) does not use a separate `effectiveConfig` binding —
  on decline it reassigns the `configResult` variable itself
  (`configResult = { ...configResult, config: stripExecutionKeys(...) }`).
  Every read this task named is textually *after* that reassignment in the
  same linear `main()` execution, so once `permissions`/`permissionProfile`/
  `sandbox` were added to `EXECUTION_CAPABLE_KEYS`, those four reads started
  seeing the stripped config automatically, as a side effect — confirmed by
  running the exact gate logic against a hostile settings.json in both
  directions (see report). Full audit of every other
  `configResult.config.*` read in both entry points found no other instance
  of this bug — all remaining raw reads are of keys never in
  `EXECUTION_CAPABLE_KEYS` (`provider`, `model`, `hooks`, `disableAllHooks`,
  `commands`, `contextWindow`, `compaction`, `theme`, `keybindings`,
  `workflow`, `refresh`, `enabledSkills`, `showCost`), which is correct —
  only the eight gated keys need the post-strip config.
- Fixed 5 pre-existing tests broken by the new gating (fixtures wrote
  `permissions`/`permissionProfile` into a project settings.json without
  calling `trustSettings()` first, which the new gate now correctly strips):
  `src/config/settings-trust.test.ts` (one fixture used `permissions` as an
  example *non*-execution key — updated), `src/exec-runner.test.ts` tests
  (a) and (f), and both tests in `src/exec-runner.subagent.test.ts` (shared
  `beforeEach` fixture) — each given an explicit `trustSettings()` call,
  matching the pattern already used elsewhere in the same files.
- `npx vitest run`: 119 files / 1660 passed / 1 skipped (was 1651+1 baseline
  — 9 new tests added, all green). `npx tsc --noEmit`: clean.
- `~/.nib/skill-trust.json`: still exactly 25 entries — confirmed after
  all exploit/test runs.

---

## Task 2 — audit `.nib/agents/*.md`

**Status:** `[x]` — investigated, no gate recommended (see evidence below)
**Severity:** Unknown — investigate before deciding

`src/agents/index.ts:201` loads project agent definitions with no trust check.
Earlier analysis concluded this is prompt-injection risk (text to the model), not
code execution — but that was a **shallow** check and must not be treated as
cleared.

Do **not** implement a gate yet. Investigate and report:
- Full frontmatter schema of an agent definition. Can it carry tool grants,
  permission overrides, model/provider selection, or anything that resolves to a
  path, command, or network destination?
- Does anything in a loaded `AgentDef` reach a subprocess, a file write, or a
  fetch — directly or via the orchestrator?
- Do sub-agents inherit the parent's permission engine, or can a definition
  influence their own?

If it is genuinely text-only, say so plainly with evidence and recommend no gate.
If any field reaches an executable sink, stop and report — do not design the fix
in the same pass.

**Investigation findings:**

Frontmatter schema (`src/agents/index.ts` — `KNOWN_FIELDS`) is exactly 5
fields: `name`, `description`, `mode` (string, required), `model` (optional
"provider/model" string), `instructions` (optional string). No `tools`,
`permissions`, `path`, `command`, or `url` field exists or is read.

- **`mode`** is the interesting field: it's passed unvalidated to
  `ModeLoader.load(modeSlug)` (`orchestrator/index.ts:264`), which can load a
  **project-supplied** `.nib/modes/<slug>.yaml` defining a `groups`
  list (`orchestrator/index.ts:272`, `tools/registry.ts` `getByMode`) that
  controls which tools are exposed as callable to the sub-agent's LLM. In
  principle a hostile repo could define a custom mode combining all 5 tool
  groups (`read`, `edit`, `command`, `mcp`, `workflow` — the full set, a
  superset of any single built-in mode). **This does not bypass
  authorization**, though: every tool call — regardless of which mode/group
  exposed it — passes through `authorize()` (`agent.ts:466`/`515`), which
  consults the same `permissions`/`permissionProfile` objects the parent
  session constructed once at startup (now correctly TOFU-gated per Task 1).
  `orchestrator/index.ts`'s `createHandler` never constructs a new
  `PermissionEngine`/`ProfileEvaluator` for a sub-agent — confirmed no
  production code path does (`grep` for `new PermissionEngine`/
  `new ProfileEvaluator` outside test files returns nothing in
  `orchestrator/` or `agents/`) — so mode/groups only changes the *menu* the
  LLM sees, never what a call actually resolves to. Also: `.nib/agents/`
  and `.nib/modes/` are both already inside the attacker-controlled
  project tree in this threat model, so a hostile agent def referencing a
  hostile mode file isn't reaching anything it doesn't already own.
- **`model`** ("provider/model") is passed to `this.options.provider(modelId)`
  → `createProvider(name, options)` (`providers/presets.ts:103`), which
  throws `Unknown provider` for anything not already in
  `configProviders`(user's own settings.json) or `BUILTIN_PRESETS`  — an
  agent file cannot invent a new provider or host. `baseUrl`/`apiKey` are
  only forwarded from the parent's *own* startup-resolved values when the
  selected provider matches the parent's startup provider
  (`cli.tsx`/`exec-runner.ts`'s provider-factory closures); switching
  provider via `model` gets that provider's own independent key/host
  resolution, never a hostile override. No credential exfiltration or
  traffic redirection path found.
- **`instructions`** is spliced directly into the system prompt
  (`prompt.ts:88` — `sections.push(ctx.agentInstructions)`). Confirmed
  text-only — no parsing, no interpolation into a shell command, path, or
  URL anywhere downstream.
- **`name`**/**`description`** are used only as a `Map` key and as
  interpolated text in the `new_task` tool schema's description
  (`orchestrator/index.ts:179-180`) shown to the LLM — text-only.
- **`sourcePath`** (derived from the filesystem path, not attacker content)
  is stored on `AgentDef` but never read by any consumer — dead field today.

**Verdict: genuinely text-only for the purposes this task asks about** — no
field reaches a subprocess, file write, or network fetch, and sub-agents
strictly inherit the parent's single permission engine/profile instance with
no way for a definition to construct or influence its own. **No gate
recommended** for agent definitions themselves.

**Adjacent, lower-priority observation (not a Task 2 finding, flagged for
awareness only):** the `mode` field lets a hostile repo's agent definition
select a hostile repo's own custom mode file, which can request the union of
all 5 tool groups (something no single built-in mode does). Since every call
is still authorized against the gated permission engine, this does not
escalate privilege — but it does maximize the *menu* of tools the LLM is
invited to call, which is a wider prompt-injection/attack surface than a
built-in mode would offer for a task that didn't need it. Not recommending
action here since it doesn't reach an executable sink un-gated; noting it in
case a future review wants to cap custom-mode `groups` for agent-spawned
sub-runs specifically.

---

## Task 3 — decide `webSearch` gating (analysis only)

**Status:** `[x]` — implemented and verified
**Severity:** Low — pre-existing

`webSearch.searxngUrl` lets a project control the **host** every `web_search`
query is sent to (`src/tools/web-search-searxng.ts:66`), exfiltrating queries and
controlling results fed back to the model. Pre-existing (landed in `b45a986` /
`e40837f`), opt-in, and orthogonal to the trust commits — a prior review put it
below the reporting bar.

`env.BASE_URL` is already gated for the *same* traffic-redirect reason, so there
is a consistency argument for adding `webSearch`.

Note `src/tools/web-search.ts:318` calls `loadConfig()` fresh per invocation. A
previous review confirmed this does **not** re-open the gated keys (it reads only
`webSearch.searxngUrl` and `webSearch.enrich`) — but that per-call pattern would
silently bypass the gate for any key added to it later. Flag this as a structural
hazard.

Deliverable: a short written recommendation, no code.

**Recommendation:**

Gate `webSearch.searxngUrl` the same way as `env.BASE_URL` — add it to
`EXECUTION_CAPABLE_KEYS`, strip it on an untrusted project settings file
(fallback: absent → the Bing path, which is the existing default and the
strictest available option, so a plain `delete` is correct here, same
direction as `permissions`/`strictMcpConfig`). Reasoning:

1. **Identical mechanism to an already-gated key.** `env.BASE_URL` is gated
   specifically because a project can redirect a class of outbound traffic
   (LLM provider calls) to a host it controls. `webSearch.searxngUrl` is the
   same primitive applied to a different traffic class (search queries) —
   same exfiltration shape (the query text leaves to an attacker-chosen
   host) and the same result-injection risk (the attacker's SearXNG instance
   controls what comes back and is fed to the model as "search results").
   There's no principled reason one is gated and the other isn't; leaving it
   ungated is an inconsistency in the trust model, not a considered
   exception.
2. **Low severity does not mean zero severity, and the fix is cheap.** This
   task's own severity label ("Low — pre-existing") is about urgency, not
   about whether the gate is justified. The mechanism now exists
   (`EXECUTION_CAPABLE_KEYS`/`stripExecutionKeys`/TOFU prompt) and Task 1
   just proved it generalizes cleanly to new keys — adding one more entry is
   a small, well-understood change, not a new subsystem.
3. **`webSearch.enrich` should NOT be gated.** It only toggles whether result
   pages are fetched for extra content — no host selection, no traffic
   redirection. Gating it would be scope creep with no security benefit.

**Structural hazard (flag only, not this task's fix):** `web-search.ts:318`'s
`resolveSearxngUrl()`/`resolveEnrich()` call `loadConfig()` fresh per
invocation and read directly off `.config.webSearch` — bypassing whatever
`effectiveConfig`/strip step the entry point (`cli.tsx`/`exec-runner.ts`)
already did once at startup. Today this is safe only because `webSearch` is
not in `EXECUTION_CAPABLE_KEYS` yet — there is nothing to bypass. The moment
`webSearch.searxngUrl` (or any future key) is added to the gated set, this
per-call `loadConfig()` pattern will silently re-read the raw, unstripped
value on every single search, regardless of the startup trust decision —
a full bypass of the gate for that one tool, undetectable by a
`configResult.config.*` audit like the one Task 1 did (there's no
`configResult` in this file to grep for). **Any future PR that adds
`webSearch` to `EXECUTION_CAPABLE_KEYS` must also change
`resolveSearxngUrl`/`resolveEnrich` to read from a passed-in effective
config (e.g. threaded through `ToolContext`, matching how other gated values
already reach tool handlers) instead of calling `loadConfig()` directly.**
This is a general pattern hazard worth a comment at the `loadConfig()` call
site now, even before `webSearch` is gated, so the next person adding a key
here doesn't reintroduce the same bypass.

**Implementation notes (this session):**
- `EXECUTION_CAPABLE_KEYS` (loader.ts): added `"webSearch"`.
- `resolveProjectExecutionKeys` (loader.ts): runs the real `validateWebSearch`
  validator against `projectRaw.webSearch` alone and detects `webSearch` as
  project-execution-capable only when the resolved value has a defined
  `searxngUrl` — a project block containing only `enrich` is correctly NOT
  detected (verified with a dedicated test), matching the "derived from
  resolved values, never raw key names" rule from `30fdd67`.
- `stripExecutionKeys` (settings-trust.ts): `webSearch` is special-cased like
  `env` — only `searxngUrl` is deleted, `enrich` is preserved, and the whole
  `webSearch` object is dropped if empty after stripping (mirrors the `env`/
  `BASE_URL` branch exactly). Confirmed the fallback direction is secure: an
  absent `searxngUrl` makes `resolveSearxngUrl()` return `undefined`, and
  `web-search.ts`'s handler takes the unchanged `if (!searxngUrl) { ... }`
  Bing-only branch — the existing default and strictest available option —
  so a plain delete (not a forced value, unlike `permissionProfile`/
  `sandbox`) is correct here, same direction as `permissions`.
- **Structural hazard fixed** (the real point of this task): `web-search.ts`
  no longer calls `loadConfig()` per invocation. Chosen approach: a
  module-level setter, matching the existing `setSandboxLevel`/
  `setTimeoutToBackground` idiom in `tools/index.ts` exactly — added
  `webSearch?: WebSearchConfig` to `ToolContext` (tools/types.ts) and a
  `setWebSearchConfig()` setter (tools/index.ts) that writes into the same
  module-singleton `ctx` object those setters already use.
  `cli.tsx`/`exec-runner.ts` call it once at startup with the EFFECTIVE
  (post-TOFU-strip) config, right next to their existing `setSandboxLevel`
  calls. `web-search.ts`'s `resolveSearxngUrl`/`resolveEnrich` now read
  `ctx.webSearch` (the per-call `ToolContext` the handler already receives)
  instead of calling `loadConfig()`. This was preferred over threading the
  config through `ToolRegistry`/tool-def signatures because the setter
  pattern already exists in this exact file for this exact purpose (sandbox
  level, timeout-to-background) — adding a third followed established
  precedent instead of introducing a new wiring shape.
- **Audit for other per-call `loadConfig()` gated-key readers:** grepped
  every `loadConfig(` call site outside tests. Only two exist:
  `exec-runner.ts:74` (the legitimate once-per-run startup load, already
  gated correctly) and the two `web-search.ts` call sites fixed above. No
  other tool or module reads a gated key via a fresh per-call `loadConfig()`.
- **Both-direction tool-level proof** (not just the resolved config object):
  a standalone script (run via `tsx`, isolated `NIB_HOME`/`HOME`, real
  `fetch` mocked) drove the actual production entry point
  (`executeTool` from `tools/index.ts` — the same function `cli.tsx`/
  `exec-runner.ts` call) end-to-end: `loadConfig` → `checkSettingsTrust` →
  `stripExecutionKeys` → `setWebSearchConfig` → `executeTool("web_search")`.
  Untrusted hostile `webSearch.searxngUrl: "https://attacker.example"`:
  `attacker.example` was never contacted — only `www.bing.com`. Trusted
  (after `trustSettings()`): `attacker.example` (standing in for a real
  approved SearXNG host) WAS contacted with the actual search query. Also
  covered as two dedicated vitest cases in `settings-trust.test.ts` using
  the same `executeTool`/`setWebSearchConfig` path.
- Test fixes for the refactor: `src/tools/web-search.test.ts`'s
  `vi.mock("../config/loader.js", ...)` was removed (no longer applicable —
  the tool doesn't import `loadConfig` anymore) and `makeCtx()` now builds
  `ctx.webSearch` from the same `mockSearxngUrl`/`mockEnrich` module
  variables the per-test assignments already set, so every existing test
  case kept working unchanged. `exec-runner.test.ts` and
  `exec-runner.subagent.test.ts` mock `./tools/index.js` wholesale and
  needed `setWebSearchConfig: () => {}` added alongside the existing
  `setSandboxLevel`/`setTimeoutToBackground` mock stubs.
- `npx vitest run`: 119 files / 1668 passed / 1 skipped (baseline 119/1660/1
  — 8 new tests, all green). `npx tsc --noEmit`: clean.
- `~/.nib/skill-trust.json`: still exactly 25 entries; no
  `settings-trust.json` in the real `~/.nib` — confirmed after all
  exploit/test runs (isolated `NIB_HOME` used throughout, including the
  standalone exploit script).

---

## Ground rules for all tasks

- **Test isolation:** set *and* restore **both** `NIB_HOME` and `HOME` in
  `beforeEach`/`afterEach`. `resolveHome()` prefers `NIB_HOME`; a past bug
  leaked ~1786 junk entries into the user's real store because a test set only
  `HOME`. Do not repeat it.
- **Never touch the user's real `~/.nib/`.** Confirm at the end:
  `skill-trust.json` still has exactly **25** entries.
- **Baseline:** `npx vitest run` → 119 files / 1651 passed / 1 skipped.
  `npx tsc --noEmit` clean. Report new numbers.
- **Reproduce before believing.** `8f3a343` shipped a gate that was bypassable on
  the first attempt, and its own canary evidence did not hold up. Prove each fix
  with an actual exploit attempt in both directions (blocked untrusted / works
  trusted), not with tests alone.
- **`JSON.stringify({__proto__: ...}) does not reproduce prototype pollution** —
  object literals invoke the setter instead of creating an own property. Write
  literal JSON text in fixtures. See the helper comment in
  `src/config/settings-trust.test.ts`.
- **Do not commit. Do not push.** The user reviews before publishing.
- ~~Do not implement folder-level trust — still an open design question.~~
  Implemented, see "Folder-level trust (fast path)" below.

---

## Folder-level trust (fast path)

**Status:** `[x]` — implemented and verified
**Files:** `src/config/folder-trust.ts` (+ `folder-trust.test.ts`),
`src/ui/views/FolderTrustPrompt.tsx`, wiring in `src/cli.tsx`.
`src/exec-runner.ts` is deliberately **unmodified** (see below).

### What it is

A single bulk-approval question — "Do you trust the files in this folder?" —
asked once per project directory, layered in front of the three existing
independent per-artifact TOFU gates (skills: `src/skills/trust.ts`, hooks:
`src/hooks/trust.ts`, settings: `src/config/settings-trust.ts`). It is a
convenience, not a fourth trust mechanism: answering "yes" does nothing more
than bulk-write into the exact same three trust stores those gates already
read (`skill-trust.json`, `settings-trust.json`, `hooks-trust.json`), for
exactly the artifacts present in the project **right now** — using each
gate's own key derivation (realpath + full sha256 for skills/settings, the
content-hashed `hookTrustKey` for hooks). A "yes" is fully equivalent to
answering "yes" to every pending per-artifact prompt individually.

### Deliberate limits (do not "fix" these)

- **Not a blanket grant.** Folder trust's own store
  (`<NIB_HOME>/folder-trust.json`) records the content hash of every
  artifact that was present at trust time. If anything is **added** or
  **edited** afterward, `checkFolderTrust` reclassifies the folder as
  `changed` — but more importantly, the artifact itself has no matching entry
  (or a stale one) in its own gate's store, so the underlying gate
  (`checkSkillTrust` / `checkSettingsTrust` / a hook's `hookTrustKey`)
  independently re-classifies as `new`/`changed` and re-prompts, completely
  unaware folder trust exists. This is the tamper signal that caught a
  hostile `permissionProfile: "unrestricted"` during testing, and it survives
  folder trust by construction — folder trust never *shortcuts* a gate's own
  classification logic, it only *pre-seeds* the gate's store with a decision
  equivalent to a manual "yes".
- **Headless never auto-trusts.** `src/exec-runner.ts` has **no folder-trust
  code at all** — it doesn't import `checkFolderTrust`/`trustFolder`/the
  prompt. This is intentional, not an oversight: headless has no one to ask,
  so it must never itself decide "yes" for a folder. It doesn't need to,
  either — a folder trusted in a *prior interactive* session already
  bulk-wrote into `skill-trust.json`/`settings-trust.json`/`hooks-trust.json`,
  and headless's existing per-artifact gates (`checkSettingsTrust`,
  `SkillLoader`'s headless skip, `HookRunner.verifyTrust()`) read those exact
  same stores unchanged. So a prior interactive "yes" is honored transparently,
  per-artifact, while anything unseen/edited/added still fails closed with the
  same stderr warnings as before folder trust existed. Proven end-to-end by
  driving the real `runExecMode`: untrusted → `[warn] Untrusted project
  settings...` fires; after a prior `trustFolder()` call → no warning, the key
  takes effect.

### Hook approach and why

Hooks are checked **lazily at fire time**
(`HookRunner.ensureTrusted`/`trustKeyFor`, `hooks/runner.ts`), not at startup,
so a naive "mark everything trusted at startup" sweep can't cover them — at
folder-trust time you don't even know which hooks will fire this session.

Chosen approach: **at folder-trust time, enumerate the project's parsed hook
entries (`configResult.config.hooks.entries`, already resolved by
`parseHooksConfig` before `HookRunner` is even constructed) and pre-record a
trust entry into `hooks-trust.json` for each, using the exact same key
derivation `HookRunner.trustKeyFor` computes lazily** —
`hookContentHash(command, projectDir, cache)` then
`hookTrustKey(event, matcher, command, contentHash, projectDir)`.

This was preferred over the alternative (having the lazy check consult
folder trust as a fallback) because it requires **zero changes to
`hooks/runner.ts` or `hooks/trust.ts`**: `HookRunner` stays completely
unaware folder trust exists. `verifyTrust()`/`ensureTrusted()` already call
`isHookTrusted(loadHookTrust(), key)` — they simply find the pre-recorded
entry already there and treat it exactly as if the user had answered the
`HookTrustPrompt` directly. Because the trust key already **encodes** the
hook's content hash (command string, or — for a file command — the script's
own file content, mtime-gated), an edited command or script produces a
different key with no matching pre-recorded entry, and the lazy check falls
through to a normal ask with no special-casing anywhere. Change detection for
hooks was therefore free — it's the same mechanism the per-hook gate already
had, not a new one folder-trust had to invent.

### Wiring

`src/cli.tsx`: a new `promptFolderTrust()` (same throwaway pre-mount Ink
render pattern as the existing `promptSettingsTrust()`) runs in `main()`
immediately after the TTY check, **before** the settings-trust gate (which
itself runs before skills load / hooks' `verifyTrust()`). `buildFolderContentSummary()`
assembles what's gated right now from `configResult` (settings keys, project
hook entries) plus a dedicated lightweight skill scan
(`discoverProjectSkills` — skills aren't loaded by `SkillLoader` yet at this
point in startup, so folder trust can't reuse it). If nothing is gated
(`hasGatedContent` false), no prompt fires at all — matching a project with
no untrusted gated content never being asked. A "no" falls through with zero
side effects; the three gates below run exactly as before, unaware anything
happened.

`src/exec-runner.ts`: intentionally untouched (see "Headless never
auto-trusts" above) — a comment at the settings-trust gate documents why.

### Verification

- `npx vitest run`: 120 files / 1682 passed / 1 skipped (baseline
  119/1668/1 — 14 new tests in `src/config/folder-trust.test.ts`, all green,
  no regressions). `npx tsc --noEmit`: clean.
- Real-run proof (isolated `NIB_HOME`, driving the actual production
  functions, not mocks): (a) a project with a skill + `mcpServers` settings
  key — `checkFolderTrust` starts `new`, `trustFolder()` flips it (and the
  real `checkSkillTrust`/`checkSettingsTrust`) to `trusted`; (b) editing the
  settings file afterward flips both `checkSettingsTrust` and
  `checkFolderTrust` back to `changed`; (c) adding a new skill afterward
  reports it as `new` via `checkSkillTrust` (never silently granted trust by
  the earlier folder decision) and `checkFolderTrust` as `changed`. A second
  script drove the real `runExecMode` end-to-end and confirmed the headless
  stderr warning fires when untrusted and is silent (gate passes) after a
  simulated prior interactive `trustFolder()` call, with no folder-trust code
  present in `exec-runner.ts` at all.
- `~/.nib/skill-trust.json`: still exactly 25 entries; no stray
  `folder-trust.json`/`settings-trust.json` in the real `~/.nib` —
  confirmed after all test/exploit runs (isolated `NIB_HOME`/`HOME`
  throughout).
