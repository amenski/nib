# Skill Specification

**Status:** current · verified 2026-08-13 · covers `src/skills/{index,trust}.ts`

## 1. Overview

Skills are instruction packages loaded on demand (progressive disclosure).
The file format is the cross-tool **Agent Skills** standard (SKILL.md + YAML
frontmatter, agentskills.io) — nib reads the standard directories
directly, so skills installed for any other agent work here unchanged.

## 2. Search paths & precedence

| Order | Path | What |
|-------|------|------|
| 1 | `.nib/skills/<name>/SKILL.md` | Project, nib-native |
| 2 | `.agents/skills/<name>/SKILL.md` | Project, cross-tool standard |
| 3 | `~/.nib/skills/<name>/SKILL.md` | Global, nib-native |
| 4 | `~/.agents/skills/<name>/SKILL.md` | Global, cross-tool standard |

Name collisions: first hit wins — project beats global, nib-native
beats standard. The nib dirs exist for overrides and nib-only
skills; most skills should live in the standard dirs where every tool can
share them.

## 3. Installing skills

Nib ships **no installer** — the ecosystem already has one:

```
npx skills add <owner/repo>
```

installs into `~/.agents/skills/` and maintains `.skill-lock.json` (source
repo, content hash, install date). Nib treats the lock file as opaque
— it's the installer's concern — and simply reads SKILL.md folders. Manual
install = create the folder and write SKILL.md.

## 4. Format

```markdown
---
name: my-skill
description: One sentence covering what this skill does and when to trigger it.
  Front-load concrete keywords the user might say.
mode: code            # Optional, nib extension: only offered in this mode
---

# Skill Body

Instructions, examples, and references — returned to the model when the
skill is loaded.
```

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Lowercase, hyphen-separated, max 64 chars. Must match folder name. |
| `description` | Yes | What the skill does AND when to trigger. Third person. Front-load trigger keywords. |
| `mode` | No | Nib extension: restrict to a specific mode. Other tools ignore it. |

**Unknown frontmatter fields are ignored** (`license`, `metadata`,
`allowed-tools`, …). Required for reading standard skills, which carry
fields nib doesn't use.

## 5. Trigger mechanism

Model-driven, not keyword matching:

1. At startup, scan all four search paths and build an index.
2. The index is injected into the system prompt (system-prompt.md §2):
   one line per skill, `- <name>: <description>`. Skills with a `mode`
   field appear only in that mode's index.
3. When a request matches a skill's description, the model calls
   `load_skill(name)` (tool-spec.md); the skill body returns as tool
   output.
4. Cost of an unloaded skill: one index line (~25 tokens). Bodies never
   touch the context until loaded.

Why not the alternatives: keyword matching against the description is free
but wrong too often; a per-message LLM classification call is accurate but
adds latency and cost to every turn. Letting the model read the index and
decide reuses the existing tool machinery and is how Claude Code does it.

## 6. Trust (TOFU, security-spec T4 — fixed 2026-08-14)

`checkSkillTrust` / `trustSkill` (`src/skills/trust.ts`) hash each SKILL.md's
content (full sha256) into `~/.nib/skill-trust.json` and classify it
`new | changed | trusted`. The store follows the hooks-trust hygiene: mode
0600, atomic tmp+rename writes, NIB_HOME honored, keyed by the
realpath'd source path, storing only `{ path, hash, firstSeen, lastChanged,
trusted }` — never the content.

- **Global user skills** (`~/.nib/skills`, `~/.agents/skills`) are the
  user's own — trusted implicitly, never asked about and never written to
  the store (the same global-vs-project split hooks-spec §6 chose).
- **Project skills** (`.nib/skills`, `.agents/skills`) run TOFU: an
  unseen (`new`) or content-edited (`changed`) skill is **withheld** from
  the loaded list — its index line cannot enter the system prompt — until
  an ask-tier confirmation (`SkillTrustPrompt`, the same Promise+modal
  pattern as the hook trust ask; driven by App.tsx at startup, one modal
  per skill, before any turn). y = trust that hash forever (persisted), n =
  skip this session (nothing persisted). A content edit re-classifies as
  `changed` and re-asks even after a previous trust.
- **Headless** runs skip untrusted project skills with a stderr warning —
  fail closed, like hooks.

## 7. CLI

| Command | Behavior |
|---------|----------|
| `/skills` | List available skills: name, description, source path; picking one loads it |
| `/skill <name> [text]` | Load a skill; with `text`, run that text as the turn's prompt |

`/skill` pushes the skill body into history as a user message
(`buildSkillLoadMessage`, marker `[skill: <name>]`) and stops there. The turn
is the user's: `/skill <name> implement phase 1` runs "implement phase 1" as
the prompt, echoed like any submission. A bare `/skill <name>` starts no turn
and says so — `Skill <name> loaded — your next message will use it.` An
unknown name, or a skill already loaded this conversation, loads nothing.

It used to start a turn on its own with a synthetic `SKILL_APPLY_PROMPT`
("Apply the skill you just loaded"), which began work the user had not asked
for: in onramp on 2026-10-10 that hidden turn started the task loop on a
guessed tracker file 11 s before the user's real instruction arrived.

**During a running turn**, `/skill` is injected rather than queued or refused:
the payload (`buildSkillLoadMessage` body + any `text`) goes into the steering
mailbox, so the live turn picks the skill up at its next decision point
(`pollSteeringMessage`) and saves it with its own messages. The queue line and
the echo show the command as typed, not the body; the volatile notice only says
a message arrived (the body is already a message of its own). The `/skills`
picker routes through the same input path, so a pick mid-turn behaves exactly
like typing it.

## 8. Example

```markdown
---
name: typescript
description: Use when writing or reviewing TypeScript code. Triggers on
  "typescript", "ts", "type error", "interface", "generics".
---

# TypeScript

- Use strict mode (`strict: true` in tsconfig).
- Prefer interfaces over type aliases for object shapes.
- Use `import type` for type-only imports.
- Never use `any` — use `unknown` and narrow.
- Use `satisfies` for type-checking without widening.
```
