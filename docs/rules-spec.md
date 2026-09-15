# Hierarchical project rules

**Status:** current · verified 2026-08-13 · covers `loadProjectRules` / `loadProjectResearch` in `src/prompt.ts`

## 1. Overview

Scoped, user-authored rule files recursively loaded from
`.nib/rules/**/*.md` and injected into the system prompt. Additive to
the single-file `.nib/instructions.md` / `AGENTS.md` mechanism — it
does not replace it.

Implemented by `loadProjectRules(projectDir)` in `src/prompt.ts`, called
from `buildStablePreamble` immediately after the project-instructions
section (so rules land in the cacheable prefix, before the skills index).

## 2. Format

Each `*.md` file under `.nib/rules/` becomes one section:

```
### Rule: <scope>
<trimmed file content>
```

All sections are grouped under a single `# Project Rules` header. If the
rules directory is absent, empty, or yields no usable content, no block is
emitted (the loader returns `null`).

## 3. Scoping

The `<scope>` is the file's path relative to the rules directory, with the
`.md` suffix removed and path separators normalized to `/`:

| File | Scope |
| ---- | ----- |
| `.nib/rules/style.md` | `style` |
| `.nib/rules/api/naming.md` | `api/naming` |
| `.nib/rules/db/schema.md` | `db/schema` |

## 4. Ordering

Deterministic (byte-stable, required for prompt caching). Within every
directory:

1. Files before subdirectories.
2. Alphabetical (locale compare) within each group.
3. Directories recursed depth-first, in the same file-then-dir order.

## 5. Caps

Total assembled rule content is capped at **20 KB** (`MAX_RULES_BYTES`).
Once a section would push the total over the cap, it and all remaining
sections are dropped and a truncation note is appended:

```
*(Project rules truncated: size cap reached.)*
```

## 6. Trust model

Rule content is treated as **user-authored**, at the same trust level as
`.nib/instructions.md`. It carries no new attack surface beyond what
the existing instructions file already grants.

Hardening: a `*.md` entry whose real path (after resolving symlinks) falls
**outside** `projectDir` is skipped, so a symlink inside `.nib/rules/`
cannot pull arbitrary files from elsewhere on disk into the prompt. Empty
and unreadable files (including dangling symlinks) are silently skipped.

## 7. Plan-mode research notes

A sibling of the rules loader for prior investigation notes. Markdown files
are recursively loaded from `.nib/research/**/*.md` and injected
**only in plan mode**, so planning is grounded in existing research.

Implemented by `loadProjectResearch(projectDir)` in `src/prompt.ts` (shares
the walk / symlink-escape / truncation logic with `loadProjectRules`),
called from `buildVolatileContext` when `planMode` is set — research
therefore lands in the per-turn volatile context, not the stable preamble.

Format: same mechanics, different heading:

```
# Research Notes

### Note: <scope>
<trimmed file content>
```

`<scope>` is the path relative to `.nib/research/`, `.md` stripped,
separators normalized to `/`. Ordering and trust model match the rules
loader. Total research content is capped at **8 KB**
(`MAX_RESEARCH_BYTES`) with the same truncate-with-note behavior.

## 8. Why volatile, not stable

Research is a plan-mode-only aid: it must not pollute the cacheable stable
prefix, and notes edited on disk should appear on the next plan-mode turn
without a session restart. The volatile context is re-read from disk per
turn at the interactive bridge (`src/cli.tsx`), so new notes show up
immediately.
