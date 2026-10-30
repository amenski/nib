# Theme Spec

**Status:** current · verified 2026-10-10 · covers `src/ui/theme.ts`, `src/ui/components/ThemeDropdown/` · open items: 2 fixed-hex islands (§5)

## 0. Current state (2026-10-11)

**One built-in theme: `dark`, Claude Code's dark palette (256-colour).** The
other presets (`light`, `high-contrast`, `dracula`, `monokai`, `github-*`,
`ansi-*`) were removed and the `/theme` command is hidden: it is not in
`BUILTIN_SLASH_COMMANDS`, the help overlay or the README, and `App` no longer
handles it. `ThemeDropdown` stays in the tree, dormant. `resolveTheme` still
accepts any saved `theme.mode`/`theme.name` and falls back to `dark`, so an
old settings file keeps working. Sections 2 and 3 below describe the
multi-preset design that existed before this and are kept for history.
Exact Claude Code RGB would need truecolor, which macOS Terminal.app lacks, so
the palette stays 256-colour.

## 1. Overview

Nib's theme system lives in `src/ui/theme.ts`: a fully offline,
config-driven color engine with ~20 semantic slots, a 19-color
`SyntaxColors` set, and a `statusBar` sub-palette — richer than most
terminal-CLI theme systems. Colors are 8-bit ANSI codes (0–255) for broad
terminal compatibility, exposed to Ink components through a
`ThemeContextValue` + `useTheme` context.

Config: the `theme` key (`theme.mode: dark | light | auto`, `theme.name`,
`theme.overrides`) is parsed by the loader; `resolveTheme(config)` returns
the resolved `ThemeDefinition`, shallow-merging any overrides. Named
presets take precedence over `mode`; an unrecognized `theme.mode` string is
treated as `theme.name`. `cli.tsx:485` passes mode + name + overrides
through to `resolveTheme` at startup.

## 2. Runtime theming — shipped

- **`/theme` command** — the ThemeDropdown picker with **live preview** and
  Esc-to-revert (`src/ui/components/ThemeDropdown/`, opened at
  `src/ui/App.tsx:1007`), persisting the choice to settings on confirm
  (`persistThemeChoice`).
- **System-theme detection** — `detectSystemThemeFrom(deps)` with injectable
  deps (`src/ui/theme.ts:870`): `COLORFGBG` terminal hint first, then macOS
  `AppleInterfaceStyle` — real detection, no longer an always-dark stub.
- **Extra presets** — `dracula`, `monokai`, `github-dark`, `github-light`
  added to `BUILTIN_THEMES` as full `ThemeDefinition` objects (all ~20
  semantic slots + 19-color `SyntaxColors` + `statusBar` sub-palette),
  faithful ANSI-256 approximations with the tuned promptFg/accent contrast
  convention.
- **ANSI base-16 presets** — `ansi-dark`/`ansi-light` (F1, shipped
  2026-08-03): "dumb-terminal" variants of dark/light restricting every slot
  to the 8+8 basic ANSI codes (0–15) — no 256-color, no truecolor — with
  syntax colors mapped to base colors and bright variants for emphasis
  (`src/ui/theme.ts`). The `/theme` picker lists them automatically (it
  enumerates `BUILTIN_THEMES`), and both resolve by name in
  `resolveTheme`. Verified: `src/ui/theme.test.ts` registration + resolve
  tests, `src/ui/components/ThemeDropdown/index.test.ts` picker adoption,
  `src/ui/theme.test.ts` key-cap contrast regression.
- **Accepted limitation (decided 2026-08-13):** a theme change applies to
  new output and the live frame only. Already-flushed scrollback keeps the
  colors baked in at push time until `/clear` or restart — `<Static>` is
  flush-once by design (the input-stall fix) and ANSI codes are pre-baked
  into committed line strings. See feature-plans.md §8.

## 3. Gutter & prompt contrast

Several user-facing accents were hardcoded truecolor hex that bypassed the
theme, so they couldn't adapt to the terminal's background (Ink renders hex
as 24-bit truecolor — a literal RGB the terminal shows verbatim; **a single
fixed color cannot be legible on both a white and a black background**).

Decision (shipped 2026-08-01): route the gutter `▌` and ask/permission
accents through theme semantic slots (`promptFg`/`accent`), with distinct
high-contrast values per theme — bright blue `▌` on dark, deep
blue/indigo `▌` on light. Status colors (error/warn/success) source from
`theme.error/warning/success`. `NO_COLOR` / non-TTY still degrades to no
color via the `colorEnabled` gate.

**Faint text swept the same way (2026-10-10).** Ink's `dimColor` prop emits
SGR 2, which most terminals render as a barely-readable grey, and several side
screens also used fixed ANSI named colors (`"cyan"`, `"yellow"`, …). Every
`src/ui` component now renders those through theme slots: `dimColor` →
`color={ansi256(theme.theme.textDim)}`, raw `\x1b[2m` → `theme.fg(textDim, …)`,
named colors → their slot (cyan→`secondary`, yellow→`warning`, red→`error`,
green→`success`, magenta→`accent`), including `<Box borderColor>` values.
Rendered tables follow the same reasoning (2026-10-10): only the box-drawing
characters take `textDim`, so the cells keep normal contrast — dimming the
whole table made its content hard to read. `MarkdownTable` colors exactly the
characters it draws as borders (`Object.values(BOX)`), which is also why a cell
can never pick up the dim by accident.
Deliberately unchanged: the no-theme fallbacks in `MarkdownText`/`MarkdownTable`
(they render without a theme on purpose) and the non-component producers
(`ui/types.ts` `StatusSegment.dimColor`, `ui/core/task-status.ts`), whose data
field is still resolved through the themed renderer in `StatusBar`.

## 4. Rejected approaches

- PR #132's thinner 13-token `ThemeTokens` model and `resolver.ts` —
  explicitly rejected: Nib's model is strictly richer and already
  integrated.

## 5. Known minor issues

- **Fixed truecolor hex remains in two places** (not converted by the
  2026-10-10 sweep, which covered named ANSI colors only): the
  `DECISION_COLOR` map in `src/ui/views/PermissionHistoryList.tsx:17` (~10
  hex values — red/green/amber/cyan reads) and
  `src/ui/components/ThemeDropdown/index.tsx:175` (`activeColor="#229ac3"`).
  §3's argument applies to both: a fixed RGB cannot be legible on a white and
  a black background. They map cleanly onto `error`/`success`/`warning`/
  `secondary` if the semantic palette is not wanted as-is.
- `src/ui/views/AskUserQuestionPrompt.tsx` — the `focused === "other" ? "cyan"
  : "cyan"` no-op ternary recorded here is now fixed (the focused border uses
  the accent slot, the unfocused one the normal border color).

## 6. Verified against

`src/ui/theme.ts` (slots, presets, detectSystemThemeFrom) ·
`src/ui/components/ThemeDropdown/index.tsx` (picker, persistThemeChoice) ·
`src/ui/App.tsx:1007,1695` (dropdown wiring) · `src/cli.tsx:485`
(resolveTheme call)
