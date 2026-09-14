# Skill Specification

**Status:** current · verified 2026-08-13 · covers `src/skills/{index,trust}.ts`

## 1. Overview

Skills are instruction packages loaded on demand (progressive disclosure).
The file format is the cross-tool **Agent Skills** standard (SKILL.md + YAML
frontmatter, agentskills.io) — heirloom reads the standard directories
directly, so skills installed for any other agent work here unchanged.

## 2. Search paths & precedence

| Order | Path | What |
|-------|------|------|
| 1 | `.heirloom/skills/<name>/SKILL.md` | Project, heirloom-native |
| 2 | `.agents/skills/<name>/SKILL.md` | Project, cross-tool standard |
| 3 | `~/.heirloom/skills/<name>/SKILL.md` | Global, heirloom-native |
| 4 | `~/.agents/skills/<name>/SKILL.md` | Global, cross-tool standard |

Name collisions: first hit wins — project beats global, heirloom-native
beats standard. The heirloom dirs exist for overrides and heirloom-only
skills; most skills should live in the standard dirs where every tool can
share them.

## 3. Installing skills

Heirloom ships **no installer** — the ecosystem already has one:

```
npx skills add <owner/repo>
```

installs into `~/.agents/skills/` and maintains `.skill-lock.json` (source
repo, content hash, install date). Heirloom treats the lock file as opaque
— it's the installer's concern — and simply reads SKILL.md folders. Manual
install = create the folder and write SKILL.md.

## 4. Format

```markdown
---
name: my-skill
description: One sentence covering what this skill does and when to trigger it.
  Front-load concrete keywords the user might say.
mode: code            # Optional, heirloom extension: only offered in this mode
---

# Skill Body

Instructions, examples, and references — returned to the model when the
skill is loaded.
```

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Lowercase, hyphen-separated, max 64 chars. Must match folder name. |
| `description` | Yes | What the skill does AND when to trigger. Third person. Front-load trigger keywords. |
| `mode` | No | Heirloom extension: restrict to a specific mode. Other tools ignore it. |

**Unknown frontmatter fields are ignored** (`license`, `metadata`,
`allowed-tools`, …). Required for reading standard skills, which carry
fields heirloom doesn't use.

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
content (full sha256) into `~/.heirloom/skill-trust.json` and classify it
`new | changed | trusted`. The store follows the hooks-trust hygiene: mode
0600, atomic tmp+rename writes, HEIRLOOM_HOME honored, keyed by the
realpath'd source path, storing only `{ path, hash, firstSeen, lastChanged,
trusted }` — never the content.

- **Global user skills** (`~/.heirloom/skills`, `~/.agents/skills`) are the
  user's own — trusted implicitly, never asked about and never written to
  the store (the same global-vs-project split hooks-spec §6 chose).
- **Project skills** (`.heirloom/skills`, `.agents/skills`) run TOFU: an
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
| `/skills` | List available skills: name, description, source path |
| `/skill <name>` | Force-load a skill and **start a turn immediately**, bypassing model discretion |

`/skill` pushes the skill body into history as a user message
(`buildSkillLoadMessage`, marker `[skill: <name>]`), then starts a turn with
`SKILL_APPLY_PROMPT` so the model applies it in that same turn. Loading into
history without starting a turn left the skill inert until the user asked
again — the model reads history only when a turn runs. The synthetic prompt is
not echoed into the transcript as a user message (it was never typed). An
unknown name, or a skill already loaded this conversation, starts no turn.

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
