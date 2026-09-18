# Changelog

All notable changes to Nib are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.5.1] — 2026-09-15

### Added

- **Public npm and Homebrew distribution.** Nib publishes as
  `@amenski/nib` while keeping the `nib` executable. A release workflow checks
  the `vX.Y.Z` tag against package metadata, runs the full build gate, smoke
  tests the packed tarball in an isolated prefix, and uses npm Trusted
  Publishing. The Homebrew formula source is a checksum-placeholder template
  until the scoped tarball exists; the release procedure documents the separate
  tap update.
- **Sandboxed Bash session consent.** An interactive user can approve eligible
  foreground Bash calls for the current workspace and sandbox profile for one
  session, then revoke the grant in `/permissions`. Denied and guarded calls,
  background jobs, subagents, and unsupported platforms remain outside it.

### Changed

- **Package-manager upgrades are now owned by the package manager.** Nib no
  longer queries the npm registry, displays an update UI, or invokes global npm
  installation itself. This removes automatic network contact; providers and
  integrations are contacted only when configured or invoked.
- **License text is the canonical Apache License 2.0.**
- **Long-session context handling.** Older consumed tool results can be removed
  from large model requests while the complete session transcript stays local;
  oversized tool output is capped and earlier conversation can be compacted.

### Security

- **Child process containment.** macOS Seatbelt profiles now protect sibling
  and credential paths under the home directory and restrict writes to approved
  roots, including child paths through MCP servers, hooks, notifications, and
  status lines. Files outside the home directory may still be readable. Direct
  child network connections are denied by the tested profile; system name
  resolution remains a documented residual.
- **Fail-closed sandbox launch.** A child signals readiness only after its
  sandbox profile applies. Missing readiness reports a specific failure,
  revokes a Bash session grant, and never retries unsandboxed.
- **Untrusted output marking.** Tool output uses matching per-call delimiters,
  and duplicated wrappers and control-character sanitizers were consolidated.

## [0.5.0] — 2026-09-15

The project is now **nib** — the writing point of a pen. Same tool; the name
changes everywhere it is user-visible: the binary, the package, the state
directory, each project's config directory, and the four environment variables.
This is a rename release. The security fixes below are what the rename itself
forced; the entries under Fixed are separate defects closed while the rename was
underway.

**Breaking: the upgrade steps in "Changed" are required, not optional.**

### Changed

- **The command is `nib`.** The package, its `bin` entry, and everything that
  names the product (persona line, welcome wordmark, help and usage text, error
  strings, the `User-Agent`, the MCP `clientInfo`, and the git identity on
  checkpoint commits) all follow. The `HTTP-Referer` and OpenRouter title now
  point at the real new slug.
- **Upgrade: the state directory is `~/.nib/`.** Copy the precious subset from
  `~/.heirloom/` — `sessions/`, `memory/`, `prompt_history/`,
  `credentials.yaml`, `settings.json`, `models.json`, `mcp-pins.json`, and the
  four `*-trust.json` stores. Copy rather than
  move: the old directory then *is* the backup. There is no read-fallback and no
  directory symlink — a symlink would resolve onto the stale trusted keys and
  silently skip a trust prompt.
- **Upgrade: each project's config directory is `.nib/`.** Existing
  `.heirloom/` directories are left untouched; the new one starts empty, so
  project settings are re-trusted on first run — expect one trust prompt per
  project.
- **Upgrade: environment variables renamed** — `HEIRLOOM_HOME` → `NIB_HOME`,
  `HEIRLOOM_REFRESH` → `NIB_REFRESH`, `HEIRLOOM_PROFILE` → `NIB_PROFILE`,
  `HEIRLOOM_HIGH_CONTRAST` → `NIB_HIGH_CONTRAST`. No aliases, because nothing
  outside this repo ever referenced the old names — no shell profile sets them.
- **Upgrade: sessions and prompt history need their slug fixed.** Both are keyed
  by `slugify(cwd)`, so moving the checkout orphans the entries already on disk:
  rename the slug directory under `~/.nib/sessions/` and the slug file under
  `~/.nib/prompt_history/` to match the new path. `nib --resume` confirms it.
- Repository is now `github.com/amenski/nib`; the old URL redirects. The old
  global bin needs removing by hand — `npm rm -g` resolves the symlink back into
  the renamed folder.

### Security

- **Closed a false-accept between the loader and the trust gates.** The project
  settings path was constructed independently at four sites — what the loader
  reads, what the interactive gate asks about, what the headless gate asks
  about, and what folder-trust hashes. Renaming the directory could have flipped
  one and not the others: a project keeping a content-unchanged `.heirloom/`
  settings file would still match its stale trusted entry, while the keys
  actually in effect came from a freshly-added `.nib/` file — so `mcpServers`,
  `statusline` and `env.BASE_URL` would take effect with no prompt. All four now
  build the path from one function. A constant alone would not have been enough;
  a constant can still be missed at one site.
- **The always-deny guard now covers both directory names.** `isAlwaysDenied` is
  the only thing standing between the agent and the settings file that carries
  `permissions.rules`, and it matches by path suffix. Left on the old name it
  would have failed open and silently: writes to `.nib/settings.json` would have
  dropped out of the always-deny set with nothing to notice. The state-dir
  settings file had already fallen out of that set when the state dir moved, and
  is covered again here.
- **`update-check` and skill loading now honor the state-dir override.** Both
  ignored it. `update-check`'s prompt path reads *and clears* its state file, so
  tests that believed they were isolated were clearing the real one; and skill
  loading was the only state-dir path ignoring an override its own trust store
  honored, so with the override set, skills loaded from one tree while trust was
  recorded in another.
- The npm-registry update check stays inert, but the rename did not retire its
  trap — it reproduced it. npm's `nib` is also someone else's package, so a
  published build under the new name would prompt users to install a CSS
  library. `private: true` is what makes it a no-op.

### Fixed

- **A test wrote into the real state directory on every run.** The `/model`
  switch test exercises the code path that records a recent-models entry, and it
  set no state-dir override — so each run appended a genuine entry to the
  developer's own `settings.json`. Older than this release, but the rename is
  what made it visible, by moving where it landed. It now points at a temp dir.
- **The checkpoint shadow repo had no bound on what it could stage or keep.**
  `save()` ran `git add -A` over the entire workspace with nothing but an
  extension-based exclude list, and nothing ever gc'd or pruned the per-session
  repo. Incident 2026-08-17: two sessions whose cwd was `$HOME` (235 GB) staged
  14 GB, and an interrupted repack stranded 14.5 GB and 12.4 GB `tmp_pack` files
  under `checkpoints/` — 26 GB, none of it reachable, none of it ever collected.
  Three guards now: a 5000-entry cap counted with `git status --porcelain -uall`
  (`-uall` is load-bearing — the default collapses an untracked directory to a
  single line and would have read `$HOME` as 206 entries, so the cap would never
  have fired), `gc.auto=0` on every shadow-repo git invocation so a checkpoint
  can never trigger a repack, and a sweep of stranded `tmp_pack_*` at init.
  See [docs/session-spec.md](docs/session-spec.md) §8.

### Tests

- **The default persona line is asserted for the first time.** "You are Nib, a
  helpful AI coding assistant." had no test anywhere: every other `You are`
  assertion targets a mode's `roleDefinition` or an agent's persona override,
  both of which replace this line. A rename could have left the preamble naming
  the wrong product with the whole suite green. Verified by flipping the line
  back and watching the new test fail.

### Notes

- The stable prompt preamble is documented as byte-stable across turns, and this
  release changes one of its bytes. The first turn after upgrading pays a full
  uncached prefix, then re-caches. Unavoidable, and it happens once.
- `docs/archive/**` keeps the old name. It is the historical record.
- Historical entries below and `docs/release-0.3.0.md` also keep it: they state
  what was true when they were written, and rewriting the paths in them would
  claim those paths never existed.

## [0.4.2] — 2026-09-15

A wave of parity features: headless `@file`/`@image` mentions now run through
the same expansion logic as the TUI, vision-capable models get a warning when
an image is sent to one that can't see it, custom slash commands from file
definitions (`.heirloom/commands/*.md`) appear alongside builtins in Tab
completion and `/help`, and three CLI flags close Claude Code gaps (`--max-
turns`, `--allowed-tools`/`--disallowed-tools`, `--name`). The bundled model
catalog now derives each model's vision capability from Models.dev's modality
data, and the token budget accounts for both per-image estimates and raw image
payload bytes. The catalog itself is now generated from a real Models.dev
capture — 12 models became 421, and 8 of the previous 12 carried wrong context
or price figures that fed compaction thresholds and `/cost`. Long tool-heavy
sessions are the other half of this release: request-time context editing stops
them resending the same tool output on every call.

### Added

- **Custom slash commands** from `.heirloom/commands/<name>.md` (project > global). Frontmatter fields: `description`, `argument-hint`. Body text serves as the user prompt; `$ARGUMENTS` is replaced with trailing args. Custom names surface in Tab completion alongside builtins. ([src/commands/index.ts](src/commands/index.ts))
- **`/rename <title>` slash command** — sets a custom display name for the current session (stored in the index, survives derived-title updates). Shown in `/sessions` and `/resume`. ([src/cli.tsx:1588])
- **`--max-turns <n>`** CLI flag — caps agentic turns in print mode. Reaching the limit exits non-zero (`stopReason === "max_turns"`), mirroring agent.ts's existing cap but now reachable from the CLI. ([src/cli-args.ts](src/cli-args.ts))
- **`--allowed-tools` / `--disallowedTools`** CLI flags — restrict or remove tools from the offered set. These are availability filters (a disallowed tool can never be called) strictly stronger than permission denials which still surface a `PERMISSION_DENIED` result. Applied at turn start via `[tool-name].filter`. ([src/tools/filter.ts](src/tools/filter.ts))
- **`--name <title>`** CLI flag — sets a custom display name for a freshly-created session. Ignored for resumed sessions. Stored in the index so it survives the first-message's derived-title update. ([src/cli.tsx:657])
- **Vision capability in the bundled catalog.** Each model's `vision` field is derived from Models.dev's `modalities.input` array (`true` = includes "image", `false` = declared without it). The catalog generator (`catalog-generator.ts`) reads modality data that was previously unhandled. ([src/providers/catalog-generator.ts](src/providers/catalog-generator.ts))
- **Vision warning.** `imageSupportWarning()` surfaces a diagnostic/warning when images are being sent to a model not declared as vision-capable. Reads `caps.vision` from the provider's capabilities; warns differently for `vision: false` (text-only declared) vs absent (unknown). Fires in both the TUI bridge (`runAgentTurnBridge`) and headless exec-runner. ([src/providers/registry.ts](src/providers/registry.ts))
- **Image byte accounting in token budget.** `estimateTokens()` adds a flat `IMAGE_TOKEN_ESTIMATE` (1,100 tokens) per image instead of counting base64 payload chars (which would read as ~50k tokens per screenshot). `promptBytes` in `aisdk.ts` counts the actual base64 length since that measures wire bytes. ([src/compaction/budget.ts](src/compaction/budget.ts))
- **Request-time context editing.** Once an assembled provider request reaches 100,000 estimated input tokens, the copy sent to the provider has the contents of older tool results replaced with an explicit cleared placeholder. The three newest consumed results stay complete, and every result from the immediately preceding tool batch does too — so a tool result is always whole on the first request that sees it, however long it is. The local transcript, `newMessages`, the UI output and the persisted session are never edited, so your session file keeps everything, and tool-call/result pairing and message order are untouched. This is what keeps long tool-heavy sessions from resending hundreds of thousands of tokens per call without ever truncating a result the model has not yet read. ([src/compaction/context-editing.ts](src/compaction/context-editing.ts))
- **Model catalog grown from 12 models to 421, generated from a real Models.dev capture.** `models.json` was hand-authored to match Models.dev's schema and never generated from its data; comparing all 12 bundled models against the live feed, 8 were wrong — including `gpt-5.6-sol`, the OpenAI default, which claimed a 256k context at 10 $/M output when it is 1.05M at 30 $/M. Those numbers drive compaction thresholds and `/cost`, so the shipped estimate was a third of the real price. `npm run models:capture` is now the explicit maintainer step (online, filters); `npm run models:generate` stays offline and strict, and the fixture carries its own provenance block so `models status` reports where the catalog came from. ([scripts/capture-models-fixture.ts](scripts/capture-models-fixture.ts))
- **`heirloom models update` and `heirloom models status`.** Refresh the bundled catalog from the Models.dev feed on demand. The update validates the feed by running it through the same generator, diffs it against the active snapshot, and asks before writing; `--yes` skips the prompt, and a non-TTY without `--yes` refuses outright, because silent unattended updates are an explicit non-goal. Declining leaves the catalog untouched and exits 0 — a declined diff is not a failure. The snapshot merges between the bundled fallback and your own `models.json`, and is written temp-file-then-rename so a crash cannot leave a truncated catalog. ([src/providers/catalog-update.ts](src/providers/catalog-update.ts))
- **Model picker scales to the larger catalog.** The unqueried view caps each provider group and offers `… N more — type to filter`; any query lifts the cap entirely, since truncating filtered results would hide the thing being searched for. Favorites and Recent are never capped.

### Changed

- **Headless `@mention` parity.** `expandFileMentions` runs before the first call in `exec-runner.ts` too — `@notes.md` expands to a `<file>` block; `@shot.png` attaches a base64 data URL on `imageUrls`. Both paths use the same permission-gated authorize check. Previously headless silently ignored all mentions. ([src/exec-runner.ts](src/exec-runner.ts))
- **Completer accepts custom command names.** The tab-completion engine now takes an optional third argument listing extra slash command names (from the commands loader) and merges them into the completion set. Custom commands shadow builtins by name. ([src/cli.tsx:1224])
- **`/context` reports both thresholds.** It now shows the 100,000-token context-editing trigger alongside the model-relative compaction threshold, instead of collapsing them into one number. ([src/cli.tsx:1503])
- **Background-job completions collapse into one status segment.** A finished job used to push its own status-line segment (`● job 3a2f done (exit 0) · 12 lines`), newest-first and capped at five — a row that could not represent a long session honestly, only truncate it. Now a running tally: `● 5 jobs done · 247 lines`, switching to red and spelling out the outcomes (`● 4 done · 1 killed · 247 lines`) as soon as one did not, so a failure is scannable without reading back through the transcript. Per-job ids, exit codes and output still stream into the transcript as `[job e63e]` rows. ([src/ui/core/job-stream.ts](src/ui/core/job-stream.ts))

### Fixed

- **Compaction overcount on image-heavy sessions.** Before, every attached image counted as zero in `estimateTokens` (no image path existed), then its full base64 string inflated `promptBytes` for status purposes — two different metrics, one broken. Now both measure consistently: token estimate uses a flat 1,100-per-image nominal cost; `promptBytes` counts actual payload bytes. ([src/compaction/budget.ts](src/compaction/budget.ts))
- **`search` timeout test failed on CI.** The test opened a FIFO so grep would block and be killed, then asserted the error names the timeout. On Ubuntu with Node 20+ the search returned no error at all, so the assertion read `undefined` and the Build leg went red on `v0.4.1`. It now drives the timeout branch through an injected fake `execFile` and clock, exercising the same production path with no subprocess. ([src/tools/search.test.ts](src/tools/search.test.ts))
- **Provider errors no longer corrupt the TUI.** `streamText`'s default `onError` printed the full `APICallError` object — stack, request body, headers — into the Ink render before the app's own concise error line appeared. Suppressed at the source with an explicit no-op `onError` rather than a process-global `console.error` override, which would have swallowed every later error too. Headless already did this. ([src/providers/aisdk.ts](src/providers/aisdk.ts))
- **A turn that ends on an announced action no longer stops silently.** A model replying "Let me read the current state:" and stopping had signaled a tool call it never made, but the loop treated the preamble as a finished answer and ended the turn — one line rendered, prompt returned. A trailing colon on the final line now earns one system nudge back into the loop, guarded so a second colon-terminated reply ends the turn instead of looping. ([src/agent.ts](src/agent.ts))
- **Answer blocks no longer render a bare `●` row.** A streamed chunk carrying a paragraph and its trailing blank line tagged both as bulleted, printing an empty bullet above the next tool call, while the mirror case spent the bullet on a leading blank and left the real first line plain. ([src/ui/App.tsx](src/ui/App.tsx))

### Docs

- **CLAUDÉ-CODE-PARITY updated** — items #3 (custom slash commands) and #4 (flag parity batch — max-turns, allowed/disallowed tools, --name) marked as shipped. Remaining gap items documented where they land. ([docs/claude-code-parity.md](docs/claude-code-parity.md))

### Tests

- **[catalog-generator.test.ts]** Vision derivation tests (true/false/absent across modalities variants). ([src/providers/catalog-generator.test.ts](src/providers/catalog-generator.test.ts))
- **[presets.test.ts]** `imageSupportWarning` unit tests: silent on vision:true, silent on no images, warning on vision:false, warning on unknown provider, multi-image pluralization. ([src/providers/presets.test.ts](src/providers/presets.test.ts))
- **[commands/index.test.ts]** Loader loading/shadowing/frontmatter/validation + expandCommand/substitution/findCommand edge cases. ([src/commands/index.test.ts](src/commands/index.test.ts))
- **[tools/filter.test.ts]** Allowlist-only, denylist-only, combined allow+deny passes. ([src/tools/filter.test.ts](src/tools/filter.test.ts))
- **[cli.completer.test.ts]** Extra slash commands in completion set, partial match, builtin collision shadowing. ([src/cli.completer.test.ts](src/cli.completer.test.ts))
- **[context-editing.test.ts]** Threshold behavior, the retained-three and fresh-batch windows, `messages` non-mutation, and preserved tool-call pairing/order. ([src/compaction/context-editing.test.ts](src/compaction/context-editing.test.ts))
- **[hooks/runner.test.ts]** The process-group `SIGKILL` on hook timeout is now asserted through an injected `killFn`, rather than by observing a backgrounded subshell's side effect — the previous form depended on real signal delivery and flaked under vitest's fork pool on macOS. ([src/hooks/runner.test.ts](src/hooks/runner.test.ts))
- **[tools/jobs.test.ts]** A killed job's exit code accepts both `null` (signal termination) and `-1` (the child `error` handler, which also fires when a kill itself fails). ([src/tools/jobs.test.ts](src/tools/jobs.test.ts))

## [0.4.1] — 2026-08-20

The release that stops a bad search from taking the session with it. A tool
call the agent never answered used to poison the conversation permanently —
every later message in that session failed, and so did every resume of it.
Searching a large directory is also no longer a coin flip: generated and
vendored directories are skipped, and when a search does run out of time it
says so instead of reporting something that looks like a permission error.

3 commits since 0.4.0.

### Fixed

- **An unanswered tool call no longer breaks the session.** When a tool batch
  stopped early — `attempt_completion`, loop detection, the five-failure
  escalation, or an unexpected fault — the remaining calls were left with no
  result. Providers reject that conversation outright, so the damage outlived
  the turn: every later request in the session, and every resume of it, failed
  the same way. Unanswered calls are now backfilled before the request is
  built, and loaded history is repaired on the way in.
- **A search killed by its own timeout now says so.** The 30s cap surfaced as
  a bare `Command failed: grep -rn <pattern> <dir>` — no exit code, no stderr —
  which reads like a malformed command or a denied path. It now names the
  timeout and the directory, and returns whatever grep printed before it was
  killed instead of discarding those matches.

### Changed

- **`search` skips generated and vendored directories** (`node_modules`,
  `target`, `dist`, `build`, `vendor`, `.git`, caches and friends) and binary
  files. Searching a 9.1G tree of 91 repositories went from over 120s — past
  the timeout, returning nothing usable — to 12.7s. `bin` is deliberately
  still searched: it is build output for .NET but hand-written scripts almost
  everywhere else.

## [0.4.0] — 2026-08-20

The release that makes permission grants stick. Approving a tool "always" now
survives a restart instead of being quietly discarded, and approvals for reads
outside the workspace finally take effect the first time you give them. When
you approve an external read, you also get to say how far the grant reaches:
just that folder, or the whole tree beneath it.

2 commits since 0.3.2.

### Added

- **Scope choice on external read approvals.** Session and always approvals for
  reads outside the workspace now ask a second question — "This folder only"
  (`dir/*`) versus "Include subfolders" (`dir/**`) — so a grant matches the
  breadth you actually intend. Write tools and builtin-guarded prompts never
  offer the broadening option.

### Fixed

- **Persisted "always" approvals no longer invalidate the project settings
  trust hash.** Writing a grant used to leave the settings file looking
  tampered-with, so the next launch could strip every stored grant.
- **External `search` and `glob` approvals now take effect.** The dynamic
  out-of-workspace guard gained the same approval escape hatch as the write
  boundary, so approved directories stop re-prompting forever. Static guarded
  and destructive rules remain unapprovable.
- Search and glob approvals now store the real directory (`search`'s `dir`,
  `glob`'s `cwd`) instead of an empty-pattern junk rule.
- Approving a prompt whose matched rule was a user-authored ask rule now stores
  a real allow rule instead of re-recording the ask rule as a no-op.

## [0.3.2] — 2026-08-20

The release that makes an interrupted coding session resumable without losing
its context. It also extends `workspace-write` to explicitly trusted sibling
repositories, so a project can safely work across a deliberate multi-root set.

2 commits since 0.3.1.

### Added

- **`--add-dir <path>`** — repeatable startup flag for explicitly trusted
  writable directories. These roots merge with global `sandbox.writeRoots` and
  apply consistently to the permission engine, macOS Seatbelt, foreground
  Bash, background jobs, and headless runs. Sandboxed commands may use an
  added root as their cwd; direct file tools still cannot access `.git`.
- The prompt's Git environment context now names dirty paths and distinguishes
  files already dirty at startup from files changed during the current session.

### Fixed

- **Interrupted turns now persist their completed transcript.** After Esc,
  `/continue` retains the user's request plus completed tool calls and results,
  rather than inferring work only from a dirty tree. Partial stream text is
  never persisted.
- External file-write approvals now create exact-path rules for session and
  always approvals; another external path still asks. Search and glob guards
  remain absolute.

## [0.3.1] — 2026-08-18

The release that **simplifies modes and unifies the write boundary**. New
sessions no longer land in Code: they start in a read-only *General* chat mode
on a cheap model, with implementation work one explicit `/mode code` away. The
specialist modes (architect/ask/debug/orchestrator) are hidden from the picker
but stay reachable by slug, and Code absorbs the `workflow` group so delegation
is an automatic capability. Under `workspace-write`, the write boundary is now
a single shared set — Seatbelt, the permission engine, and the file tools all
resolve the same realpath'd write roots, and an out-of-workspace file write
becomes a guarded ask instead of a hard deny.

1 commit since 0.3.0.

### Added

- **`general` mode, the new default.** A session with no explicit `--mode` or
  `/mode` starts in read-only chat on `deepseek/deepseek-v4-flash` with
  `reasoningEffort: low`. A resumed session's last mode wins over the default;
  an explicit `--mode` wins over both. Headless (`-x`) runs resolve the same
  default instead of falling back to the every-tool registry.
- **`sandbox.writeRoots`** (global-only): extra directories writable under
  `workspace-write`, beyond the workspace root and the temp/npm carve-outs.
  Resolved once into a shared write-set (`resolveWriteRoots`) that the Seatbelt
  profile, permission engine, and profile evaluator all consult — a path one
  layer allows for a write, the others do too. The key is read from the user's
  global `settings.json` only: a project value is ignored with a warning
  (regardless of trust state), and a global grant survives the untrusted-
  project strip.
- **Mode `model`, `reasoningEffort`, and `hidden` fields.** A mode can declare
  its own model/effort defaults, applied when the user hasn't chosen
  explicitly, and hide itself from the picker and `/modes` listing while
  remaining loadable by slug.
- **`provider/model` references in `--model` and `settings.model`** (e.g.
  `--model anthropic/claude-…`); a bare name stays relative to the
  configured/detected provider.
- **`reasoningEffort: "low"`** is now accepted alongside `"high"`/`"max"`.
- **Timing diagnostics** in the debug log: a `prompt_assembly` row per turn and
  a `request` row per provider call (total, time-to-first-event,
  time-to-first-text, cache reads).

### Changed

- The default mode is now **`general`** (read-only chat) instead of `code`;
  implementation work starts with `/mode code` or `--mode code`.
- **Code mode gains the `workflow` group** — direct `new_task` delegation
  without switching to the orchestrator.
- **architect, ask, debug, and orchestrator are hidden** from the mode picker
  and `/modes` listing; they remain usable as compatibility aliases by slug.
- **Out-of-workspace file writes become a guarded ask** under
  `workspace-write` instead of a hard deny; in-set writes resolve silently. The
  boundary follows the profile level, not `sandbox.enabled`.
- Session meta now records whether the model and effort were explicit
  (`modelExplicit`, `effortExplicit`), so a resumed session restores the origin
  of a choice instead of collapsing it into a mode default.
- `/mode` help text and completion list the current mode set (`general`,
  `code`).

### Fixed

- Headless runs now apply the active mode's tool gating (default `general`,
  read-only) instead of every tool registered; an unknown `--mode` still exits
  1 with the "unknown mode" message.

## [0.3.0] — 2026-08-17

The release where **project-supplied content became untrusted by default**. Before
this, cloning a repo and running heirloom inside it could execute attacker-chosen
code before you typed anything. Everything a repo can declare — hooks, skills,
settings, agent definitions — now passes a trust gate first.

64 commits since 0.2.1.

### Security

- **Fixed arbitrary code execution via project `settings.json`.** A cloned repo's
  `.heirloom/settings.json` was deep-merged with no trust check, and several keys
  execute at startup: `statusline.providers[].command` reached
  `execFile($SHELL, ["-c", …])`, `mcpServers[].command` was spawned, `notify` was
  spawned. Execution-capable keys are now gated behind trust-on-first-use.
- **Fixed a prototype-pollution bypass of that gate.** Detection read raw key names,
  so a payload nested under a top-level `"__proto__"` key was invisible to the gate
  while still resolving through the merged object — no prompt, no strip, full
  execution. Parsed JSON is now sanitized recursively, and detection derives from
  resolved values rather than key names.
- **Fixed privilege escalation via project permission config.** A repo could set
  `permissionProfile: { level: "unrestricted" }`, `sandbox: { enabled: false }`, and
  `permissions.defaultMode: "allowAll"`. These are now gated; when stripped they fall
  back to the *strictest* state, not the absent-default (which was the least
  restrictive, and exactly what an attacker would ask for).
- **Fixed search-traffic redirect.** `webSearch.searxngUrl` let a project control the
  host every `web_search` query was sent to. Gated; the tool now reads the effective
  post-strip config instead of re-reading the raw file per call.
- **Fixed truncated trust hashes.** Stored hashes were 16 chars while comparison used
  the full 64-char digest, so every previously-trusted skill reported as `changed` —
  a false tamper signal. Legacy hashes migrate in place on first check.
- Added macOS Seatbelt sandbox enforcement with cwd containment and workspace-write
  carve-outs for temp dirs and the npm cache.
- Added skill and MCP tool-definition trust prompts; SearXNG secret handling fixes;
  registry-host pre-commit hook and CI guard.
- **Fixed command injection in the `search` tool.** `search` built a shell string by
  interpolating the model-supplied pattern into `grep -rn "<pattern>" "<dir>"`, so a
  pattern containing `$(...)` executed. It sits in the `read` tool group — the
  low-friction tier users are most likely to auto-allow — and the model is steerable by
  repo content, web results, and MCP output, so reaching it did not require a hostile
  user. Now uses an argv array with no shell.
- **Fixed unsanitized tool and MCP output reaching the terminal.** MCP server responses,
  `search` results, `read_file` contents, and web-search titles/snippets were returned
  without stripping control characters, so a hostile file or server could emit OSC 52
  (clipboard write) or cursor-repositioning sequences — the latter matters most
  immediately before a permission prompt.
- **Fixed unconstrained directory arguments in `search` and `glob`.** Both took a
  directory from the model with no validation and carried an unconditional builtin
  allow, so a search of `~/.ssh` returned matching lines from private keys with no
  prompt — while `read_file` on the same file has always asked. The underlying cause
  was that neither argument was ever extracted into the permission subject, so no path
  rule could match them even in principle. Both now participate in rule matching, carry
  the same secret-path guards `read_file` has, and prompt when the directory resolves
  (via realpath, so symlinks cannot escape) outside the workspace.
- Fixed a test-isolation leak that wrote ~1786 junk entries into the real trust store.

### Added

- **Folder-level trust** — one prompt bulk-approves everything present in a tree.
  Deliberately a fast path, not a blanket grant: content changes and newly-added
  artifacts still re-prompt, preserving tamper detection.
- **Async sub-agents** — background tasks outlive the spawning turn, with live
  provider/model, a per-turn ask bridge, and interrupt propagation.
- **Agent definitions** in `.heirloom/agents/*.md`, with model overrides.
- **`update_todo_list`** planning tool with a live checklist panel; snapshots persist
  and restore on session resume.
- **`switch_mode` and `attempt_completion`** meta tools, never permission-prompted.
- **SearXNG search backend** with inline content enrichment.
- **PermissionProfile** — schema, validation, evaluation layer, always-denied `.git/`,
  network specificity.
- `@file` mentions in the prompt; `/mode` in the slash picker; Ctrl+O mode picker.
- `CLAUDE.md` (user + repo) read into the instructions chain.
- Inline Claude-Code-style sub-agent execution display in the transcript.

### Changed

- **`strictMcpConfig` now defaults to `true`.** MCP server commands are allowlisted by
  basename unless explicitly disabled. An unusual MCP command now needs
  `strictMcpConfig: false`.
- **A project `.heirloom/settings.json` setting an execution-capable key now prompts**
  on first use instead of applying silently.
- **The cost estimate is hidden** unless `showCost` is set.
- Context window is derived from the model, and request overhead is counted in the
  status-bar meter and `/context`.
- All config stores route through `HEIRLOOM_HOME`.
- Sub-agent todo lists are isolated from the parent's.

### Fixed

- MCP stdio tools now actually reach the model and the permission engine; JSON-RPC
  errors from stdio servers no longer crash the session.
- Transient network errors are handled instead of crashing.
- The skill-load banner no longer garbles stdin at startup.
- `switch_mode` and `attempt_completion` no longer trigger permission prompts.
- Status bar and hint bar legibility; mode and posture render as independent segments.
- `web_search` surfaces feed-format breaks instead of reporting "no results".

### Known limitations

- Two controls in this release needed follow-up fixes before they held: the settings
  gate was bypassable on its first attempt, and `search` shipped with a shell-string
  sink no one had classified as dangerous. Both are fixed here, but treat "project
  config is no longer trusted by default" as the accurate claim — not "safe to run in
  untrusted repos".

The MCP response path and tool-level input handling were audited before this tag; the
issues found are listed above. A sweep of all twelve subprocess spawn sites found no
further injection sinks.

## [0.2.1] — 2026-08-10

Earlier releases predate this changelog. See the git history for
`v0.1.0..v0.2.1`.

[Unreleased]: https://github.com/amenski/nib/compare/v0.5.1...HEAD
[0.5.1]: https://github.com/amenski/nib/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/amenski/nib/compare/v0.4.2...v0.5.0
[0.4.2]: https://github.com/amenski/nib/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/amenski/nib/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/amenski/nib/compare/v0.3.2...v0.4.0
[0.3.2]: https://github.com/amenski/nib/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/amenski/nib/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/amenski/nib/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/amenski/nib/releases/tag/v0.2.1
