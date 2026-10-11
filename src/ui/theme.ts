/**
 * Nib Theme System
 *
 * Fully offline, config-driven color scheme engine.
 * One built-in theme (Claude Code's dark palette) with 20+ semantic color slots,
 * overridable from config.
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
  /**
   * A tool-result preview's text: quieter than `text` so it sits behind the
   * answer, but readable. `textDim` (Claude Code's `inactive` grey) was too
   * faint for output the user actually reads.
   */
  toolOutput: number;
  textBright: number;
  textInverse: number;
  link: number;

  // ── Background / chrome ──
  background: number;
  surface: number;
  border: number;
  selection: number;

  /**
   * Diff line backgrounds (Claude Code's diffAdded / diffRemoved). Used as
   * backgrounds, so they must be dark tints that separate from `background`
   * while staying readable under the diff's own foreground.
   */
  diffAddedBg: number;
  diffRemovedBg: number;

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

  // Claude Code's dark palette, each RGB mapped to its nearest xterm-256 code
  // (slots are 256-color). Source values in comments; syntax colors below are
  // nib's own — Claude Code's palette has no syntax slots.
  primary: 173, // claude orange rgb(215,119,87)
  secondary: 147, // suggestion rgb(177,185,249)
  // accent doubles as the secondary gutter/ask emphasis — Claude Code's
  // permission lavender, legible on black (see theme-spec.md "Gutter & prompt
  // contrast"). Distinct from promptFg so the two accents don't collide.
  accent: 147, // permission rgb(177,185,249)
  error: 204, // rgb(255,107,128)
  warning: 214, // rgb(255,193,7)
  success: 71, // rgb(78,186,101)
  info: 68, // ide rgb(71,130,200)

  text: 231, // rgb(255,255,255)
  textDim: 246, // inactive rgb(153,153,153)
  toolOutput: 250, // rgb(188,188,188)
  textBright: 231,
  textInverse: 16,
  link: 147, // suggestion rgb(177,185,249)

  background: 16,
  surface: 237, // userMessageBackground rgb(55,55,55)
  border: 102, // promptBorder rgb(136,136,136)
  // Selection is used as a BACKGROUND slab, so it must be a dark tint that
  // separates from `background` while staying readable under bright text.
  selection: 24, // selectionBg rgb(38,79,120)

  // Diff line backgrounds (Claude Code's diffAdded / diffRemoved).
  diffAddedBg: 22, // rgb(34,92,43)
  diffRemovedBg: 52, // rgb(122,41,54)

  // Gutter/prompt accent: Claude Code's orange, readable on black.
  promptFg: 173,
  promptBg: undefined,

  statusBar: {
    text: 231,
    dim: 246,
    background: 237,
    separator: 239, // subtle rgb(80,80,80)
    modeFg: 66, // planMode rgb(72,150,140)
    modelFg: 231,
    warningFg: 214,
    errorFg: 204,
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

  spinner: 173, // claude orange
};

/**
 * One theme for now: Claude Code's dark palette. The other presets (light,
 * high-contrast, dracula, monokai, github-*, ansi-*) were removed 2026-10-11;
 * `resolveTheme` still accepts any saved `theme.name`/`mode` and falls back to
 * `dark`, so an old settings file keeps working.
 */
export const BUILTIN_THEMES: Record<string, ThemeDefinition> = {
  dark: DARK_THEME,
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

  /**
   * Dim + italic foreground — Claude Code's completed-thinking echo. Italic is
   * an attribute, so it can only be carried by escapes (never a <Text> prop
   * here), and it is skipped entirely when colour is off.
   */
  dimItalic(color: number, text: string): string {
    if (!this.colorEnabled) return text;
    return `\x1b[2m\x1b[3m${ansiFg(color)}${text}${ANSI_RESET}`;
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
