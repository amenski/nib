# Config Specification

**Status:** current · verified 2026-08-13 · covers `src/config/loader.ts`, `src/config/credentials.ts`, `src/ui/core/refresh-rates.ts`

## 1. Overview

Nib config is **JSON**, loaded and merged by `src/config/loader.ts`.
Two files are read and deep-merged (project wins over global):

- **Global:** `~/.nib/settings.json` (or `$NIB_HOME/settings.json`)
- **Project:** `./.nib/settings.json` (in the current working directory)

There is no YAML config file. `config.yaml`, `~/.nib/config.yaml`, and a
`providers:` registry map are **not** read by the loader; the only YAML file
nib reads is the credentials store (see §8).

Every field is optional. Keys the loader recognizes (`KNOWN_KEYS` in
`src/config/loader.ts:205`); anything else emits a
`config: unknown field "<key>"` warning and is ignored. Config **errors**
are fatal — `main()` exits 1 (`src/cli.tsx`).

## 2. Schema

```jsonc
{
  // Default model. Top-level "model" wins over env.MODEL.
  "model": "deepseek-v4-pro",

  // Provider name. Selects a built-in preset: deepseek | openai | openrouter
  // | groq | ollama. When absent, inferred from env.BASE_URL / present env
  // keys, defaulting to "deepseek" (src/cli.tsx detectProvider).
  "provider": "deepseek",

  // Model/API env block. Maps onto the provider at launch.
  "env": {
    "MODEL": "deepseek-v4-pro",           // used only if top-level "model" unset
    "API_KEY": "sk-...",                  // works, but discouraged — see §8
    "BASE_URL": "https://api.deepseek.com",// override for the preset base URL
    "TEMPERATURE": "0.2",                 // string "0".."2"
    "THINKING_ENABLED": "true",
    "REASONING_EFFORT": "high"            // "high" | "max"
  },

  // Thinking / reasoning (top-level; higher priority than env.* strings)
  "thinkingEnabled": true,
  "reasoningEffort": "high",              // "low" | "high" | "max"
  "temperature": 0.2,                     // number, 0..2

  // Repaint cadence (nib extension): "fast" | "balanced" | "slow"
  "refresh": "balanced",

  // Permission rules (rule-based shape). See §3 and permission-spec.md.
  "permissions": {
    "defaultMode": "askAll",              // "askAll" | "allowAll"
    "rules": [
      { "tool": "read_file",     "pattern": "./**",     "action": "allow" },
      { "tool": "write_to_file", "pattern": "./**",     "action": "allow" },
      { "tool": "run_bash",      "pattern": "git *",    "action": "allow" },
      { "tool": "run_bash",      "pattern": "rm *",     "action": "deny"  },
      { "tool": "run_bash",      "pattern": "*",        "action": "ask"   }
    ]
  },

  // Capability profile (permission-profile.md §3): a coarse, absolute
  // reachability boundary gated *before* the permission rules. Absent ⇒
  // the gate is off entirely (today's behavior). See §3.1.
  "permissionProfile": {
    "level": "workspace-write",           // "strict-sandbox" | "workspace-write" | "unrestricted"
    "fs": [
      { "path": "**/*.env",   "action": "deny" },   // deny | read | write
      { "path": "~/notes/**", "action": "read" }
    ],
    "network": {
      "allow": ["api.deepseek.com"],
      "deny": ["*"]                         // allowlist mode
    }
  },

  // OS sandbox (permission-profile.md §8): mechanical Seatbelt layer for
  // bash children. macOS-only — enabled on another platform warns once at
  // startup and runs policy-only. Default false.
  "sandbox": { "enabled": true },

  // MCP servers for external tool discovery
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
      "env": { "SOME_VAR": "value" }
    }
  },

  // When true, only allowlisted MCP server commands may be spawned
  // (default false). Allowlist: npx, node, python3, python, uvx, uv, bun,
  // deno, go, java (src/mcp/connector.ts).
  "strictMcpConfig": false,

  // When true, show the client-side estimated cost (status bar segment +
  // the /cost estimate line). Default false (hidden): the estimate is
  // pricing-table math the owner has asked to keep out of view
  // (2026-08-14); token counts always display. The estimate machinery
  // stays intact behind this flag.
  "showCost": false,

  // Theme (nib extension)
  "theme": {
    "mode": "dark",                        // "dark" | "light" | "auto"
    "overrides": {}                        // optional token overrides
  },

  // Per-skill enable/disable. Absent = enabled (the default).
  "enabledSkills": { "some-skill": false },

  // Misc extensions
  "keybindings": { "overrides": {}, "disabled": [] },
  "compaction": { "auto": true, "threshold": 0.7 },  // auto gates automatic compaction (default true)
  "contextWindow": 128000,                 // fallback context window
  "workflow": { "gitStatus": true, "gitPollInterval": 30000 },
  "commands": { "timeoutToBackground": true },  // run_bash timeout → background migration (default true)
  "statusline": { "providers": [] },       // see §6
  "favoriteModels": ["deepseek/deepseek-v4-pro"],
  "recentModels": [{ "id": "openai/gpt-5.6-sol", "at": 1786602502208 }],
  "notify": "/path/to/notify-script",      // see notify-spec.md
  "hooks": {                                // lifecycle hooks — see §14
    "PreToolUse": [
      { "matcher": "run_bash|edit", "command": "hook-scripts/guard.sh" }
    ],
    "UserPromptSubmit": [ { "command": "hook-scripts/log-prompt.sh" } ]
  },
  "disableAllHooks": false                 // master switch — nothing runs when true
}
```

## 3. Permissions

The **current** shape is `permissions.rules` (an array of
`{ tool, pattern, action }`) plus an optional `defaultMode`
(`"askAll"` | `"allowAll"`). The `pattern` string is interpreted by the
loader:

| Pattern form | Interpreted as |
|--------------|----------------|
| ends with `:*` | prefix match on the text before `:*` |
| contains `*` or `?` | glob |
| empty string `""` | matches any input |
| otherwise | exact match |

`action` must be one of `allow` / `ask` / `deny`. Full resolution semantics:
permission-spec.md.

### Legacy shape (migrated with a warning)

The **old** shape used top-level `allow` / `deny` / `ask` arrays of *scope*
strings (`scan`, `read-out-cwd`, `write-in-cwd`, `mcp`, …). The loader still
accepts it, but `migrateLegacyPermissions` (`src/config/loader.ts`)
translates it to `rules` in memory and emits:

```
permissions: migrated N legacy scope(s) to rule-based permissions —
review .nib/settings.json and re-approve as needed
```

That warning fires on **every launch** until the file is rewritten to the
`rules` shape. New configs should use `rules` directly. (The scope `network`
has no rule equivalent and is dropped with its own warning; unrecognized
scopes are dropped with a warning.) Migration never writes to disk.

### `permissionProfile` (capability profile)

A coarse capability boundary (permission-profile.md): the agent may not
touch resources outside the level's default, plus explicit fs/network rules
that narrow it. Evaluated **before** the rule engine — a profile deny is
terminal (`deny-by-profile` audit decision, permission-spec.md §11).

| Level | Default fs | Default network |
|---|---|---|
| `strict-sandbox` | read-only (any path) | denied |
| `workspace-write` | read anywhere; write inside workspace roots | default-deny + allowlist |
| `unrestricted` | read + write anywhere | default-allow |

- `fs` entries are gitignore-style globs (`*`, `?`, `**`; `~`-home-relative
  and absolute allowed) with `action` `deny` | `read` | `write`. Rules
  narrow only: a `write` rule under `strict-sandbox`, or not
  workspace-relative under `workspace-write`, is a config error.
  `.git/**` and the profile file itself (`.nib/settings.json`) are
  always denied — no rule can rescue them.
- `network` entries are exact hostnames (case-insensitive) or `"*"` (any
  host — the only wildcard). The most specific matching entry wins; a tie
  (same host in both lists) goes to deny. `allow` is honored where the
  level permits grants (`workspace-write` allowlist, `unrestricted`); it is
  inert under `strict-sandbox`. `web_search` is evaluated against the
  pinned search host (`www.bing.com`).
- Project > global merge: `level` — project wins; `fs` — project entries
  append, a rule with the same `path` replaces the global one; `network` —
  `allow`/`deny` union, stricter entry wins on conflict.
- Validation errors are fatal (`main()` exits 1), naming the file and
  field, e.g.:

  ```
  global config: permissionProfile.level must be one of "strict-sandbox" | "workspace-write" | "unrestricted"
  project config: permissionProfile.fs entry "foo[bar" has invalid glob: character classes are not supported (use *, ?, **)
  project config: permissionProfile.fs entry "src/**": action "write" not allowed at level "strict-sandbox" (explicit rules narrow only)
  project config: permissionProfile.network.allow entry "*.example.com" is not a valid hostname — "*" matches any host, subdomain wildcards are not supported
  ```

### `sandbox` (OS sandbox layer)

`"sandbox": { "enabled": true }` (boolean, **default `false`**) launches
the agent's bash child processes (`run_bash` and background jobs) under a
macOS Seatbelt profile that mechanically enforces the `permissionProfile`
level: `strict-sandbox` = read-only filesystem + no network;
`workspace-write` = read anywhere, write only the spawn's workspace root,
network on. The flag is inert without a profile level below
`unrestricted`, and on non-macOS platforms (a startup warning says so) —
the policy layer (`ProfileEvaluator`) still enforces the boundary
everywhere. Full semantics and the two-layer network rationale:
permission-profile.md §8.

## 4. `refresh` (repaint cadence)

`"fast" | "balanced" | "slow"` (default `balanced`). Controls TUI repaint
throttling (`src/ui/core/refresh-rates.ts`); invalid values warn and fall
back to the default rather than erroring. Precedence:
settings.json `refresh` > `NIB_REFRESH` env > `balanced`.
Use `slow` on high-latency links.

## 5. `favoriteModels` / `recentModels`

- `favoriteModels` — array of `provider/model` IDs, pinned in the model
  dropdown.
- `recentModels` — array of `{ id, at }` entries (epoch ms), maintained by
  the model dropdown (`src/ui/components/ModelsDropdown/settings.ts`); the
  loader validates the shape and warns on malformed entries.

## 6. `statusline`

Config-authored provider plugins appended to the status line below the
prompt input, refreshed on an interval.

```jsonc
{
  "statusline": {
    "enabled": true,        // default: true when providers[] is non-empty
    "refreshMs": 2000,      // default 2000; clamped to a minimum of 500
    "separator": " · ",     // default " · "
    "providers": [
      { "type": "command", "id": "git", "command": "git branch --show-current",
        "color": "cyan", "timeoutMs": 1500, "cwd": "." },
      { "type": "module", "id": "x", "path": "./.deepcode/plugins/x.mjs",
        "color": "yellow" }
    ]
  }
}
```

**Provider types**

- `command` — runs `command` through the shell on each refresh. The **first
  stdout line** becomes the segment text. `timeoutMs` (default `1500`)
  bounds each run; on timeout, non-zero exit, or empty output the segment is
  dropped. `cwd` (default the process cwd) is resolved relative to the
  process cwd.
- `module` — imports the local JS/MJS module at `path` (resolved relative to
  the process cwd) and calls its **default export** (may be async). Its
  return value is stringified into the segment. A non-callable export or a
  throwing module drops the segment.

**Shared fields**: `id` (required, string) and `color` (optional Ink color
string). Named colors `cyan`, `green`, `blue`, `magenta`, `white`, `gray`
render via ansi256; `red`/`yellow` use the theme's error/warning slots.

**Behavior & safety**

- The refresh loop runs **outside** the React render; segments are pushed
  into the UI as they arrive. A provider that throws, times out, or blocks
  never crashes or stalls the render — it only yields an empty (dropped)
  segment.
- Provider output is **sanitized** before rendering: ANSI escapes and
  control characters are stripped, whitespace collapsed, and length capped
  (120 chars).
- Providers are user-config-authored (same trust boundary as
  `settings.json`). Only enable `command`/`module` providers you would run
  yourself.

## 7. Providers and base URL

Provider selection is by **name** (`provider` field), resolving to a
built-in preset in `src/providers/presets.ts` (`deepseek`, `openai`,
`openrouter`, `groq`, `ollama`). Each preset carries its own `baseUrl` and
`keyEnv`; catalog details: provider-spec.md.

**Overriding the base URL.** Set `env.BASE_URL` in `settings.json` to point
a built-in provider at a proxy, gateway, or self-hosted endpoint. The value
is read at launch (`src/cli.tsx`, and `src/exec-runner.ts` for headless) and
passed to `createProvider` as `options.baseUrl`, which applies it over the
preset's hardcoded `baseUrl` for **built-in presets**
(`src/providers/presets.ts`) — honored on both the TUI and exec paths.
`env.API_KEY` is likewise honored for built-in providers
(`options.apiKey`).

`setConfigProviders()` also exists in `presets.ts` to register additional
providers with a custom `baseUrl`/`apiKeyEnv`; it is not wired to a config
key today (a `providers` field is not recognized by the loader — it warns
`config: unknown field "providers"`), so `env.BASE_URL` on a built-in preset
is the supported way to override the endpoint.

Model references (`--model`, the `model` field) use `provider/model-id`,
split on the **first** slash only, so model IDs may themselves contain
slashes (`openrouter/anthropic/claude-sonnet-4.6` → provider `openrouter`,
model `anthropic/claude-sonnet-4.6`).

## 8. Credentials

API keys are resolved by `createProvider` (`src/providers/presets.ts`), in
order:

1. `options.apiKey` — sourced from `env.API_KEY` in `settings.json` when
   set.
2. The provider's env var (`DEEPSEEK_API_KEY`, `OPENAI_API_KEY`,
   `OPENROUTER_API_KEY`, `GROQ_API_KEY`).
3. `~/.nib/credentials.yaml` via `getCredential(name)`.

The **canonical, recommended** store is `~/.nib/credentials.yaml` — a
flat `provider: key` YAML map at mode `0600` (auto-chmoded if looser,
`src/config/credentials.ts`), written by `nib auth`:

```yaml
# ~/.nib/credentials.yaml  (managed by `nib auth`)
deepseek: sk-...
openrouter: sk-or-...
```

`env.API_KEY` inside `settings.json` **works** but is **discouraged**:
settings.json is meant to be shareable/committable, and a key there can leak
into version control. Prefer the credentials file or an env var.

## 9. Web search

Nib ships the built-in `web_search` tool — keyless, Bing-backed,
guarded-tier (always asks; see web-search-spec.md). For search via an
external provider, add a search MCP server under `mcpServers`; it is gated
by the existing `mcp__*` permission rules. Nib ships and endorses
none:

```jsonc
{
  "mcpServers": {
    "websearch": { "command": "npx", "args": ["-y", "<search-mcp-server-of-your-choice>"] }
  }
}
```

## 10. `enabledSkills`
### `webSearch.searxngUrl`

Optional string, absent by default. Points `web_search` at a
[SearXNG](https://docs.searxng.org/) instance the user runs themselves
(e.g. a single Docker container) as the **primary** search backend, with the
keyless Bing RSS path becoming the automatic fallback on transient failures
(network error, 5xx, timeout — surfaced with a one-line status in the tool
output) and remaining the default when this key is absent. See
[web-search-spec.md](./web-search-spec.md)'s "SearXNG backend" subsection for
the full request/fallback/caching behavior.

```jsonc
{ "webSearch": { "searxngUrl": "http://localhost:8888" } }
```

- `http://` is accepted **only** for `localhost`, `127.0.0.1`, or `[::1]`;
  any other host must use `https://`. An invalid value (bad URL, disallowed
  `http://` host, wrong type) is a **warning**, and the key is ignored — the
  tool falls back to Bing-only behavior, the same "don't crash launch over an
  optional knob" posture as `refresh`.
- The instance must have `json` enabled in its `search.formats` config
  (SearXNG's `settings.yml`) — many default installs don't, and return 403
  otherwise. `web_search` treats a 403 as a permanent instance-config problem
  (not a transient failure) and returns actionable text naming this fix; it
  does not silently fall back to Bing on a 403.

### `webSearch.enrich`

Optional boolean, **default `true`**. When enabled (the default), `web_search`
fetches the **top 3** results (post domain-filter) concurrently through
`web_fetch`'s own pipeline — https-only, per-hop SSRF checks, content-type
dispatch, body caps — and includes a bounded excerpt (≤ 2 000 chars) per
result in the tool output, collapsing the usual search→fetch round trips into
one call (handoff-web-search-searxng.md Phase 2). Set to `false` to restore
snippet-only output and its 8 000-char cap.

```jsonc
{ "webSearch": { "searxngUrl": "http://localhost:8888", "enrich": false } }
```

Enrichment is best-effort: a result whose page fetch fails (SSRF-blocked,
non-HTML, timeout, HTTP error) is shown snippet-only — it is never a reason
for the search to fail. The excerpt count is fixed at 3 and is **not**
configurable (simplicity; revisit on demand). A non-boolean value is a
warning and the key is ignored (default applies), same posture as the other
optional webSearch keys.

## `enabledSkills`

Optional `{ "<skill-name>": boolean }` map. A skill whose name maps to
`false` is **not loaded or indexed** by the skill loader
(`src/skills/index.ts`) — it never appears in the skill index and cannot be
invoked via `load_skill`. **Absent means enabled** (the default). Disabling
one skill leaves all others unaffected.

## 11. `compaction`

- `compaction.threshold` (number, default `0.7`) — the context-window
  fraction at which auto-compaction triggers (`contextWindow × threshold`).
- `compaction.auto` (boolean, default `true`) — gates **automatic**
  compaction. When `false`, the agent never auto-compacts mid-conversation
  regardless of `threshold`. Explicit compaction paths are unaffected: the
  manual `/compact` command and the resume-time compaction offer still
  summarize on demand.

Request-time context editing is separate from compaction and has no setting:
at 100,000 estimated assembled input tokens, Nib clears the contents of
older tool results in the provider-bound copy, while retaining the three newest
consumed tool uses/results. Every result from the immediately preceding tool
batch also remains complete, and the local/session transcript is unchanged.

## 12. `workflow`

Controls the git-status poller behind the status bar.

- `workflow.gitStatus` (boolean, default `true`) — enables the poller. When
  `false`, no git status is shown and no git commands are run on an
  interval.
- `workflow.gitPollInterval` (number ms, default `30000`) — poll interval.
  `0` (or negative) means **on-demand only**: the poller refreshes once at
  startup and then never again on a timer.

## 13. `commands`

Command-group behavior knobs.

- `commands.timeoutToBackground` (boolean, **default `true`**) — when a
  `run_bash` call hits its fixed 120 s timeout, the process is **moved to the
  background** (a job id is returned for `check_job`) instead of killed.
  Set to `false` to restore the old kill-on-timeout behavior. Either way,
  interactive-looking commands (editors, pagers, `git`/`sleep`, bare shells,
  REPLs — see tool-spec.md §5) are always killed, and commands that finish
  under the cap are unaffected.

## 14. `hooks`

Lifecycle hooks are **opt-in, untrusted execution surface**: user-configured
shell commands fired on agent events. The full contract — the 15-event set,
payload, exit codes, ordering with the permission engine, and the
trust-on-first-use model — is `hooks-spec.md`. This section only covers the
config shape.

- `hooks` (object of event name → entry array). Each entry is
  `{ matcher?, command }`:
  - `command` — a single shell string, spawned via `/bin/sh -c` with cwd =
    the project root.
  - `matcher` (tool events only: `PreToolUse`, `PermissionRequest`,
    `PostToolUse`, `PostToolUseFailure`): omitted or `"*"` = all tools; a
    string matching `^[A-Za-z0-9_|,]+$` = an exact-name list
    (`run_bash|edit`); anything else = an unanchored JS regex. An invalid
    regex is a **config error** (fail fast, naming the entry). Matchers on
    other events are accepted and ignored.
  - Per event key, **project wins over global** (same merge as the rest of
    the file): the project's array replaces the global's; events the project
    doesn't mention keep the global entries. Entries keep their origin for
    the TOFU trust model (global hooks are trusted implicitly, project hooks
    must be confirmed — hooks-spec.md §6).
- `disableAllHooks` (boolean, default `false`) — master switch: nothing
  runs, not even trusted hooks.

## 15. No telemetry

Nib collects **no telemetry**. This is a deliberate guarantee, not a
default that a config key can flip. There is no telemetry subsystem in the
codebase and no config key enables one — the former `telemetryEnabled` key
(and the `env.TELEMETRY_ENABLED` string) were never consumed and have been
removed; `telemetryEnabled` now warns as an unknown field. If you set it,
nothing happens because there is nothing to enable.

The **only automatic network contact** is the npm update check
(update-check.md) — and it is inert while the package is `private`, which
this repo is.

## 16. Deprecated keys

| Key | Status | Replacement |
|-----|--------|-------------|
| `webSearchTool` (script path) | Parsed but ignored; emits a warning | Use the built-in `web_search` tool, or a search MCP server under `mcpServers` |
| `debugLogEnabled` (boolean) | Parsed but ignored; emits a warning | Use the `--debug` CLI flag |
| `workflow.gitCommands` (boolean) | Parsed but ignored; emits a warning | None — no git-command subsystem consumes it |
| `workflow.detectBuildTools` (boolean) | Parsed but ignored; emits a warning | None — no build-tool detection subsystem consumes it |
| `telemetryEnabled` (boolean) | **Removed** — now an unknown-field warning | None — Nib has no telemetry (see §15) |

## 17. Environment variables

| Variable | Purpose |
|----------|---------|
| `NIB_HOME` | Override the complete config and state home (default `~/.nib`) |
| `NIB_REFRESH` | Repaint cadence: `fast \| balanced \| slow` (lower priority than settings.json `refresh`) |
| `NIB_PROFILE` | `"1"` enables the event-loop stall watchdog (troubleshooting.md) |
| `NIB_HIGH_CONTRAST` | `"1"` enables high-contrast rendering |
| `NO_COLOR`, `CI`, `TERM`, `COLORTERM` | Color/terminal capability gating |
| `DEEPSEEK_API_KEY` | DeepSeek API key |
| `OPENAI_API_KEY` | OpenAI API key |
| `OPENROUTER_API_KEY` | OpenRouter API key |
| `GROQ_API_KEY` | Groq API key |
| `ANTHROPIC_API_KEY`, `TOGETHER_API_KEY` | Detected for provider inference; no bundled presets |

### NIB_HOME support

`resolveHome()` (`src/config/loader.ts`) is the single source of truth:
`NIB_HOME` if set, else `~/.nib`. Every subsystem routes through
it — config, modes, theme dropdown, prompt history, stall watchdog,
credentials, sessions, checkpoints, and memory. A full install under a
custom home is portable: `NIB_HOME=/tmp/hh nib` keeps everything
(config, credentials, sessions, checkpoints, memory) under `/tmp/hh`.
