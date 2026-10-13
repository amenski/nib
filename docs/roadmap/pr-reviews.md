# Roadmap — deepcode-cli PR reviews

**Status:** split out of [improvement-roadmap.md](../improvement-roadmap.md) on 2026-10-13 · per-PR analysis of #263, #225, #216 and #132.

## PR #263 additions

#263 is titled "structured telemetry metrics, strict MCP config mode, and
PermissionDecision types," but the diff carries **more than the title admits**.
Ignoring the shared noise (blob + Python skills + the duplicate `session-log.ts`),
here's everything genuinely new, sorted by whether it's worth taking.

### ⚠ First, a health warning on the PR itself

`packages/core/src/common/permissions.ts` in this PR contains a **literal
unresolved Git merge-conflict marker** (`>>>>>>> ea93ba2 (…)`) left in the
source. So #263 is not a clean, mergeable branch — treat it as a **grab-bag of
ideas to reimplement**, never as something to cherry-pick wholesale.

### New modules and how they map to Nib

| Module (in #263) | What it is | Verdict for Nib |
|---|---|---|
| **`permission-profile.ts`** (+335) | A structured, ACL-style permission model (Codex "PermissionProfile"): `unrestricted \| legacy \| managed`, path-level `read/write/deny` entries with glob matching, plus network + git sub-permissions and preset profiles (`STRICT_SANDBOX`, `DEFAULT_DEV`). Self-contained glob engine, no deps. | **Strongest idea in the PR.** But it's a *parallel* permission system to Nib's existing rule engine (`src/permissions/engine.ts`), not a drop-in. Adopting it is a **permission-model redesign**, not an add-on — big decision, own workstream. See below. |
| **`telemetry.ts` metrics** (+87) | In-memory per-session counters: permission accept/reject counts, and `ToolUsageMetrics` (cost USD, API duration, lines added/removed, tool calls). Get/reset API. | **Cheap and useful.** Pure in-memory, no deps, no storage. Pairs naturally with Phase 2 (token log) — surface in an exit summary / status line. Nib already has `src/ui/exit-summary.ts` to extend. |
| **`strictMcpConfig`** (mcp-manager +29, settings +32) | A `--strict-mcp-config`-style flag: when on, MCP servers may only launch from an allowlisted command (`npx`, `node`, `python3`, `uvx`, `bun`, `deno`, `go`, `java`); anything else is blocked with a descriptive error. | **Take it — small, real security win.** Nib has `src/mcp/` and treats MCP tools as untrusted (per security-spec). A command allowlist is a clean, low-risk hardening. ~30 lines + a settings key. |
| **`hooks.ts`** (+76) | A lifecycle-hook dispatcher: user-configured shell commands fired on events (`beforeWrite`, `afterWrite`, `beforeCommand`, `onError`, `onSessionStart`, `onCompact`, …) with `{placeholder}` substitution. | **Attractive but security-sensitive.** This runs arbitrary shell on agent events — powerful (formatters, notifiers) but it's another untrusted-execution surface. Only behind explicit opt-in config, and document it in security-spec. Defer past the core phases. |
| **`compact.ts`** (+245) | A runtime content-compressor: smart JSON tool-result truncation (shrinks only the `output` field), binary detection, plain-text capping, plus lossy message-history summarization. | **Partial overlap** with Nib's `src/compaction/` + tool-result truncation in `src/tools/`. Mine it for the *smart-JSON-truncation* idea specifically; don't wholesale-import a second compaction path. |
| **`skill-parser.ts`** (+313) | Extended `SKILL.md` frontmatter parser: `agent.dependencies`, `agent.interface` (default prompt, brand color, screenshots), `agent.policy` (required permissions, allowed/denied paths → a PermissionProfile). Uses `gray-matter`. | **Only relevant if** the PermissionProfile model is adopted (its payoff is `skillPolicyToProfile`). Nib already parses Agent Skills (`src/skills/`); this is a superset tied to the profile system. Defer with it. |
| **`job-queue.ts`** (+361) | A generic child-process job queue: 3-phase spawn protocol, exponential-backoff retry, timeout, concurrency cap, event callbacks. | **Out of scope for the session-log goal.** Solves background/parallel task execution, unrelated to logging or permission saving. Note it exists; don't pull it in for this workstream. |
| **`AGENTIC_BEHAVIOR_PROMPT` / `TOOL_CHAINING_PROMPT`** (prompt.ts) | System-prompt text: the plan→execute→verify→auto-fix discipline, and a tool-chaining efficiency pattern. | **Compare, don't copy.** Nib has its own `src/prompt.ts` + `docs/system-prompt.md` with a change protocol. If any of this is wanted, it goes through that protocol, not a paste. |

### What this changes about the plan

- **Take now, cheap & on-goal:** `strictMcpConfig` (allowlist) and the
  **telemetry counters** (accept/reject + tool-usage). Both are small, dep-free,
  and reinforce Phases 1–2. Fold them in as **Phase 2.5**.
- **Big separate decision — PermissionProfile.** `permission-profile.ts` is the
  most valuable idea here, but it's an *alternative* permission architecture
  (path-level ACL + sandbox profiles) sitting beside Nib's rule-engine +
  approval-posture model. Choosing it means reconciling two models (or
  migrating). That deserves its **own design doc and its own decision**, not a
  bolt-on. Flagged, not scheduled.
- **Defer, security-sensitive:** `hooks.ts` (arbitrary shell on events) — only
  behind explicit opt-in, documented in security-spec.
- **Mine, don't import:** `compact.ts` (smart-JSON truncation idea only).
- **Out of scope here:** `job-queue.ts`, `skill-parser.ts` (unless
  PermissionProfile is adopted), prompt-text changes.

### Revised phase ordering (incorporating #263)

1. Permission audit trail *(#266)*
2. Token-usage log *(#266)*
2. **2.5 — `strictMcpConfig` allowlist + in-memory telemetry counters** *(#263, cheap wins)*
3. Hierarchical project rules *(#266)*
4. Auto error-fix + `<error_analysis>` *(#266)*
5. *(separate doc)* PermissionProfile ACL model — decide vs. current rule engine *(#263)*
6. *(deferred)* Lifecycle hooks *(#263)*; SQLite backend *(#266, optional)*

---

## PR #225 — login command

Unrelated to session logging. A small (515-line), **clean** PR — no vendored
blob, no merge markers — adding a `deepcode login` command that saves an API key
(and a ready-to-use default config) to `~/.nib/settings.json`.

### This is mostly overlap, not gap

Nib **already has** an auth flow: `auth` (interactive wizard), `auth list`,
`auth logout <provider>` in `src/auth/wizard.ts`, saving keys to
`~/.nib/credentials.yaml` (chmod 600). So #225 is not a missing feature —
but it does three things better than Nib's current wizard:

| #225 idea | Nib today | Take it? |
|---|---|---|
| **Non-interactive `--api-key` flag + piped-stdin fallback** | `authWizard` is interactive-only (`rl.question`); can't script or pipe a key. | **Yes** — real win for CI / headless / scripting. Small. |
| **Hidden, masked key input** (raw-mode `*`, Backspace / Ctrl+U / Ctrl+C aware, non-TTY fallback) | Key is typed in **plaintext** via `rl.question` — visible on screen and in scrollback. | **Yes** — genuine secret-handling improvement. `readHiddenLine` is a clean, dep-free reference. |
| **Seed a ready-to-use default config on login** (`buildLoginSettings` merges defaults, preserves existing fields) | `auth` writes only the credential; a brand-new user still has an empty `settings.json`. | **Partial** — take the *seed-defaults* idea, **not** the mechanism (see conflict below). |

### ⚠ Ethos conflict — do NOT copy the storage mechanism

#225 writes the API key **into `settings.json`** as `env.API_KEY`. Nib
deliberately does the opposite — the README states **"Keys never go in config —
env vars or the `auth`-managed credentials file"**, and keys live in
`credentials.yaml` (chmod 600), separate from config. Copying `buildLoginSettings`
verbatim would put a secret into a non-secret, potentially-committed file.

**So:** adopt the *ergonomics* (`--api-key`, piped stdin, masked input, "you're
ready to go" confirmation), keep Nib's *separation* (key → `credentials.yaml`;
optionally seed a minimal `settings.json` with **model/baseURL only, never the
key**).

### Not copy-pasteable

`login.ts` imports `writeStdout`/`writeStderrLine` from a pre-existing
`../utils/stdio-helpers` and uses their core `readSettings`/`writeSettings`/
`getUserSettingsPath`. It's a **pattern to reimplement** against Nib's
`src/config/credentials.ts` + `src/config/loader.ts`, not a file to lift.

### Proposed (small, self-contained — not part of the [phase sequence](./logging-plan.md))

- **Enhance `src/auth/wizard.ts`:** add masked input (port `readHiddenLine`), a
  non-interactive `--api-key` / piped-stdin path, and a post-save "run
  `nib` to start" confirmation.
- **Optionally** seed a minimal project/global `settings.json` (model + baseURL
  for the chosen provider) on first login — **key stays in `credentials.yaml`.**
- **Verify:** `nib auth --api-key sk-… ` (no TTY) writes the credential;
  interactive entry is masked; existing config fields are preserved; the key
  never lands in `settings.json`.

---

## PR #216 — /usage command

Unrelated to logging/auth. Small (122-line), **clean** PR: a `/usage` slash
command that queries `GET api.deepseek.com/user/balance` and renders the credit
balance / availability in a bordered Ink view (`Esc` to close), gated on
`baseURL.includes("api.deepseek.com")`.

### The UI pattern fits Nib perfectly; the data does not

- **Pattern — reusable as-is.** The bordered-view + `useInput(Esc→close)` +
  slash-command-registry approach is exactly how Nib already does `/mcp`
  (`src/ui/views/McpStatusList.tsx`, `showMcpStatus` routing in `App.tsx`,
  `slash-commands.ts`). Adding a `/usage` view is low-friction structurally.
- **Data — provider-specific.** The `GET /user/balance` endpoint and the
  `balance_infos` (`total/granted/topped_up`) shape are **proprietary to
  DeepSeek**. Nib is provider-agnostic (Anthropic, OpenAI, DeepSeek,
  OpenRouter, Groq, Ollama). Most of those have **no balance endpoint**, or a
  completely different one (e.g. OpenRouter has `GET /credits`; Anthropic/OpenAI
  expose usage via dashboards/other APIs; Ollama is local — no balance at all).

### Verdict

**Take it only if generalized, or scope it honestly.** Two options:

1. **Provider-agnostic `/usage`** — add an optional `getBalance()` to the
   provider adapter contract (`src/providers/`), implement it for the providers
   that have an endpoint (DeepSeek `/user/balance`, OpenRouter `/credits`, …),
   and have `/usage` show "not supported for <provider>" otherwise. This is the
   on-ethos version but a bigger job (touches the adapter contract).
2. **DeepSeek-only `/usage`** — port it nearly verbatim, gated on the DeepSeek
   base URL, and clearly a single-provider convenience. Cheap, but adds a
   provider-specific special-case to a codebase that otherwise keeps providers
   behind a uniform adapter.

**Recommendation:** if wanted, do **option 1** (adapter method) — it's the small
extra cost that keeps Nib's provider-agnostic promise intact. Low priority
relative to the logging/permission work; it's a convenience, not a capability
gap.

---

## PR #132 — theme system

Large (3968-line) PR adding a full theme system: `ThemeTokens` (13 semantic
tokens), a `resolveTheme` resolver (preset / overrides / tokens), 8 presets
(light, dark, github-light/dark, monokai, dracula, ansi-light/dark), a `/theme`
dropdown with live preview, a `ThemeableStatic` component, a system light/dark
detector (with 318 lines of tests), and a React-rendered exit summary.

### Key finding: Nib's theme *model* is already ahead — the *machinery* is what's missing

Nib already has a wired-up theme system in `src/ui/theme.ts`:
- **A richer token model than the PR** — ~20 semantic slots **plus** a full
  `SyntaxColors` set (19 syntax colors) **plus** a `statusBar` sub-palette,
  versus the PR's 13 flat tokens.
- `resolveTheme(config)` with `mode: dark | light | auto` + shallow overrides —
  already used in `cli.tsx`.
- A `ThemeContextValue` class + `useTheme` context consumed across ~10 UI
  components (`StatusBar`, `MarkdownText`, `OutputArea`, `SyntaxHighlighter`, …).
- A `theme` config key already parsed by the loader (`theme.mode` / `name` /
  `overrides`).

So **do NOT adopt the PR's `ThemeTokens` model or `resolver.ts`** — that would be
a *downgrade* and a large, invasive rewrite of already-working code. The value is
in four things Nib is **missing**:

| #132 piece | Nib today | Take it? |
|---|---|---|
| **`/theme` command — live preview + `Esc` reverts** | **No `/theme` command at all** (slash set is clear/continue/exit/help/mcp/model/new/plan/raw/resume/skills/undo). Theme is only set via config file. | **Yes — the headline win.** A `/theme` picker (mirroring the existing `/model` dropdown + `/mcp` view patterns) that previews live and persists to settings on confirm. |
| **More presets** (github-light/dark, monokai, dracula, ansi ×2) | Only `dark`, `light`, `high-contrast`. | **Yes, cheap** — but *re-express them in Nib's richer `ThemeDefinition` shape*, don't import the PR's thinner token objects. Pure data. |
| **Real system light/dark detection** (`detect-system-theme.ts`, 204 lines + 318 test lines: parses macOS `AppleInterfaceStyle`, terminal `COLORFGBG`, env hints) | `detectSystemTheme()` in `theme.ts` is a **weak stub** — the `matchMedia` branch never fires in a terminal, and it just checks whether `~/.config/dconf/user` exists, else returns `"dark"`. `mode: "auto"` is effectively "always dark." | **Yes — real bug fix.** Port the detector (especially `COLORFGBG` + macOS `defaults read`) so `auto` actually works. Comes with a ready test suite to adapt. |
| **`ThemeableStatic`** — re-mount Ink `<Static>` on theme change so scrollback recolors | Uses raw Ink `<Static>` in `OutputArea.tsx`; a live theme switch would leave already-printed lines in the old palette. | **Only needed if** live-preview `/theme` is added — it's what makes preview actually repaint history. Take it together with the `/theme` command. |
| **React-rendered exit summary** (`ExitSummaryView` replacing `process.stdout.write`) | `src/ui/exit-summary.ts` writes directly to stdout. | **Optional / independent.** A nice robustness fix (survives terminal scroll) but orthogonal to theming — evaluate separately. |

### Verdict

**The one to actually build here is the `/theme` command** — Nib has all
the theming infrastructure and zero user-facing way to switch at runtime. Bundle
it with: (a) the extra presets re-expressed in `ThemeDefinition` shape, (b) the
real system-theme detector (fixes the broken `auto` mode), and (c)
`ThemeableStatic` so live preview repaints scrollback.

Explicitly **reject** the PR's token model / `resolver.ts` — Nib's is
strictly richer and already integrated. This is the clearest "borrow the
*feature*, keep our *architecture*" case of all the PRs reviewed.

### Rough phasing (independent of the logging phases)

1. Extra presets in `BUILTIN_THEMES` (data only) → *verify:* each resolves and
   renders.
2. Replace the `detectSystemTheme` stub with a real detector + tests → *verify:*
   `mode:"auto"` picks light on a light terminal (`COLORFGBG`/macOS).
3. `/theme` dropdown (reuse `/model` + `/mcp` patterns) with live preview + Esc
   revert + persist-on-confirm; add `ThemeableStatic` → *verify:* preview
   recolors history, Esc restores prior theme, confirm writes `theme` to
   settings.
