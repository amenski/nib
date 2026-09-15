# CLI Specification

**Status:** current · verified 2026-08-13 · covers `src/cli-args.ts`, `src/cli.tsx`, `src/exec-runner.ts`, `src/ui/core/slash-commands.ts`, `src/ui/App.tsx`, `src/ui/keybindings.ts`, `src/ui/HelpOverlay.tsx`

## 1. Invocation

```
nib [flags]                        # interactive TUI (the normal case)
nib -p "<prompt>" [flags]          # headless: run one task, print, exit
nib auth                           # interactive provider setup wizard
nib auth list                      # show configured providers + key sources
nib auth logout <provider>         # remove a credential
nib auth <provider>                # set <provider>'s key (masked prompt)
nib auth <provider> --api-key <key># non-interactive; -k alias
echo <key> | nib auth <provider>   # piped: key read from stdin
nib doctor                         # print environment / config diagnostics
```

`doctor` and `auth` are the only real subcommands — special-cased in
`src/cli.tsx` `main()` before argument parsing. Everything else is parsed by
yargs (`src/cli-args.ts`) as flags plus an optional positional `prompt`; a
non-flag word that is not `auth`/`doctor` is treated as a positional prompt,
not rejected as an unknown command.

`doctor` runtime health (F2, 2026-08-15): when `webSearch.searxngUrl` is
configured, `doctor` also GETs `{url}/healthz` with a 3 s timeout and no
retries (diagnostics, not the web_search tool path) and prints
`SearXNG: ok (N ms)` or `SearXNG: unreachable — searches will fall back to
Bing.` — `src/cli.tsx` `probeSearXngHealth`.

### Key entry

- **Masked interactive input.** On a TTY the key prompt reads in raw mode and
  echoes `*` per character — the key is never shown in plaintext. Enter
  submits, Ctrl+C cancels (nothing is written).
- **Non-interactive `--api-key` (alias `-k`)** — for scripts and CI.
- **Piped stdin** — when stdin is not a TTY, `nib auth <provider>`
  reads one line from stdin as the key.

The API key belongs in `~/.nib/credentials.yaml` (0600) or an env var.
`env.API_KEY` in settings.json works but is discouraged (settings.json is
meant to be shareable). See config-spec.md §Credentials.

### Running it

- Dev: `npm start -- <args>` runs the CLI through `tsx`.
- Built binary: `npm run build && npm link` puts `nib` on `PATH`.

## 2. Flags

| Flag | Effect |
|------|--------|
| `[prompt]` | Positional prompt. With `-p`, the headless prompt; without, prefills the first TUI turn. |
| `-p`, `--print` | Print the response and exit, non-interactively. **Requires** a non-empty positional prompt. |
| `-r`, `--resume [id]` | Resume a specific session by its ID; with no ID, open the session picker. |
| `-c`, `--continue` | Continue the most recent session for the current project directory. |
| `--model <provider/model>` | Override the configured model (split on the first `/`). |
| `--mode <slug>` | Start in the given mode. Headless (`-p`): unknown slug rejected with a clean error (`src/exec-runner.ts`). Interactive: unknown slug silently falls back to the default `general` mode. |
| `-d`, `--debug` | Write redacted request/response JSONL. |
| `--add-dir <path>` | Add an explicitly trusted writable directory; repeat for multiple directories. Relative paths resolve from the startup directory and apply to file edits and sandboxed shell writes. |
| `-h`, `--help` | Show help and the epilog, exit 0. |
| `-v`, `--version` | Print the current version (from `package.json` via `src/version.ts`), exit 0. |

There is **no** `--session` or `--approve` flag.

### Flag validation (`.check()` in `src/cli-args.ts`)

- `-p` without a non-empty positional prompt → error.
- `-c` together with `-r` → error.
- `-r <id>` failing the session-ID check → `Invalid session ID`.

**Session-ID format.** `generateId()` (`src/sessions/store.ts`) takes
`toISOString()`, strips `:` and `.`, slices to 15 chars, and appends
`-<4hex>` — the real shape is `YYYY-MM-DDThhmm-<4hex>`, e.g.
`2026-07-30T2358-15a3`. `-r` validates against exactly this pattern
(`/^\d{4}-\d{2}-\d{2}T\d{4}-[0-9a-f]{4}$/`), and session files are stored as
`<id>.jsonl`, so the filename *is* the ID. Legacy UUID IDs are intentionally
not accepted.

## 3. Headless mode (`-p`)

Runs one task non-interactively: streams output to stdout, exits when the
agent completes. Errors go to stderr so stdout stays pipeable.

- **Permissions fail closed.** There is no user to ask, so any tool call that
  resolves to `ask` is denied (permission-spec.md §Headless Interaction).
  Headless runs need explicit `allow` rules.
- If no provider key is resolvable, the run fails (see Exit Codes).
- **Clean error output.** Failures (missing key, unknown provider, unknown
  `--mode`, provider API errors) print a single concise `Error: <message>`
  line to stderr — a provider API error is reduced to its status code and
  message, not the full error object. The complete error (stack, request
  body, headers) is emitted only with `--debug` (`src/exec-runner.ts`).
- The notify hook fires from this completion boundary
  (`src/exec-runner.ts`, notify-spec.md).

## 4. Exit codes

| Code | Meaning |
|------|---------|
| 0 | Clean exit / headless task completed (`stopReason: "done"`) / `--help`/`--version` / `auth`/`doctor` success |
| 1 | Fatal error (bad config, provider failure, flag validation failure, non-TTY launch of the interactive UI, headless stop other than "done") |
| 130 | Headless run interrupted by SIGINT |

## 5. Slash commands

Typed at the prompt inside the TUI. Three surfaces:

1. **Autocomplete menu** — `BUILTIN_SLASH_COMMANDS`
   (`src/ui/core/slash-commands.ts`): `/skills`, `/model`, `/mode`,
   `/effort`, `/theme`, `/new`, `/resume`, `/continue`, `/undo`, `/mcp`,
   `/tasks`, `/permissions`, `/usage`, `/plan`, `/raw`, `/clear`, `/compact`,
   `/doctor`, `/help`, `/exit`.
2. **Text dispatcher** — `handleSlashCore` (`src/cli.tsx:987`): `/help`,
   `/cost`, `/context`, `/usage`, `/doctor`, `/skills`, `/skill <name>`,
   `/clear`, `/compact`, `/modes`, `/mode [slug]`, `/model [provider/model]`,
   `/effort [value]`, `/sessions`.
3. **TUI handlers** (`src/ui/App.tsx` `handleSlashCommand`): `/theme`,
   `/new`, `/resume`, `/continue`, `/sessions` (alias for the session
   list), `/undo`, `/mcp`, `/tasks`, `/permissions`, `/usage`, `/plan`,
   `/raw`, `/exit`.

**Routed but not in the autocomplete menu:** `/cost`, `/context`, `/modes`,
`/skill <name>`, `/sessions`.

The in-app help screen (`src/ui/HelpOverlay.tsx`) lists the commands above
(including `/sessions`, `/skill`, `/cost`); it no longer advertises
`/checkpoint`, `/checkpoints`, or `/restore` — those were removed.

Unknown `/command` → `Unknown: <cmd>\nType /help.`, never sent to the LLM.
Input not starting with `/` is always a user message.

**Headless `/sessions`.** `handleSlashCore`'s `/sessions` case lists the
current project's sessions (the TUI opens the interactive picker instead;
this is the non-interactive path): one line per session, newest first, with
id, excerpt (`title` with `firstMessage` fallback), age (`5m ago` / `3h ago`
/ date — the SessionList row shape), and message count. Empty project →
`No sessions for this project.` Exits 0.

**`/usage`** (feature-plans.md §7). In the TUI it opens a bordered view
(`src/ui/views/UsageView.tsx`, Esc closes — the `/mcp` pattern) showing an
account **balance block** and a **per-model token breakdown**. In headless
mode (`handleSlashCore`'s `/usage` case) it prints the same rows and exits 0:
one balance line or `Balance: not supported for <provider>`, the session
token totals, and one line per model with tokens. The balance is queried
**live on every open** — the adapter's optional `getBalance` is called fresh,
nothing is cached (decision I). Which providers support a balance query, and
the exact response parsing, are documented in provider-spec.md §2.1; the
provider name printed when unsupported is the active provider, not the model.

**`/tasks`** (async-subagents.md §4, Q4). In the TUI it opens a bordered view
(`src/ui/views/TaskList.tsx`, Esc closes — the `/mcp` pattern) listing the
session's async sub-agent tasks: task id, agent name/depth, status
(running/done/failed/aborted), age, and a truncated description. ↑↓
navigates; **Enter stops the selected running task** — that sub-run aborts
(its own signal fires, the record flips, its late result is suppressed) while
siblings keep running. While any task runs, the status line shows
`● task <id> running` (or `N tasks` when several), cleared when none run
(`src/ui/core/task-status.ts`). Tasks are in-memory only and die on exit
(async-subagents.md §3, Q3); headless runs have no interactive /tasks surface.

**Completion (Tab).** A bare Tab completes contextually. At the start of the
line (or after whitespace) it completes a slash command. After `@` the file
mention picker handles insertion (Tab inserts the highlighted path). With
neither menu open, Tab falls back to `ctx.completer` (`src/cli.tsx`
`completer()`), which completes `/mode <s>` and `/model <p/m>` args,
`@`-paths, and bare mid-line path tokens containing `/` (`docs/fea` →
`docs/feature-plans.md`). The completer's contract is `[hits, base]`: `base`
is the typed stem — a suffix of the line — that the chosen hit replaces. A
Tab with no completion is swallowed (Tab never types a tab character);
Shift+Tab cycles posture.

**@-mentions.** `@path` tokens at word boundaries are read and attached to
the model's view of the prompt as `<file>` blocks
(`src/ui/core/file-mentions.ts` `expandFileMentions`), capped at 60 KB per
file; unreadable or binary files are skipped (the mention stays in the
prompt as text). Before injection each mentioned path is resolved through
the permission engine's `read_file` rules: a path resolving to `deny` is
injected as `<file path="…">[not injected: denied by permissions]</file>`
instead of its content; `ask`/`allow` inject normally (best-effort, Claude
Code parity — the deny rule is the gate; there is no interactive prompt at
expansion time). Shipped 2026-08-13 (feature-plans.md §5).

## 6. Posture & display toggles

| Key/command | Effect |
|-------------|--------|
| Shift+Tab | Cycle approval posture: `normal → autoApprove → plan` (`src/ui/App.tsx` `cyclePosture`) |
| `/plan` | Toggle plan mode directly (the same posture Shift+Tab cycles to) |
| `/raw` | Cycle display mode: `lite → normal → raw-scrollback` |
| Ctrl+E | Stream an AI explanation of a pending permission prompt |

Posture semantics (permission-spec.md): `normal` asks per policy;
`autoApprove` bypasses ordinary rule-derived asks but **never**
unresolved/guarded tiers; `plan` is read-only and requires a
`<proposed_plan>` block before implementing.

**Profile level is NOT on the status line** (decided 2026-08-14): the
level is static configuration, not ambient session state, and the bar
shows only what changes mid-session (mode, posture, effort, context
fill). The configured level is visible in `nib doctor` and
`/permissions` instead.

## 7. Keybindings

`DEFAULT_BINDINGS` (`src/ui/keybindings.ts:90`); user overrides via
settings.json `keybindings: { overrides, disabled }` with combos like
`ctrl+shift+t` (modifiers: `ctrl+`, `meta+/cmd+`, `shift+`, `alt+/option+`).

| Action | Default keys |
|--------|--------------|
| Cursor move | ← → ; Home / End |
| Cursor by word | Ctrl+←/→ (also Alt+←/→) |
| Delete char | Backspace / Delete |
| Delete word | Ctrl+Backspace / Ctrl+Delete |
| Clear line | Ctrl+U |
| History | ↑ / ↓ (also Ctrl+P / Ctrl+N); Ctrl+R search |
| Complete | Tab; Shift+Tab partial |
| Submit | Enter |
| Abort (interrupt turn) | Esc |
| Open mode picker | Ctrl+O |
| Cancel | Ctrl+C |
| Quit | `/exit`, Ctrl+D twice |

Note: `Ctrl+M` can never be a binding in a terminal (0x0D is the Enter
byte), and Ctrl+Shift+P arrives as 0x10 (shift is not encoded) — both are
documented in `src/ui/keybindings.ts`; user-supplied keybindings can bind
those actions to chords that do encode.

**Mid-turn input (steering).** Typing during a running turn is queued
(`src/ui/App.tsx` `messageQueueRef`). The agent loop polls the mailbox once
per decision point — before each provider call, never mid-stream — and
injects a queued message as a `User message (typed mid-turn): …` block in
the volatile prefix, persisting it as a real user message so the session
record stays honest. Esc interrupts the current call and returns to the
prompt; queued input is never dropped and runs in the next turn. Slash
commands typed mid-turn stay queued and run at turn end (FIFO). Shipped
2026-08-13; mechanics in subsystems/react-loop.md.

## 8. Output conventions

- Assistant text streams to stdout (interactive) or stdout-only final reply
  (headless).
- Errors and warnings go to **stderr**, so `-p` stdout stays pipeable.
- The interactive UI is an Ink TUI and requires a TTY; launching the
  interactive path without a TTY prints `nib requires an interactive
  terminal (TTY)...` and exits 1. (`-p` headless mode does not need a TTY.)

## 9. In-session delegation — `new_task`

The `new_task` tool (workflow group; exposed by the Code mode and the hidden
orchestrator alias) spawns a
sub-agent with an isolated context; only its summary returns. Full semantics
in subsystems/orchestration.md §7. Parameters:

| Param | Required | Meaning |
|-------|----------|---------|
| `description` | yes | Self-contained task description (the sub-agent cannot see the parent conversation) |
| `mode` | no | The sub-agent's mode/toolset; defaults to `code` |
| `agent` | no | A defined agent name (`.nib/agents/<name>.md`, feature-plans.md §F4) — overrides `mode` and the parent's model with the def's own; unknown name → tool error listing available agents |

With `agent` absent, behavior is unchanged (call-provided `mode`, parent
model). Defined agents' `name` + `description` lines are indexed into the
system prompt ("Available agents") so the model knows the names it may pass;
the `/skills` slash command prints a one-line agent list. `new_task` is
available both interactively and headless (`-p`).
