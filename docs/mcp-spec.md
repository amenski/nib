# MCP Specification

**Status:** current · verified 2026-08-14 · covers `src/mcp/{client,connector,pins}.ts`, `src/ui/views/McpStatusList.tsx`

## 1. Overview

Nib speaks the Model Context Protocol over **stdio**: each configured
server is a child process; its tools appear to the model as
`mcp__<server>__<tool>` calls, gated by the same permission engine as any
other tool.

## 2. Configuration

`mcpServers` in settings.json (config-spec.md §2):

```jsonc
{
  "mcpServers": {
    "context7": {
      "command": "npx",
      "args": ["-y", "@upstash/context7-mcp"],
      "env": { "SOME_VAR": "value" }
    }
  }
}
```

`command` (required) is the launcher; `args` optional; `env` optional extra
environment for the child.

## 3. Connection lifecycle (`connector.ts`)

- Statuses: `starting → connected | failed | reconnecting`.
- `connectMCPServers(servers, { strictMcpConfig })` runs at startup
  (`src/cli.tsx`); `disconnectAllMCPServers()` on exit.
- **`strictMcpConfig: true`** gates spawning: only launchers whose
  *basename* is in the allowlist may run — `npx, node, python3, python,
  uvx, uv, bun, deno, go, java`. A blocked server is marked `failed` with
  the reason in `errorMap` (visible in `/mcp`), never spawned.
- `reconnectMCPServer(name, config, { approvePinChange })` disconnects a
  stale client, re-checks the allowlist, spawns, lists tools, compares
  against the persisted tool-def pin (§6), and registers them; the `/mcp`
  view exposes it as a per-server reconnect action.

## 4. Tool registration

For each tool the server advertises (`listTools`), the connector registers
one model-facing tool:

- **Name**: `mcp__<server>__<tool>` (namespaced to avoid collisions).
- **Schema**: the server's `inputSchema` (`properties`/`required`) mapped
  onto the `ToolDef` shape.
- **Groups**: `["mcp", <serverName>]` — so mode-gating can grant or deny
  per server (`registry.getByMode`), and permission rules match
  `mcp__<server>__*`.
- **Handler**: `callTool` → join text-content parts; `result.isError` or a
  thrown JSON-RPC error surfaces as a normal `ToolOutput` error (never a
  crash — the handler contract).

## 5. Wire protocol (`client.ts`)

- **Transport**: stdio pipes — `spawn(command, args, { stdio: pipe })`.
- **Protocol**: JSON-RPC 2.0 — `initialize`, `tools/list`, `tools/call`
  requests with monotonically increasing ids; notifications
  (`notifications/initialized`, `notifications/cancelled`).
- **Errors**: JSON-RPC error responses map to thrown errors in the
  handler, which the connector catches into `errorMap` and status.

## 6. Security model

- Servers run as **untrusted child processes** — hence the
  `strictMcpConfig` launcher allowlist (§3).
- MCP tool **results and descriptions are untrusted input** (security-spec
  §3 — a server can rug-pull a description after review).
- **Tool-definition pinning (security-spec T10, fixed 2026-08-14)**:
  `src/mcp/pins.ts` hashes each advertised tool (`name + description +
  canonicalized inputSchema`) and persists per server name to
  `~/.nib/mcp-pins.json` (mode 0600, atomic tmp+rename, hashes only).
  Every connect — first-ever or reconnect — compares against the pin: a
  description/schema change (or a tool added/removed) marks the server
  `pinChanged` in `/mcp` (`pinned-defs changed — re-approve`), the changed
  defs are **not re-registered** (a stderr warning names the server), and
  pressing **R** asks a y/n confirmation before re-pinning and registering
  (`approvePinChange: true`). First-ever connects pin without prompting.
  Unchanged reconnects are silent.
- Every `mcp__*` call passes through the normal permission engine; rules
  use the `mcp__*` wildcard form.

## 7. Verified against

`src/mcp/connector.ts` (statuses, allowlist, registration, reconnect,
pinning) · `src/mcp/pins.ts` (pin store, compare, re-pin) ·
`src/mcp/client.ts` (spawn, JSON-RPC, listTools/callTool) ·
`src/ui/views/McpStatusList.tsx` (status view + reconnect + re-approval
confirmation) · `src/cli.tsx` (connect/disconnect wiring)
