# Troubleshooting & FAQ

**Status:** current · verified 2026-08-13 · sourced from code, not anecdotes

## Setup & keys

- **`nib auth`** writes `~/.nib/credentials.yaml` (mode `0600`,
  auto-chmoded if looser — `src/config/credentials.ts`). Masked prompt on a
  TTY, `--api-key`/`-k` for scripts, piped stdin for CI.
- **"No API keys found" after upgrading from Heirloom** — Nib intentionally
  does not read `~/.heirloom`. Run `nib auth` again, or copy the old
  `credentials.yaml` to `~/.nib/credentials.yaml` and keep mode `0600`.
  Keep the old state directory as the backup; do not symlink it to `~/.nib`
  because trust records are keyed by real paths. See the v0.5.0 changelog
  before migrating settings, sessions, or trust stores.
- **Env-var keys**: `DEEPSEEK_API_KEY`, `OPENAI_API_KEY`,
  `OPENROUTER_API_KEY`, `GROQ_API_KEY`. Ollama needs no key (local).
- **"No provider key resolvable"** → exit 1. `nib doctor` (or
  `/doctor` in the TUI) shows the configured provider/model and where keys
  are coming from.
- **Keys in `settings.json` `env.API_KEY`** work but are discouraged —
  settings.json is meant to be shareable (config-spec.md §8).
- **`NIB_HOME`** relocates the whole install — config, credentials,
  sessions, checkpoints, and memory all honor it (config-spec.md §17).

## Terminal requirements

- The interactive TUI requires a TTY: without one you get `nib
  requires an interactive terminal (TTY)...` and exit 1.
- `-p/--print` headless mode needs no TTY; stdout stays pipeable, errors
  go to stderr (cli-spec.md §3).

## Permissions behavior

- Default posture is `askAll`; **Shift+Tab** cycles `normal →
  autoApprove → plan`. Plan mode is read-only and requires a
  `<proposed_plan>` block before implementing.
- **"I approved a command but it still asked"** — approvals are rule- and
  scope-specific: a session approval covers the exact subject text; a
  folder-scope grant covers the folder only. Guarded-tier matches (secret
  paths, network egress, `web_search`) and unresolved bash segments are
  never bypassed by posture — deliberate (permission-spec.md §7, §9).
- **Headless runs fail closed**: any call that would ask is denied with one
  stderr line, `permission denied (headless): <tool> <subject>`. Add
  explicit `allow` rules for scripted use.
- `/permissions` shows this session's decision history.

## Permission profile & sandbox (when enabled)

- **Where's my profile level?** — the PermissionProfile level is NOT on
  the status bar (static config, decided 2026-08-14); it's visible in
  `nib doctor` and `/permissions`.
- **Edits stopped prompting** — under `workspace-write`, edits inside the
  workspace auto-allow (the M.1 overlay condition); `strict-sandbox` never
  auto-allows edits. Deliberate, not a bug (permission-profile.md §10(d)).
- **Bash writes fail outside the workspace** — with `sandbox.enabled`,
  bash children run under a macOS Seatbelt profile; writes anywhere
  outside the workspace root fail at the kernel and surface as
  `Exit code: 1` (not a tool error). A `cwd` outside the workspace is
  rejected before spawn: `Working directory escapes the sandbox workspace
  root: …`.
- **`npm install` / tooling fails with EPERM** — the sandbox also denies
  writes to `~/.npm`, `~/.cache`, `/tmp`. Adjust the carve-outs or set
  `sandbox.enabled: false` (policy-only) — see permission-profile.md §8.
- **`web_fetch` returns "Permission denied"** — under a profile with
  `network.deny: ["*"]`, only allowlisted hosts are reachable; add hosts
  to `network.allow`. `web_search` needs `www.bing.com` allowlisted.
- Revert: `sandbox.enabled: false` keeps the policy layer; removing
  `permissionProfile` restores pre-profile behavior entirely.

## Sessions

- **A session shows `failed`** — the JSONL file has a torn final line (a
  write was cut off). Resume picks the last good state; the file is
  append-only so nothing earlier is lost (session-spec.md).
- Session IDs are `YYYY-MM-DDThhmm-4hex`. Resume with `-r <id>`, pick with
  `-r` alone, or continue the latest with `-c`; `/sessions` lists with
  rename (Ctrl+R) and delete (Del).
- **Context fills up** — auto-compaction fires at `0.7 × contextWindow`
  (`compaction.threshold`); `/compact` forces one; the resume-time offer
  summarizes before replay. `compaction.auto: false` disables only the
  automatic path.

## Web search & fetch

- **Rate limits (403/429)** come back as *content* ("try again shortly"),
  never errors — and are never auto-retried.
- **`web_search: Bing returned an unrecognized response format`** — the
  keyless RSS feed changed shape; it's a tool failure, not an empty
  result. There is no fallback provider by design (web-search-spec.md
  §7).
- **`web_fetch` refuses the URL** — https-only, with an SSRF guard
  rejecting loopback/private/link-local addresses on every redirect hop.
  Results are untrusted input, always.
- `allowed_domains`/`blocked_domains` filter `web_search` results
  (snake_case params, mutually exclusive).

## Performance / input stall

- **Input stutters while the agent streams** — the known freeze taxonomy
  lives in [input-stall-diagnosis.md](./input-stall-diagnosis.md)
  (resolved; kept as reference). Watchdog: `NIB_PROFILE=1`.
- **Slow links** — `refresh: "slow"` in settings (or `NIB_REFRESH=
  slow`) lowers TUI repaint cadence (config-spec.md §4).

## MCP

- **A server failed to spawn** — `/mcp` shows per-server status. With
  `strictMcpConfig: true`, only allowlisted launcher commands may spawn
  (`npx, node, python3, python, uvx, uv, bun, deno, go, java`);
  non-allowlisted servers are marked failed, never spawned.

## Model behavior

- **Model IDs are catalog-relative**: `--model` takes `provider/model`,
  split on the first slash (`openrouter/anthropic/claude-sonnet-4.6`).
  The bundled catalog (`src/providers/models.json`) ships sandbox IDs —
  it is authoritative for what this repo accepts (provider-spec.md §4).
- **"Unknown provider/model"** — `nib doctor` shows what's
  configured; `~/.nib/models.json` deep-merges over the bundled
  catalog for custom entries.
- `/effort` values come from each model's `effort.values` in the catalog.

## Contributor/test traps

From `src/ui/test-helpers.ts` (UI tests):

- **Never assert raw ANSI** — `ink-testing-library` re-encodes escapes;
  assert on the visible shape via `stripAnsi` (see
  `ink-reencodes-ansi` SecondBrain memory note).
- **No repaint under timers** — drive frames with `rerender()`/stdin plus
  flush waits; don't `setTimeout`-poll a frame.
- **Run `CI=true npm test` locally** — ANSI gating is CI-conditional.
- **`<Static>` frame semantics** — containment assertions are fine, but a
  committed line never repaints, so "split across frames" assertions are
  not.
- **Hook-spawn tests** — an instant-exit hook command closes its stdin
  read end before the payload write lands → EPIPE; with no listener on
  `child.stdin` that crashes the worker (uncaughtException). Hold the read
  end open with `; cat > /dev/null` in the fixture command — structurally
  EPIPE-proof, no sleeps. (The production side swallows EPIPE
  deliberately: the payload is fire-and-forget, hooks-spec.md §4.)

## FAQ

- **Does it phone home?** No telemetry. The npm update checker is inert while
  the package remains private (config-spec.md §15; update-check.md).
- **Background commands?** `run_bash_background` → `check_job`/`kill_job`
  (max 10 jobs, default 5-min timeout — tool-spec.md §5).
- **Undo?** Interactive Shadow-Git checkpoints: `/undo`, saved at each turn
  start and before edits; restore rewinds files and conversation
  (session-spec.md §8).
- **Images?** `Ctrl+V` to paste one, or `@path/shot.png` to attach a file.
  The model can also call `view_image` with an https URL or a local path.
  Needs a model that accepts images (PNG/JPEG/GIF/WebP, ≤5 MB).
- **Skills not showing?** Check `enabledSkills` in settings, search paths
  (skill-spec.md §2), and trust status — untrusted skills are skipped in
  headless runs.
