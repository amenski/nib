# Heirloom

[![Build](https://github.com/amenski/heirloom-agent/actions/workflows/build.yml/badge.svg)](https://github.com/amenski/heirloom-agent/actions/workflows/build.yml)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)
[![Node.js 20+](https://img.shields.io/badge/node-%3E%3D20-green.svg)](https://nodejs.org)

A personal AI coding agent for the terminal — bring your own key, use any model,
readable codebase.

---

## Install

```bash
git clone https://github.com/amenski/heirloom-agent.git
cd heirloom-agent
npm install
npm run build && npm link
```

Then add an API key:

```bash
heirloom auth                    # guided setup (stores in ~/.heirloom/credentials.yaml)
export DEEPSEEK_API_KEY=...      # or set an env var
```

Launch:

```bash
heirloom                         # interactive
heirloom "explain src/foo.ts"    # start with a prompt
heirloom -c                      # continue the most recent session
heirloom -p "..."                # one-shot, no TUI (for scripts)
heirloom doctor                  # verify your setup
```

Check your setup any time with `heirloom doctor`.

---

<p align="center">
  <img src="assets/prompt-screen.png" alt="Heirloom TUI screenshot" width="720">
</p>

---

## Everyday use

```
heirloom [general] > explain this codebase       read-only by default
heirloom [general] > /mode code                  enable implementation tools
heirloom [code]    > Shift+Tab                   cycle normal / auto-approve / plan
```

New sessions start in `General`, a fast, read-only chat mode. Switch to `Code`
when you want Heirloom to edit files, run commands, or delegate a larger task
to a sub-agent. `Shift+Tab` is an independent permission posture: it cycles
`normal → auto-approve → plan` in whichever mode is active.

| Keys / commands | |
|---|---|
| `Enter` | send · `Shift+Enter` newline |
| `Esc` | interrupt the current turn — nothing partial is saved |
| `Shift+Tab` | cycle the approval posture |
| `/` | open the command menu |
| `/help` | full command list |
| `/model`, `/effort` | pick model · set reasoning effort |
| `/new`, `/resume`, `/continue` | session management |
| `/undo` | rewind code and/or conversation |
| `/theme` | switch color theme (live preview) |
| `/permissions` | this session's permission history |
| `/skills`, `/mcp`, `/tasks` | list skills · inspect MCP servers · inspect/stop sub-agent tasks |
| `Ctrl+D` twice | quit |

### CLI flags

| Flag | Meaning |
|---|---|
| `[prompt]` | positional prompt to submit on launch |
| `-p, --print` | print the response and exit, non-interactive (needs a prompt) |
| `-r, --resume [id]` | resume a session by ID, or open the picker |
| `-c, --continue` | continue the most recent session for this directory |
| `--model <provider/model>` | override the configured model |
| `--mode <name>` | start in a given mode |
| `-d, --debug` | opt in to diagnostic request/response JSONL (includes conversation and tool payloads, with secret redaction) |

```bash
cat error.log | heirloom -p "Explain this error"
```

---

## Configuration

Create `~/.heirloom/settings.json` (or `./.heirloom/settings.json` per project;
project wins when both exist):

```jsonc
{
  "permissions": {
    "defaultMode": "askAll",
    "rules": [
      { "tool": "read_file",     "pattern": "./**", "action": "allow" },
      { "tool": "write_to_file", "pattern": "./**", "action": "allow" },
      { "tool": "run_bash",      "pattern": "*",    "action": "ask"   }
    ]
  },
  "mcpServers": {
    "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] }
  }
}
```

With the default DeepSeek setup, General uses DeepSeek Flash with low
reasoning effort to keep everyday chat fast and inexpensive. An explicit
provider or model selection in settings, flags, or slash commands takes
precedence; use `model` and `provider` here, `--model`, or `/model` to choose.

- Store API keys in `~/.heirloom/credentials.yaml` (via `heirloom auth`) or env
  vars — not in settings.json.
- Project instructions: `.heirloom/instructions.md` (or `AGENTS.md`).
- Custom modes: drop a YAML file into `~/.heirloom/modes/`.

Full schema: [`docs/config-spec.md`](./docs/config-spec.md).

---

## Features

### Persona modes

`general` is the default read-only conversation mode. `code` adds file editing,
command execution, debugging, and task delegation through `new_task`. Each
mode gates which tools the model sees; switch with `/mode general` or
`/mode code`.

### Permission rules

Allow, ask, or deny tools by name and pattern. Shortcut: `Shift+Tab` cycles
`normal → auto-approve → plan`. Every decision is recorded (`/permissions`).

### Checkpoints

Every file edit is backed up in a shadow Git repo. `/undo` rewinds code,
conversation, or both.

### Resumable sessions

Conversations are append-only JSONL files. Long chats stay usable through
automatic compaction. Resume with `--continue`, `--resume <id>`, or `/resume`.

### Skills & MCP

Install [Agent Skills](https://agentskills.io) or connect MCP servers. Browse
with `/skills` and `/mcp`.

### Web search

`web_search` works with no API key, backed by Bing's keyless RSS feed, and
`web_fetch` reads any result in full. Both ask before running and treat what
comes back as untrusted input.

Because that feed is undocumented, it can change shape without notice. When a
response no longer parses as RSS, the tool says so explicitly rather than
reporting "no results" — a broken search never masquerades as an empty web.
For a stronger index, add a search MCP server with your own key
([`docs/config-spec.md`](./docs/config-spec.md)); Heirloom ships none and
stores no keys.

### Stale-file detection

The agent tracks when it last read each file and refuses to overwrite changes
you made outside it.

### Streaming & observability

Replies stream as they generate. `/cost` shows session token usage. `/theme`
switches color schemes with a live preview. `/doctor` runs diagnostics. The
`-d`/`--debug` flag is opt-in and writes diagnostic JSONL containing request,
response, conversation, and tool-call payloads after secret redaction; avoid
enabling it for sensitive sessions unless you need that detail.

## Supported models

- `deepseek-v4-pro` (primary, best tested)
- `deepseek-v4-flash`
- Any DeepSeek, OpenAI, OpenRouter, Groq, or Ollama model
- Any OpenAI-compatible provider via config

---

## Better search (optional)

`web_search` works out of the box via keyless Bing RSS — thin, snippet-only
results. For richer results (and inline content excerpts), run your own
[SearXNG](https://docs.searxng.org/) instance locally and point heirloom at it:

```bash
# 1. Start it (localhost-only, port 8888). The compose file renders a fresh
#    random secret_key container-side on every start — the shipped
#    searxng/settings.yml stays a read-only template.
docker compose up -d

# 2. Verify
curl -s http://localhost:8888/healthz    # → OK
curl -s "http://localhost:8888/search?q=test&format=json" | head -c 120
```

Then add one line to `~/.heirloom/settings.json`:

```json
"webSearch": { "searxngUrl": "http://localhost:8888" }
```

SearXNG becomes the primary backend, Bing stays as the automatic fallback
when the instance is down, and the top results come back with inline
content excerpts (`enrich` defaults on). `http://` is accepted only for
localhost; a remote instance must use `https://`. See
[`docs/web-search-spec.md`](./docs/web-search-spec.md).

> If you already run a SearXNG container named `searxng` on port 8888,
> remove it (`docker rm -f searxng`) before `docker compose up` — the
> compose file manages the same name and port.

## FAQ

### Why another AI coding agent?

Heirloom started as a fix for an agent that broke inside IntelliJ's embedded
terminal. It grew into a full tool by combining the best ideas from opencode,
RooCode, Aider, and SWE-agent — modes, checkpoints, permission rules — with
zero telemetry and no vendor lock-in. Every design decision is documented in
[`docs/`](./docs/).

### Does it send my data anywhere?

Heirloom has no telemetry or analytics. It sends prompts and tool results to
the model provider you select, and may contact integrations you explicitly
configure or invoke, such as web search, MCP servers, hooks, or notifications.

### Is it safe to use on production code?

Heirloom executes model-chosen commands on your machine. The permission system
is the safety net — read [`docs/security-spec.md`](./docs/security-spec.md)
before enabling auto-approve on code you didn't write.

### How do I configure MCP?

Add `mcpServers` to settings.json (see Configuration above), then use `/mcp` to
inspect connected servers. See [`docs/config-spec.md`](./docs/config-spec.md).

### How do I get notified when a task completes?

Set `notify` in settings.json to the path of a notification script.
See [`docs/notify-spec.md`](./docs/notify-spec.md).

### Does it support images?

Yes — three routes:

- **Paste** — `Ctrl+V` attaches an image from the clipboard.
- **Mention** — `@path/to/shot.png` in the prompt attaches that file
  (permission-gated like `read_file`).
- **Tool** — the model calls `view_image` for an https image URL or a local
  file path.

Images must be PNG, JPEG, GIF, or WebP and at most 5 MB. The active model
must accept image input. `read_file` refuses binary files rather than
returning garbled text.

### Does it support Thinking mode?

Yes. Set `thinkingEnabled: true` in settings.json. DeepSeek models support
reasoning effort control (`/effort`).

---

## Docs

**Start at [`docs/README.md`](./docs/README.md)** — the canonical index of
specs, deep dives, and troubleshooting, with reading paths for new
contributors, maintainers, and users. [`docs/archive/`](./docs/archive/)
holds superseded designs and completed task briefs (records, not reference).

Having trouble? See [`docs/troubleshooting.md`](./docs/troubleshooting.md).

---

## Contributing

```bash
git clone https://github.com/amenski/heirloom-agent.git
cd heirloom-agent
npm install
npm test              # run the test suite
npx tsc --noEmit      # type gate
npm run build         # bundle with tsup
```

See **[CONTRIBUTING.md](./CONTRIBUTING.md)** for the PR checklist, code map,
and good first contributions. [Code of Conduct](./CODE_OF_CONDUCT.md) applies.

---

## License

[Apache 2.0](./LICENSE)
