/**
 * Nib Theme System
 *
 * Fully offline, config-driven color scheme engine.
 * Supports light, dark, and custom themes with 20+ semantic color slots.
 * All colors use 8-bit ANSI codes (0-255) for maximum terminal compatibility.
 *
 * No external dependencies — pure TypeScript.
 */

import { execSync } from "node:child_process";

// ── ANSI 8-bit color palette helpers ──

/** Named ANSI 8-bit colors for easy reference. */
export const ANSI: Record<string, number> = {
  // Standard 16
  black: 0,
  red: 1,
  green: 2,
  yellow: 3,
  blue: 4,
  magenta: 5,
  cyan: 6,
  white: 7,
  brightBlack: 8,
  brightRed: 9,
  brightGreen: 10,
  brightYellow: 11,
  brightBlue: 12,
  brightMagenta: 13,
  brightCyan: 14,
  brightWhite: 15,

  // Extended greys
  grey0: 16,
  grey7: 232,
  grey15: 233,
  grey23: 234,
  grey31: 235,
  grey39: 236,
  grey47: 237,
  grey55: 238,
  grey63: 239,
  grey71: 240,
  grey79: 241,
  grey87: 242,
  grey95: 243,
  grey103: 244,
  grey111: 245,
  grey119: 246,
  grey127: 247,
  grey135: 248,
  grey143: 249,
  grey151: 250,
  grey159: 251,
  grey167: 252,
  grey175: 253,
  grey183: 254,
  grey191: 255,

  // Common semantic aliases
  orange: 208,
  purple: 93,
  pink: 205,
  teal: 37,
  coral: 203,
  gold: 220,
  lime: 154,
  sky: 117,
  indigo: 63,
  rose: 175,
};

export type AnsiColor = number | string;

export interface HexColor {
  r: number;
  g: number;
  b: number;
}

/** Convert an ANSI 8-bit code to a dimmed version (lower luminance). */
export function dimAnsi(code: number): number {
  // For bright colors (8-15), map to their dim counterparts
  if (code >= 8 && code <= 15) return code - 8;
  // For grey tones, darken by moving toward 0
  if (code >= 232) return Math.max(232, code - 8);
  // For regular colors, use a dimmer variant
  return code;
}

/** Apply ANSI escape codes for foreground color. */
export function ansiFg(code: number): string {
  return `\x1b[38;5;${code}m`;
}

/** Apply ANSI escape codes for background color. */
export function ansiBg(code: number): string {
  return `\x1b[48;5;${code}m`;
}

/** Reset ANSI formatting. */
export const ANSI_RESET = "\x1b[0m";

/**
 * Bridge an ANSI 8-bit theme slot (0–255) to an Ink `<Text color>` string.
 * Ink parses `ansi256(N)` and routes it to `chalk.ansi256(N)` — this is the
 * canonical way to feed a numeric theme slot into a `color` prop.
 */
export function ansi256(code: number): string {
  return `ansi256(${code})`;
}

/**
 * Apply ANSI codes to text for a given color code.
 * Respects NO_COLOR environment variable.
 */
export function colorize(text: string, fg?: number, bg?: number, bold = false): string {
  if (!process.stdout.isTTY || process.env.NO_COLOR) return text;
  let codes = "";
  if (bold) codes += "\x1b[1m";
  if (fg !== undefined) codes += ansiFg(fg);
  if (bg !== undefined) codes += ansiBg(bg);
  if (!codes) return text;
  return `${codes}${text}${ANSI_RESET}`;
}

// ── Semantic Theme Definition ──

export interface SyntaxColors {
  keyword: number;
  string: number;
  number: number;
  comment: number;
  type: number;
  function: number;
  variable: number;
  constant: number;
  operator: number;
  punctuation: number;
  tag: number;
  attribute: number;
  regexp: number;
  builtin: number;
  className: number;
  property: number;
  boolean: number;
  nullish: number;
  decorator: number;
}

export interface ThemeDefinition {
  /** Theme identifier */
  name: string;
  /** Base mode */
  type: "light" | "dark" | "custom";

  // ── Core UI colors ──
  primary: number;
  secondary: number;
  accent: number;
  error: number;
  warning: number;
  success: number;
  info: number;

  // ── Text colors ──
  text: number;
  textDim: number;
  textBright: number;
  textInverse: number;
  link: number;

  // ── Background / chrome ──
  background: number;
  surface: number;
  border: number;
  selection: number;

  // ── Prompt ──
  promptFg: number;
  promptBg?: number;

  // ── Status bar ──
  statusBar: {
    text: number;
    dim: number;
    background: number;
    separator: number;
    modeFg: number;
    modelFg: number;
    warningFg: number;
    errorFg: number;
  };

  // ── Syntax highlighting ──
  syntax: SyntaxColors;

  // ── Spinner ──
  spinner: number;
}

// ── Built-in themes ──

export const DARK_THEME: ThemeDefinition = {
  name: "dark",
  type: "dark",

  primary: ANSI.blue,
  secondary: ANSI.cyan,
  // accent doubles as the secondary gutter/ask emphasis — a bright blue that
  // stays legible on a black background (see theme-spec.md "Gutter & prompt
  // contrast"). Distinct from promptFg so the two accents don't collide.
  accent: 33,
  error: ANSI.red,
  warning: ANSI.orange,
  success: ANSI.green,
  info: ANSI.sky,

  text: ANSI.white,
  textDim: ANSI.grey103,
  textBright: ANSI.brightWhite,
  textInverse: ANSI.black,
  link: ANSI.sky,

  background: ANSI.black,
  surface: ANSI.grey23,
  border: ANSI.grey47,
  // Selection is used as a BACKGROUND slab, so it must be a dark tint that
  // separates from `background` while staying readable under bright text.
  // Low-ANSI blue (4) is a saturated block that swamps the row.
  selection: 24,

  // Bright blue gutter/prompt accent, readable on black.
  promptFg: 39,
  promptBg: undefined,

  statusBar: {
    text: ANSI.white,
    dim: ANSI.grey103,
    background: ANSI.grey23,
    separator: ANSI.grey55,
    modeFg: ANSI.cyan,
    modelFg: ANSI.brightWhite,
    warningFg: ANSI.orange,
    errorFg: ANSI.red,
  },

  syntax: {
    keyword: ANSI.purple,
    string: ANSI.green,
    number: ANSI.lime,
    comment: ANSI.grey111,
    type: ANSI.teal,
    function: ANSI.yellow,
    variable: ANSI.white,
    constant: ANSI.orange,
    operator: ANSI.cyan,
    punctuation: ANSI.grey135,
    tag: ANSI.red,
    attribute: ANSI.yellow,
    regexp: ANSI.coral,
    builtin: ANSI.cyan,
    className: ANSI.yellow,
    property: ANSI.sky,
    boolean: ANSI.orange,
    nullish: ANSI.grey111,
    decorator: ANSI.teal,
  },

  spinner: ANSI.cyan,
};

export const LIGHT_THEME: ThemeDefinition = {
  name: "light",
  type: "light",

  primary: ANSI.blue,
  secondary: ANSI.teal,
  // Deep indigo accent — high contrast on white, off the washed-out mid-tones
  // (see theme-spec.md "Gutter & prompt contrast"). Distinct from promptFg.
  accent: 27,
  error: ANSI.red,
  warning: ANSI.orange,
  success: ANSI.green,
  info: ANSI.blue,

  text: ANSI.grey23,
  textDim: ANSI.grey111,
  textBright: ANSI.black,
  textInverse: ANSI.brightWhite,
  link: ANSI.blue,

  background: ANSI.white,
  surface: ANSI.grey191,
  border: ANSI.grey151,
  selection: 153,

  // Deep blue gutter/prompt accent — legible on white (not the old mid-cyan,
  // which washed out).
  promptFg: 26,
  promptBg: undefined,

  statusBar: {
    text: ANSI.grey23,
    dim: ANSI.grey111,
    background: ANSI.grey191,
    separator: ANSI.grey151,
    modeFg: ANSI.teal,
    modelFg: ANSI.black,
    warningFg: ANSI.orange,
    errorFg: ANSI.red,
  },

  syntax: {
    keyword: ANSI.purple,
    string: ANSI.green,
    number: ANSI.lime,
    comment: ANSI.grey111,
    type: ANSI.teal,
    function: ANSI.blue,
    variable: ANSI.grey23,
    constant: ANSI.orange,
    operator: ANSI.cyan,
    punctuation: ANSI.grey87,
    tag: ANSI.red,
    attribute: ANSI.blue,
    regexp: ANSI.coral,
    builtin: ANSI.teal,
    className: ANSI.blue,
    property: ANSI.sky,
    boolean: ANSI.orange,
    nullish: ANSI.grey111,
    decorator: ANSI.teal,
  },

  spinner: ANSI.blue,
};

export const HIGH_CONTRAST_THEME: ThemeDefinition = {
  name: "high-contrast",
  type: "custom",

  primary: ANSI.brightCyan,
  secondary: ANSI.brightGreen,
  accent: ANSI.brightYellow,
  error: ANSI.brightRed,
  warning: ANSI.brightYellow,
  success: ANSI.brightGreen,
  info: ANSI.brightCyan,

  text: ANSI.brightWhite,
  textDim: ANSI.brightBlack,
  textBright: ANSI.brightWhite,
  textInverse: ANSI.black,
  link: ANSI.brightCyan,

  background: ANSI.black,
  surface: ANSI.grey15,
  border: ANSI.grey31,
  selection: 25,

  promptFg: ANSI.brightCyan,
  promptBg: undefined,

  statusBar: {
    text: ANSI.brightWhite,
    dim: ANSI.brightBlack,
    background: ANSI.grey15,
    separator: ANSI.grey55,
    modeFg: ANSI.brightCyan,
    modelFg: ANSI.brightWhite,
    warningFg: ANSI.brightYellow,
    errorFg: ANSI.brightRed,
  },

  syntax: {
    keyword: ANSI.brightMagenta,
    string: ANSI.brightGreen,
    number: ANSI.brightYellow,
    comment: ANSI.brightBlack,
    type: ANSI.brightCyan,
    function: ANSI.brightYellow,
    variable: ANSI.brightWhite,
    constant: ANSI.brightYellow,
    operator: ANSI.brightCyan,
    punctuation: ANSI.grey135,
    tag: ANSI.brightRed,
    attribute: ANSI.brightYellow,
    regexp: ANSI.brightRed,
    builtin: ANSI.brightCyan,
    className: ANSI.brightYellow,
    property: ANSI.brightCyan,
    boolean: ANSI.brightYellow,
    nullish: ANSI.grey111,
    decorator: ANSI.brightCyan,
  },

  spinner: ANSI.brightCyan,
};

// ── Extra presets ──
//
// Faithful ANSI-256 approximations of popular editor themes, re-expressed in
// Nib's rich ThemeDefinition shape (all ~20 semantic slots + 19-color
// SyntaxColors + statusBar sub-palette). promptFg/accent follow the tuned
// contrast convention: dark presets use bright accents readable on their dark
// background; the light preset uses a deep blue (like LIGHT_THEME) legible on
// white. accent stays distinct from promptFg so the two accents don't collide.

export const DRACULA_THEME: ThemeDefinition = {
  name: "dracula",
  type: "dark",

  primary: 141, // purple (#bd93f9)
  secondary: 117, // cyan (#8be9fd)
  // Bright pink accent, vivid on the dark surface.
  accent: 212, // pink (#ff79c6)
  error: 203, // red (#ff5555)
  warning: 215, // orange (#ffb86c)
  success: 84, // green (#50fa7b)
  info: 117, // cyan (#8be9fd)

  text: 253, // foreground (#f8f8f2)
  textDim: 103, // comment (#6272a4)
  textBright: 231, // near-white (#f8f8f2)
  textInverse: 236, // background (#282a36)
  link: 117,

  background: 236, // #282a36
  surface: 237, // current line (#44475a) approx
  // border doubles as the chip fill, so it needs real separation from the page
  // (Dracula's own "current line" tone) rather than sitting 3 steps away.
  border: 245,
  selection: 60, // #44475a — the canonical Dracula selection

  // Bright cyan gutter/prompt accent, readable on the dark purple-grey bg.
  promptFg: 117,
  promptBg: undefined,

  statusBar: {
    text: 253,
    dim: 103,
    background: 237,
    separator: 239,
    modeFg: 141,
    modelFg: 231,
    warningFg: 215,
    errorFg: 203,
  },

  syntax: {
    keyword: 212, // pink
    string: 228, // yellow (#f1fa8c)
    number: 141, // purple
    comment: 103, // #6272a4
    type: 117, // cyan
    function: 84, // green
    variable: 253, // foreground
    constant: 141, // purple
    operator: 212, // pink
    punctuation: 253,
    tag: 212, // pink
    attribute: 84, // green
    regexp: 203, // red
    builtin: 117, // cyan
    className: 117, // cyan
    property: 84, // green
    boolean: 141, // purple
    nullish: 141,
    decorator: 84, // green
  },

  spinner: 141,
};

export const MONOKAI_THEME: ThemeDefinition = {
  name: "monokai",
  type: "dark",

  primary: 197, // pink/red (#f92672)
  secondary: 81, // cyan (#66d9ef)
  // Bright orange accent, vivid on the dark bg.
  accent: 208, // orange (#fd971f)
  error: 197, // #f92672
  warning: 208, // #fd971f
  success: 148, // green (#a6e22e)
  info: 81, // cyan (#66d9ef)

  text: 253, // foreground (#f8f8f2)
  textDim: 102, // comment (#75715e)
  textBright: 231,
  textInverse: 235, // background (#272822)
  link: 81,

  background: 235, // #272822
  surface: 236,
  // border doubles as the chip fill and needs real separation from the page.
  border: 244,
  selection: 58, // #49483e

  // Bright cyan gutter/prompt accent, readable on the dark olive-grey bg.
  promptFg: 81,
  promptBg: undefined,

  statusBar: {
    text: 253,
    dim: 102,
    background: 236,
    separator: 238,
    modeFg: 197,
    modelFg: 231,
    warningFg: 208,
    errorFg: 197,
  },

  syntax: {
    keyword: 197, // pink
    string: 186, // yellow (#e6db74)
    number: 141, // purple (#ae81ff)
    comment: 102, // #75715e
    type: 81, // cyan
    function: 148, // green
    variable: 253,
    constant: 141, // purple
    operator: 197, // pink
    punctuation: 253,
    tag: 197, // pink
    attribute: 148, // green
    regexp: 186,
    builtin: 81, // cyan
    className: 81, // cyan
    property: 148, // green
    boolean: 141, // purple
    nullish: 141,
    decorator: 148, // green
  },

  spinner: 197,
};

export const GITHUB_DARK_THEME: ThemeDefinition = {
  name: "github-dark",
  type: "dark",

  primary: 75, // blue (#79c0ff)
  secondary: 79, // teal/green (#39c5cf approx)
  // Bright blue accent, readable on the dark navy bg.
  accent: 75, // #79c0ff
  error: 210, // red (#ff7b72)
  warning: 215, // orange/yellow (#e3b341 approx)
  success: 114, // green (#7ee787 approx)
  info: 75, // blue

  text: 253, // foreground (#c9d1d9)
  textDim: 245, // muted (#8b949e)
  textBright: 231,
  textInverse: 234, // background (#0d1117)
  link: 75,

  background: 234, // #0d1117
  surface: 235, // #161b22
  // border doubles as the chip fill and needs real separation from the page.
  border: 243, // lifted from #30363d so chips read against the page
  selection: 24,

  // Bright blue gutter/prompt accent, legible on the near-black navy bg.
  promptFg: 75,
  promptBg: undefined,

  statusBar: {
    text: 253,
    dim: 245,
    background: 235,
    separator: 238,
    modeFg: 75,
    modelFg: 231,
    warningFg: 215,
    errorFg: 210,
  },

  syntax: {
    keyword: 210, // red (#ff7b72)
    string: 111, // light blue (#a5d6ff)
    number: 75, // blue (#79c0ff)
    comment: 245, // #8b949e
    type: 215, // orange (#ffa657)
    function: 141, // purple (#d2a8ff)
    variable: 253,
    constant: 75, // blue
    operator: 210,
    punctuation: 253,
    tag: 114, // green (#7ee787)
    attribute: 75, // blue
    regexp: 111,
    builtin: 210, // red
    className: 215, // orange
    property: 75, // blue
    boolean: 75,
    nullish: 75,
    decorator: 141, // purple
  },

  spinner: 75,
};

export const GITHUB_LIGHT_THEME: ThemeDefinition = {
  name: "github-light",
  type: "light",

  primary: 25, // blue (#0969da)
  secondary: 30, // teal (#1b7c83 approx)
  // Deep blue accent — high contrast on white (matching LIGHT_THEME's deep
  // blue convention).
  accent: 25, // #0969da
  error: 124, // red (#cf222e)
  warning: 130, // orange (#9a6700 approx)
  success: 28, // green (#1a7f37)
  info: 25, // blue

  text: 235, // foreground (#24292f)
  textDim: 243, // muted (#57606a)
  textBright: 233,
  textInverse: 231, // background (#ffffff)
  link: 25,

  background: 231, // #ffffff
  surface: 254, // #f6f8fa
  border: 250, // #d0d7de
  selection: 153, // light blue selection

  // Deep blue gutter/prompt accent — legible on white.
  promptFg: 25,
  promptBg: undefined,

  statusBar: {
    text: 235,
    dim: 243,
    background: 254,
    separator: 250,
    modeFg: 25,
    modelFg: 233,
    warningFg: 130,
    errorFg: 124,
  },

  syntax: {
    keyword: 124, // red (#cf222e)
    string: 25, // dark blue (#0a3069)
    number: 25, // blue (#0550ae)
    comment: 243, // #6e7781
    type: 130, // orange/brown (#953800)
    function: 92, // purple (#8250df)
    variable: 235,
    constant: 25, // blue
    operator: 124,
    punctuation: 235,
    tag: 28, // green (#116329)
    attribute: 25, // blue
    regexp: 30, // teal (#0a3069 approx)
    builtin: 124, // red
    className: 130, // orange
    property: 25, // blue
    boolean: 25,
    nullish: 25,
    decorator: 92, // purple
  },

  spinner: 25,
};

// ── ANSI 16-color presets ──
// "Dumb-terminal" variants that restrict every slot to the base-16 ANSI
// palette (codes 0–15). Distinct from the 8-bit presets above: these render
// faithfully on terminals with only 16-color support, at the cost of
// fidelity — greys collapse to brightBlack, syntax colors are coarse.

export const ANSI_DARK_THEME: ThemeDefinition = {
  name: "ansi-dark",
  type: "dark",

  primary: 4, // blue
  secondary: 6, // cyan
  accent: 12, // brightBlue — legible on black
  error: 1, // red
  warning: 3, // yellow
  success: 2, // green
  info: 14, // brightCyan

  text: 7, // white
  textDim: 8, // brightBlack (grey substitute)
  textBright: 15, // brightWhite
  textInverse: 0, // black
  link: 14, // brightCyan

  background: 0, // black
  surface: 0, // black
  border: 8, // brightBlack
  selection: 4, // blue

  promptFg: 12, // brightBlue
  promptBg: undefined,

  statusBar: {
    text: 7,
    dim: 8,
    background: 0,
    separator: 8,
    modeFg: 14,
    modelFg: 15,
    warningFg: 3,
    errorFg: 9,
  },

  syntax: {
    keyword: 13, // brightMagenta
    string: 2, // green
    number: 3, // yellow
    comment: 8, // brightBlack
    type: 14, // brightCyan
    function: 3, // yellow
    variable: 7, // white
    constant: 9, // brightRed
    operator: 6, // cyan
    punctuation: 8, // brightBlack
    tag: 1, // red
    attribute: 3, // yellow
    regexp: 5, // magenta
    builtin: 6, // cyan
    className: 3, // yellow
    property: 14, // brightCyan
    boolean: 9, // brightRed
    nullish: 8, // brightBlack
    decorator: 13, // brightMagenta
  },

  spinner: 6, // cyan
};

export const ANSI_LIGHT_THEME: ThemeDefinition = {
  name: "ansi-light",
  type: "light",

  primary: 4, // blue
  secondary: 6, // cyan
  accent: 4, // blue — deep accent readable on white
  error: 1, // red
  warning: 3, // yellow
  success: 2, // green
  info: 6, // cyan

  text: 0, // black
  textDim: 8, // brightBlack (grey substitute)
  textBright: 0, // black
  textInverse: 15, // brightWhite
  link: 4, // blue

  background: 15, // brightWhite
  surface: 7, // white
  border: 8, // brightBlack
  selection: 14, // brightCyan

  promptFg: 4, // blue
  promptBg: undefined,

  statusBar: {
    text: 0,
    dim: 8,
    background: 7,
    separator: 8,
    modeFg: 4,
    modelFg: 0,
    warningFg: 3,
    errorFg: 1,
  },

  syntax: {
    keyword: 5, // magenta
    string: 4, // blue
    number: 4, // blue
    comment: 8, // brightBlack
    type: 3, // yellow
    function: 5, // magenta
    variable: 0, // black
    constant: 4, // blue
    operator: 1, // red
    punctuation: 0, // black
    tag: 2, // green
    attribute: 4, // blue
    regexp: 6, // cyan
    builtin: 1, // red
    className: 3, // yellow
    property: 4, // blue
    boolean: 4,
    nullish: 4,
    decorator: 5, // magenta
  },

  spinner: 4, // blue
};

export const BUILTIN_THEMES: Record<string, ThemeDefinition> = {
  dark: DARK_THEME,
  light: LIGHT_THEME,
  "high-contrast": HIGH_CONTRAST_THEME,
  dracula: DRACULA_THEME,
  monokai: MONOKAI_THEME,
  "github-dark": GITHUB_DARK_THEME,
  "github-light": GITHUB_LIGHT_THEME,
  "ansi-dark": ANSI_DARK_THEME,
  "ansi-light": ANSI_LIGHT_THEME,
};

// ── Theme Manager ──

export interface ThemeConfig {
  mode: "dark" | "light" | "auto";
  /** Named builtin preset (e.g. "dracula"). Takes precedence over `mode`. */
  name?: string;
  overrides?: Partial<ThemeDefinition>;
  /** Override automatic color detection. Used by ThemeProvider. */
  colorEnabled?: boolean;
}

/**
 * Resolve a theme from config.
 * - `name` (a builtin preset) takes precedence when it resolves to a builtin
 * - 'auto' follows system preference via `prefers-color-scheme`
 * - Named themes resolve from builtins
 * - Overrides are shallow-merged into the base theme
 */
export function resolveTheme(config?: ThemeConfig): ThemeDefinition {
  const mode = config?.mode ?? "dark";

  let themeName: string;
  if (config?.name && BUILTIN_THEMES[config.name]) {
    // Explicit named preset wins over mode.
    themeName = config.name;
  } else if (mode === "auto") {
    // Best-effort system preference detection (no deps, no remote)
    themeName = detectSystemTheme();
  } else {
    themeName = mode;
  }

  const base = BUILTIN_THEMES[themeName] ?? DARK_THEME;

  if (!config?.overrides) return base;

  return deepMergeTheme(base, config.overrides);
}

/** Dependencies for system-theme detection, injectable for testing. */
export interface SystemThemeDeps {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  /** Runs a command and returns stdout; must throw on non-zero exit. */
  exec: (cmd: string) => string;
}

/**
 * Pure system-theme detector (no caching, no I/O of its own beyond the injected
 * `exec`). Detection order:
 *   1. COLORFGBG ("fg;bg" or "fg;x;bg") — last field 0–6 or 8 → dark, 7/15 → light.
 *   2. macOS: `defaults read -g AppleInterfaceStyle` prints "Dark" → dark;
 *      a non-zero exit (key absent) → light. Only attempted on darwin.
 *   3. Fallback: dark.
 */
export function detectSystemThemeFrom(deps: SystemThemeDeps): "dark" | "light" {
  // 1. COLORFGBG — set by many terminals to advertise fg/bg palette indices.
  const colorfgbg = deps.env.COLORFGBG;
  if (colorfgbg) {
    const parts = colorfgbg.split(";");
    const bg = parts[parts.length - 1]?.trim();
    const bgNum = Number(bg);
    if (bg !== "" && Number.isInteger(bgNum)) {
      if (bgNum === 7 || bgNum === 15) return "light";
      if ((bgNum >= 0 && bgNum <= 6) || bgNum === 8) return "dark";
      // Any other value: fall through to the next detection stage.
    }
  }

  // 2. macOS system appearance.
  if (deps.platform === "darwin") {
    try {
      const out = deps.exec("defaults read -g AppleInterfaceStyle");
      if (out.trim() === "Dark") return "dark";
      // Key present but not "Dark" — treat as light.
      return "light";
    } catch {
      // Non-zero exit means the key is absent, i.e. Light mode.
      return "light";
    }
  }

  // 3. Fallback.
  return "dark";
}

function detectSystemTheme(): "dark" | "light" {
  if (_systemThemeCache) return _systemThemeCache;

  const result = detectSystemThemeFrom({
    env: process.env,
    platform: process.platform,
    exec: (cmd) =>
      execSync(cmd, { timeout: 1000, stdio: ["ignore", "pipe", "ignore"] }).toString(),
  });

  _systemThemeCache = result;
  return result;
}

let _systemThemeCache: "dark" | "light" | null = null;

function deepMergeTheme(base: ThemeDefinition, overrides: Partial<ThemeDefinition>): ThemeDefinition {
  const result = { ...base };

  for (const key of Object.keys(overrides) as (keyof ThemeDefinition)[]) {
    const val = overrides[key];
    if (val === undefined) continue;

    if (key === "statusBar" && typeof val === "object") {
      result.statusBar = { ...result.statusBar, ...(val as any) };
    } else if (key === "syntax" && typeof val === "object") {
      result.syntax = { ...result.syntax, ...(val as any) };
    } else {
      (result as any)[key] = val;
    }
  }

  return result;
}

// ── React Context Types (used by Ink components) ──

/**
 * A resolved theme with helper methods for applying colors to text.
 * This is what components receive at runtime.
 */
export class ThemeContextValue {
  readonly theme: ThemeDefinition;
  readonly colorEnabled: boolean;

  constructor(theme: ThemeDefinition, colorEnabled?: boolean) {
    this.theme = theme;
    this.colorEnabled = colorEnabled ?? (!!process.stdout.isTTY && !process.env.NO_COLOR);
  }

  /** Format text with a foreground color from the theme. */
  fg(color: number, text: string): string {
    return this._wrap(color, undefined, false, text, false);
  }

  /** Format text with bold + foreground. */
  bold(color: number, text: string): string {
    return this._wrap(color, undefined, true, text, false);
  }

  /** Dim text. */
  dim(text: string): string {
    if (!this.colorEnabled) return text;
    return `\x1b[2m${text}\x1b[0m`;
  }

  /** Format text as dimmed foreground. */
  dimFg(color: number, text: string): string {
    return this._wrap(color, undefined, false, text, true);
  }

  /** Format text using a semantic color key from the theme. */
  semantic(key: keyof ThemeDefinition, text: string): string {
    const color = this.theme[key] as number | undefined;
    if (color === undefined) return text;
    return this.fg(color, text);
  }

  /** Format text using a syntax highlighting color. */
  syntax(key: keyof SyntaxColors, text: string): string {
    const color = this.theme.syntax[key];
    return this.fg(color, text);
  }

  private _wrap(
    fg: number | undefined,
    bg: number | undefined,
    bold: boolean,
    text: string,
    forceDim: boolean,
  ): string {
    if (!this.colorEnabled) return text;
    let codes = "";
    if (bold) codes += "\x1b[1m";
    if (forceDim) codes += "\x1b[2m";
    if (fg !== undefined) codes += ansiFg(fg);
    if (bg !== undefined) codes += ansiBg(bg);
    if (!codes) return text;
    return `${codes}${text}${ANSI_RESET}`;
  }
}

/** Default theme context value (dark). */
export function createDefaultTheme(): ThemeContextValue {
  return new ThemeContextValue(DARK_THEME);
}
