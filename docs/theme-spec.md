# Theme Spec

**Status:** current · verified 2026-08-13 · covers `src/ui/theme.ts`, `src/ui/components/ThemeDropdown/` · open items: none

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
  `src/ui/HintBar.test.tsx` key-cap contrast regression.
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

## 4. Rejected approaches

- PR #132's thinner 13-token `ThemeTokens` model and `resolver.ts` —
  explicitly rejected: Nib's model is strictly richer and already
  integrated.

## 5. Known minor issues

- `src/ui/views/AskUserQuestionPrompt.tsx:152` — `focused === "other" ?
  "cyan" : "cyan"` is a no-op ternary (both branches identical); the
  focused state was meant to change the border color. Unverified whether
  fixed since discovery.

## 6. Verified against

`src/ui/theme.ts` (slots, presets, detectSystemThemeFrom) ·
`src/ui/components/ThemeDropdown/index.tsx` (picker, persistThemeChoice) ·
`src/ui/App.tsx:1007,1695` (dropdown wiring) · `src/cli.tsx:485`
(resolveTheme call)
