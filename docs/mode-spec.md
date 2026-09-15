# Mode Specification

**Status:** current · verified 2026-08-13 · covers `src/modes/{loader.ts,builtin/*.yaml}`

## 1. Overview

A mode is a YAML-defined persona that gates tool access, restricts file
modifications, and adds behavioral instructions. Modes shape the system
prompt (role definition at the top, custom instructions after the base
rules — system-prompt.md) and the tool set offered to the model
(`src/cli.tsx` filters via `registry.getByMode(mode.groups)`).

### Persona, permission posture, and model are separate controls

- The **persona/mode** defines identity, instructions, available tool groups,
  and optional file restrictions. A missing group means those tools are not
  sent to the model at all.
- The **permission posture** (`normal`, `autoApprove`, or `plan`) controls how
  an available tool may be used. `Shift+Tab` changes posture without changing
  the persona; plan posture prevents execution and asks for a proposed plan.
- The **provider/model** generates the response. A persona may supply a model
  and reasoning-effort default, but an explicit user selection takes
  precedence.

This separation is why “Code + plan” is meaningful: Code supplies engineering
context and implementation tools, while plan posture temporarily blocks those
tools from executing. Conversely, changing from General to Code expands the
tool surface even if the permission posture remains normal.

## 2. Schema

`ModeConfig` (`src/modes/loader.ts:5`):

```yaml
# Required
slug: string             # Unique identifier, kebab-case (e.g. "code", "my-reviewer")
name: string             # Display name (e.g. "Code", "PR Reviewer")
roleDefinition: string   # Identity/expertise placed at the start of the system prompt

# Optional
description: string      # Short summary for the mode selector
groups: string[]         # Allowed tool groups: read, edit, command, mcp, workflow
fileRegex: string        # Restrict file modifications to matching paths
customInstructions: string  # Additional rules appended to the system prompt
model: string            # Sticky model (provider/model)
reasoningEffort: string  # Mode effort default when the user has not selected one
hidden: boolean          # Excluded from listAll() (the picker/`/modes` listing);
                          # still reachable by slug via load() — a compatibility
                          # alias for a retired mode name (e.g. ask.yaml)
```

YAML is parsed by a small hand-rolled parser (`src/modes/loader.ts:16`):
top-level keys, `>`/`|` folded blocks, indented `- ` lists, `[a, b]` inline
arrays, quoted scalars.

## 3. Tool groups

`ToolGroup = "read" | "edit" | "command" | "mcp" | "workflow"`
(`src/tools/types.ts:40`).

| Group | Tools | Purpose |
|-------|-------|---------|
| `read` | read_file, list_files, glob, search, web_fetch, web_search | Information gathering |
| `edit` | edit, edit_file, search_replace, apply_diff, apply_patch, write_to_file | Code modification |
| `command` | run_bash, run_bash_background, check_job, kill_job | Shell execution |
| `mcp` | `mcp__<server>__<tool>` (dynamic, per connected server) | External tool servers |
| `workflow` | new_task | Sub-agent delegation |

## 4. Always-available tools

These bypass mode gates regardless of group:

- `ask_user_question` — structured clarification questions (all groups)
- `update_todo_list` — the task plan checklist (all groups; tool-spec.md)
- `load_skill` — skill content injection (`always: true` + read;
  skill-spec.md)
- `switch_mode` — persona-mode switch (all groups; auto-switch, no
  confirmation — tool-spec.md)
- `attempt_completion` — end-the-turn signal (all groups; tool-spec.md)

`new_task` is **not** always-available: it is `workflow`-group only. Code can
delegate directly; the retired orchestrator alias remains available for
compatibility.

## 5. Current personas and legacy aliases

`src/modes/builtin/*.yaml`:

Nib has two current, user-facing personas: General and Code. The other YAML
files in the built-in directory exist only so older sessions and explicit old
slugs continue to load; they are compatibility aliases, not additional product
personas.

### Current personas

#### general (default mode)
```yaml
slug: general
name: General
groups: [read]
model: deepseek/deepseek-v4-flash
reasoningEffort: low
```
A session with no explicit `--mode`/`/mode` starts here — `activeMode` is
never left `undefined` at startup (`src/cli.tsx`); a resumed session's last
mode wins over this default, and an explicit `--mode` wins over both.
Headless (`nib -p`, `src/exec-runner.ts`) resolves the same default: an
unrecognized `--mode` still exits 1 with the "unknown mode" message, and a
valid explicit `--mode` gates tools to its own groups instead.

#### code
```yaml
slug: code
name: Code
groups: [read, edit, command, workflow]
```

Code includes the workflow group so delegation is an automatic capability of
implementation work rather than a separate picker mode. Debugging behavior is
also handled within Code's normal implementation persona.

### Legacy compatibility aliases

#### ask (hidden from the picker/listAll — reachable via `/mode ask`)
```yaml
slug: ask
name: Ask
groups: [read]
hidden: true
```

#### architect
```yaml
slug: architect
name: Architect
groups: [read, edit]
fileRegex: "\\.(md|yaml|yml|json|txt)$"
hidden: true
```

Architect is a hidden compatibility alias for existing sessions and explicit
`/mode architect` switches; it is not shown in the picker.

#### debug
```yaml
slug: debug
name: Debug
groups: [read, edit, command]
hidden: true
```

Debug is a hidden compatibility alias. Code handles debugging as part of its
normal implementation behavior.

#### orchestrator
```yaml
slug: orchestrator
name: Orchestrator
groups: [workflow]
hidden: true
```

Orchestrator is a hidden compatibility alias. New sessions use Code's
workflow capability directly.

## 6. Resolution precedence

`ModeLoader.load(slug, projectDir?)` (`src/modes/loader.ts:74`) searches, in
order (first hit wins, results cached):

1. `./.nib/modes/<slug>.yaml` (project — only when projectDir is passed)
2. `$NIB_HOME || ~/.nib/modes/<slug>.yaml` (global)
3. `src/modes/builtin/<slug>.yaml` (built-in defaults)

Project overrides global; global overrides built-in. `listAll()` enumerates
built-in slugs only.

## 7. Custom modes

```yaml
# ~/.nib/modes/reviewer.yaml
slug: reviewer
name: PR Reviewer
roleDefinition: "You are a thorough code reviewer. Check for bugs, style violations, security issues, and performance problems."
groups: [read]
customInstructions: "Always reference line numbers. Suggest concrete fixes, not vague advice. Prioritize bugs over style."
```

## 8. Switching modes

- `/mode <slug>` — text command (with completion).
- `/modes` or **Ctrl+O** — interactive picker (↑↓ navigate, Enter switch,
  Esc close). Ctrl+O lives in PromptInput like the ⇧Tab posture cycle —
  the idle input wire routes all keystrokes through it, so chords handled
  anywhere else would be dead (see keybindings.ts notes).
- The model itself can switch via the `switch_mode` tool (tool-spec.md).
- The status bar always shows the active mode (colored dot + name) right
  next to the approval-posture indicator; it refreshes immediately on any
  switch.

## 9. Verified against

`src/modes/loader.ts` (ModeConfig, load, listAll) · `src/modes/builtin/*.yaml`
(the two visible built-ins plus hidden compatibility aliases) · `src/tools/types.ts` (ToolGroup) · `src/cli.tsx`
(mode → tool-filter wiring, default mode) · `src/exec-runner.ts` (headless
mode → tool-filter wiring, default mode)
