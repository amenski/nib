# Heirloom — Follow-ups

> **ARCHIVED - historical record (2026-08-13).** Describes a superseded design or
> a completed task brief. Nothing here describes current behavior. The live
> documentation set is indexed in [../README.md](../README.md).
> Why: Bug-investigation tracker, resolved; the one open item was folded into root todo.md.

Open items parked for later. Captured 2026-08-04, revised 2026-08-06.

## STILL BROKEN

### 0. The "Working…" freeze — CAUSE FOUND 2026-08-06 (profile evidence), fix landed

RESOLVED-PENDING-CONFIRMATION. The first real capture (HEIRLOOM_PROFILE=1, user session
in IntelliJ) recorded one 580ms stall; the profile's longest same-stack run named it with
zero ambiguity: `execSync` → `git` → `save` — the CHECKPOINT manager's shadow-git commit
blocking the main thread 475ms (plus sibling sync spawns for status/add/rev-parse making
up the rest). Checkpoints fire mid-turn around file edits, which is exactly the reported
shape: dots freeze, input stalls, buffered keys replay. Same disease the git-status poll
had before 08-04 — in the organ that fix never covered. Converted to async execFile
(argv array — which also closed a shell-injection hole: commit messages derive from raw
prompt text and the old quoting missed `$(…)`). Guarded by checkpoints/nonblocking.test.ts,
same style as ui/git-poll-nonblocking.test.ts. Keep this item open until the user reports
a stall-free long session; the watchdog remains available via HEIRLOOM_PROFILE=1.

Original investigation record follows.

Three separate blocking/render bugs were found and fixed this session (spinner re-render,
git poll, JSON.parse instrumentation). All were real. **None of them resolved the reported
freeze** — it still happens: the UI stalls mid-chat, won't accept input, then catches up.

Do not assume the cause is known. What has been ruled OUT by measurement:
- `estimateTokens` (the `436b5d5` fix is intact and working)
- `mergeTableLines` — 0.17ms even at 12k lines
- spinner-driven re-renders — now confined to `<Spinner>` (13 sibling renders/sec → ≤3)
- the git-status poll — was 100-670ms every 30s, but the freeze has no 30s rhythm

Next step is measurement, not more code reading: attach a CPU profiler + event-loop
watchdog to a REAL session (`node:inspector` `Session` + `Profiler.start()`, a 20ms timer
measuring its own lateness, and on a >150ms stall dump the hottest self-time frames). That
names the blocking frame directly. Three code-reading diagnoses in a row were wrong.

Unmeasured suspects: stdout backpressure on large frames, the still-absent `<Static>`, or
something outside the UI entirely.

Addressed since (`76a1412`), so no longer a suspect: the full-transcript Ink render on
message appends. `OutputArea` kept one live element per committed line, so per-frame layout
cost scaled with session length. Now capped via `liveLineBudget` (400) — lines older than
that fold into a single element rather than being dropped. Measured 310ms → 118ms to render
4k lines. NOTE: the `maxLines` prop this doc previously recommended is the wrong tool — it
slices to the newest N and discards the rest, and with `<Static>` absent `outputLines` is
the only copy of the transcript, so it would lose scrollback permanently.

**2026-08-06 update:** the transcript now flushes through Ink's `<Static>` (the
`liveLineBudget`/`foldOldLines` mechanism above is gone — superseded, not just extended).
Committed lines write ONCE into native terminal scrollback and are never repainted; the live
region left standing is ~6 rows (streaming tail, composer, status, hints). This removes the
full-transcript-repaint class of suspects entirely, including `liveLineBudget`'s own folded
block (still one live element, still re-laid-out every frame at large session sizes) — that
concern no longer applies to anything Ink re-renders per frame, since nothing but the tail
does. Awaiting live IntelliJ confirmation before closing §0.

**2026-08-06 update (2):** post-Static, the user still sees the working-indicator dots
freeze. That rules out the render-cost class entirely (it's now deleted — nothing left for
it to be) and points at a synchronous main-thread block: something holds the event loop for
long enough that even the 80ms indicator tick can't run. The prescribed instrument
(measurement, not another code-reading guess) now exists: `src/diagnostics/stall-watchdog.ts`
runs a 20ms self-checking timer and, where available, a `node:inspector` CPU profiler at
1000Hz sampling.

Usage: `HEIRLOOM_PROFILE=1 heirloom`, reproduce a stall, then read the one-line stderr
summary printed at exit (`[profile] N stalls ≥150ms (worst NNNms) — <profilePath>`). Open
the `.cpuprofile` in Chrome DevTools (Performance panel → Load profile) and sort by self
time to name the blocking frame(s) directly — no more guessing between suspects.

## Needs your eyes (cannot be verified without a TTY)

2026-08-06, post-Static migration: user confirms flicker in IntelliJ (JediTerm) is now
"very minimal" — down from unusable. Residual shimmer is the ~6-row live region, which
cannot paint atomically if the terminal lacks DEC 2026 (probe result still unreported).
The FREEZE (§0: input stalls, catch-up) is a distinct symptom — keep §0 open until a
long session passes without one.

Nothing else outstanding. All live-terminal checks are confirmed — see Closed.

## Deferred features

### 2. User-defined providers — NOT BUILDING (revisit only on a real need)
Decided 2026-08-05. Pointing Heirloom at a provider outside the five built-in presets would
need a `providers` field in the config schema (`src/config/loader.ts`), a validator, and a
`setConfigProviders(...)` call — roughly 150 lines of config surface for a capability nobody
has asked for. Speculative configurability that no one exercises rots: untested against a
real third-party endpoint, it would most likely be broken by the time someone tried it.

The dead `setConfigProviders` import in `src/cli.tsx` was removed so the code stops implying
the feature exists. The function itself stays in `presets.ts` — it is the entry point if
this is ever built, and the plan above is the whole design. (`getProviderModels` is NOT dead;
it is called at `cli.tsx:641`.)

---

## Closed 2026-08-06

- **`/skills`, `/effort` and `/model` confirmed in a live terminal.** All three are in
  active use. The check was worth running: `/skills` rendered each entry as a name plus
  its FULL wrapped description, and skill descriptions are paragraphs (median 327 chars),
  so each entry cost 7-11 rows — about two skills visible on a 24-row terminal. Fixed in
  `bec3370` (one row per entry, aligned columns, 198 rows -> 22). `/effort` and `/model`
  behaved correctly, including a provider switch surviving `/resume`.
  This closes the last item that could only be verified by a human at a TTY.

- **Corrected a false mechanism in `7cec1b0`'s commit message.** That commit attributes the
  deleted ASCII banner's shredded rendering in IntelliJ to quadrant-glyph width drift, but
  the banner contained no quadrant glyphs, and its actual glyphs (ASCII, block-full,
  block-half, box-drawing) measured identical advance widths in Figma. Comments in
  `WelcomeScreen.tsx` and its test corrected in this commit; git history stands as-is.
  Probable real cause is renderer-side — JediTerm likely custom-paints those glyph ranges
  instead of using font glyphs — unverified.

## Closed 2026-08-05

- **Effort coverage beyond DeepSeek — closed, not deferred.** This was a finished
  investigation filed as if it were pending work. Effort caps are declared per-model on
  `deepseek-flash` / `deepseek-v4-pro` (verified low/high/max) and Groq's two
  `openai/gpt-oss-*`. Deliberately NOT on OpenAI: its chat-completions API rejects
  `reasoning_effort` when function tools are present ("Function tools with reasoning_effort
  are not supported for gpt-5.6-sol in /v1/chat/completions") and Heirloom always sends
  tools. No code change can fix that — it needs a vendor behaviour change, and the failure
  mode is a hard 400, so per-provider flags are unsafe. Reopen only with evidence from a
  live call proving the API now accepts it.

- **Preset pricing values — closed as accepted risk.** Verified the blast radius rather than
  re-checking the numbers: `pricing` feeds exactly one consumer, the status-bar cost string
  at `cli.tsx:359`. `contextWindow` — which drives compaction and would actually matter — is
  a separate field. So a stale price is a cosmetic error in one display, which does not
  justify a recurring chore against price sheets that drift anyway. The estimates are now
  documented as approximate at the type definition (`providers/types.ts`), where someone
  reading the field will see it. Revisit only if cost display becomes load-bearing.

- **Stale model IDs in docs — closed.** Nine `docs/*.md` files referenced retired IDs
  (`gpt-4o`, `deepseek-chat`, `llama-4-scout`, bare `claude-sonnet-4`). Rather than rewrite
  them — they are dated records, and editing the IDs would falsify what was true when they
  were written — each got a banner pointing at `src/providers/models.json` as authoritative.
  Handoffs are marked "historical snapshot"; the four living specs note their guidance is
  current and only the examples are stale. Found while doing this: `mode-spec.md` says
  `anthropic/claude-sonnet-4-6`, which is NOT retired — the separator is just wrong (real ID
  is `claude-sonnet-4.6`), so its banner names the typo instead. `95ec2c3`.

- **Paste arrived line by line — confirmed fixed in a live terminal.** `enableBracketedPaste()`
  existed but was never called, so the terminal sent a paste as bare bytes with no
  `\x1b[200~` framing; every embedded newline reached the handler as a plain Enter and
  submitted that line on its own. The parser and the `PromptInput` paste handler were
  already correct. Enabled in `attachInputWire` (the single process-lifetime attach point),
  restored on exit/SIGINT/SIGTERM. Two display fixes rode along: a large paste collapses in
  the prompt to `[pasted N chars]` (display only — spans tracked in `core/paste-spans.ts`,
  the buffer keeps the real text so submit/history/undo are untouched), and the transcript
  echo no longer flattens newlines with `.replace(/\n/g, " ")` (`core/echo-format.ts`; this
  was a pre-existing bug affecting Shift+Enter too, visible only once multi-line input could
  reach the buffer). `c8f0eb8`.
  Live-terminal check done 2026-08-05: paste lands as one message. Note that no test can
  cover this part — synthetic `\x1b[200~` bytes prove parsing, not that the terminal
  negotiates the mode.

## Closed 2026-08-04 (later session)

- **↑/↓ now recalls past prompts.** The machinery already existed —
  `useHistoryNavigation`, the arrow-key bindings, Ctrl+P/Ctrl+N — but `App.tsx` rendered
  `promptHistory={[]}`, a hardcoded empty array, so `navigateHistory` returned immediately
  and the arrows did nothing. App now keeps the submitted prompts in state (recorded in
  `submitFromInput`, so queued and slash submissions count too, with blank/immediate-dup
  filtering) and seeds it from a resumed session's user turns via
  `src/ui/core/prompt-history.ts` — which filters out app-injected `user` messages
  (compaction summaries, force-loaded skill bodies, error-reflection nudges) so Up never
  surfaces something the user didn't type. Covered by `prompt-history.test.ts` and
  `PromptInput.history.test.tsx`.
  Note for future UI tests: `useTerminalInput` holds ONE module-level stdin listener, so a
  component left mounted from a previous test keeps the wire and the next render's keys go
  nowhere — unmount and call `__resetInputWireForTests()` between tests.
- **`/model` is now an opencode-style searchable popup.** Type to fuzzy-filter across
  provider and model name (subsequence matching — "dsp" finds `deepseek-v4-pro`), results
  grouped under provider headings, context window shown per model, and providers with no
  resolvable API key dimmed and marked "no key" (via `getConfiguredProviders()` in
  `presets.ts` — returns BOOLEANS ONLY, the UI never handles a secret). Arrow keys step
  over group headings; Esc clears the search first, then closes. Matching/grouping/
  navigation logic is pure and unit-tested in `src/ui/core/model-picker.ts`.
  Two bugs found and fixed while building it: (1) the input handler gated on
  `input.length === 1`, which silently dropped fast typing and pastes that arrive as one
  multi-char chunk; (2) cursor anchoring in a `useEffect` keyed on `rows` (a fresh array
  every render) fought the arrow keys — now derived during render.

- **"Working…" freeze — THE actual cause: the spinner re-rendered the whole transcript.**
  `spinnerFrame` and `turnElapsed` were `useState` on `App`, so their 80ms and 1s ticks
  re-rendered App's entire subtree — including `OutputArea` and every committed line —
  12+ times a second. `OutputArea` is never passed `maxLines` (defaults to `0` = no cap),
  so every line stays a live Ink element and Ink re-lays-out all of them just to find
  nothing changed. Measured per spinner tick: 4ms @200 lines, 20ms @2k, 62ms @4k,
  **197ms @8k** — past the 80ms budget the ticks queue faster than they drain, the UI
  locks, and buffered keystrokes replay on catch-up ("freezes, won't take input, then
  catches up"). Explains why it hit "arbitrary chats": it scales with accumulated output,
  not with turns. Fix: both timers moved into `<Spinner>` as local state driven by
  `active`, so a tick re-renders only the spinner. Guarded by `src/ui/Spinner.test.tsx`,
  verified load-bearing (the old parent-owned-state shape produces 13 sibling re-renders
  per second and fails the guard). Follow-ups if it ever regresses: pass `maxLines` to cap
  the live region, and/or restore Ink's `<Static>` (removed for conflicting with the banner).
- **"Working…" freeze — a second, real but SMALLER sink (fixed first, kept).** Not a regression of the
  `estimateTokens` fix (`436b5d5`), which is intact. The git-status poll in `src/ui/App.tsx`
  ran three **`execSync`** git commands (`rev-parse`, `status --porcelain`, `rev-list
  ...@{upstream}`) on a 30s `setInterval`. execSync blocks the main thread for as long as
  git runs: measured **100–670ms** across the user's repos (kontashop = 668ms), scaling with
  worktree size — and `@{upstream}` can touch the network. Simulating the real 80ms spinner
  timer, the worst gap was **606ms before → 81ms after**. Fixed by switching to promisified
  `exec` with `Promise.all` for the two independent reads. Guarded by
  `src/ui/git-poll-nonblocking.test.ts`, verified to fail if `execSync` is reintroduced.
  (Checked and cleared: `prompt.ts`'s git `execSync` is inside the memoized stable preamble,
  so it runs once per session, not per turn.)

- **`/effort` was entirely dead** — no preset declared an `effort` capability, so the picker
  never rendered; and the value it would have sent went nowhere, because `reasoningEffort`
  was passed as a **top-level `streamText` option**, which AI SDK v7 discards silently
  (`prepareLanguageModelCallOptions` keeps a fixed whitelist). Same for the
  `body: { thinking }` hack, which an `as any` had hidden. Now sends the SDK's standardized
  `reasoning` option, maps DeepSeek's `max` → `xhigh`, and omits `temperature` when reasoning
  is active.
- **`/skill <name>` never reached the model** — it only printed to local scrollback. Now
  injects a deduped `user` message and persists it via `appendMessage` (mandatory: pre-turn
  history falls outside the `newMessages` persistence window).
- **`/model` didn't persist** — now calls `appendState`, validates the target provider before
  committing, rolls back on failure, and resets the memoized compactor. Resume now *consumes*
  the persisted provider/model (it was replayed into meta but every caller discarded it);
  an explicit `--model` / settings.json choice still wins.
- **Credential leak across providers** — the startup `env.API_KEY` / `env.BASE_URL` were
  passed as highest-priority to *every* `createProvider` call, so switching providers would
  have sent one provider's key to another's endpoint. Now scoped to the startup provider.
  This was a prerequisite for the cross-provider picker.
- **Model picker couldn't change provider** — now lists all `provider/model` pairs via the
  previously-unused `ctx.getModelEntries()`.
- **Three presets pointed at dead model IDs** — `llama-4-scout` never existed on Groq,
  `anthropic/claude-sonnet-4` was retired 2026-06-15, `gpt-4o` was stale.
- **`thinkingEnabled` was read and dropped** — now threaded through to the provider boundary.
- **JSON.parse sink** (old #1) — added an observation-only size diagnostic before the parse
  in `src/agent.ts`. Deliberately does **not** cap or reject: the `_raw` fallback is inert
  (`agent.test.ts`), so capping would turn slow-but-correct large writes into silent failures.
- **Folder-scope offer for writes** (old #2) — extended to the six real write/edit tools with
  distinct, risk-colored prompt copy. Policy: read approvals do **not** unlock a recursive
  write grant; a write offer needs two prior *write* approvals in that folder.
- **No pixel-level TUI tests** (old #3) — added `ink-testing-library` and widened the vitest
  glob to `*.test.{ts,tsx}` (it was `*.test.ts`, so no `.tsx` test would ever have run).
  `SkillList` and `ScopeChoicePrompt` now have render tests; the `SkillList` one was verified
  to fail against the pre-`594952c` wall-of-text version.
- **Dead code removed** — `ui/ModelSelector.tsx` (the `ModelEntry` type moved to
  `ui/types.ts`), `components/SkillsDropdown/`, and `SkillLoader.match()` + the `triggers`
  frontmatter field (keyword matching that `skill-spec.md` explicitly argues against).
- **Entrypoint guard bug, caught in review** — a `main()` guard comparing `import.meta.url` to
  `process.argv[1]` made the installed binary silently do nothing when invoked through the
  `npm i -g` symlink (`import.meta.url` is resolved, `argv[1]` is not). Now compares realpaths.
