import { getSlashCommands } from "../core/slash-commands.js";
import { chip } from "../core/chips.js";
import type { ThemeContextValue } from "../theme.js";

const SHORTCUT_TIPS = [
  { label: "Enter", description: "Send the prompt" },
  { label: "Shift+Enter", description: "Insert a newline" },
  { label: "Esc", description: "Interrupt the current model turn" },
  { label: "/", description: "Open the slash command menu" },
  { label: "/model", description: "Select model and thinking mode" },
  { label: "/new", description: "Start a fresh conversation" },
  { label: "/resume", description: "Pick a previous session" },
  { label: "Ctrl+M", description: "Open model picker" },
  { label: "Ctrl+D twice", description: "Quit" },
];

interface WelcomeOpts {
  model: string;
  thinkingEnabled: boolean;
  reasoningEffort?: string;
  cwd: string;
}

function formatCwd(path: string): string {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const resolved = path.startsWith(home) ? "~" + path.slice(home.length) : path;
  return resolved.length > 40 ? "…" + resolved.slice(-37) : resolved;
}

/**
 * Build the session header as raw-ANSI scrollback lines.
 *
 * This used to be a component pinned above OutputArea for the whole session
 * (see App.tsx's prior "Banner stays pinned" comment). Now that committed
 * output flushes through Ink's <Static> and is written into the terminal's
 * own scrollback exactly once (see OutputArea.tsx), the banner is just the
 * first thing ever committed — ordinary scrollback content, not a special
 * pinned region. It still looks identical: a short reverse-video mark plus one
 * line of context, the design that replaced a fifteen-row ASCII banner (see
 * the history below).
 *
 * History, both problems measured rather than assumed:
 * 1. The old banner was PINNED for the whole session — not a splash you
 *    scroll past. Fifteen rows is 63% of a standard 24-row terminal,
 *    permanently unavailable to the conversation.
 * 2. The banner rendered shredded in IntelliJ's JediTerm. Measured in Figma
 *    with JetBrains Mono at 16px, the banner's actual glyphs — ASCII,
 *    block-full (█), block-half, and box-drawing (╗ ║ ╔ ═ ╝ ╚) — all advance
 *    an identical 9.625px, so font-metric drift does not explain the
 *    shredding. The likely cause is renderer-side: JediTerm probably
 *    custom-paints the box-drawing and block ranges instead of using font
 *    glyphs (unverified). A short mark sidesteps the problem regardless of
 *    its cause.
 *
 * The mark is reverse video (text on an accent slab) via the same `chip()`
 * helper used for chips in the status bar and key-caps in the hint bar, so it
 * reads as one system.
 */
export function buildWelcomeLines(theme: ThemeContextValue, opts: WelcomeOpts): string[] {
  const tips = (() => {
    const slashItems = getSlashCommands();
    return [
      ...slashItems.map((s) => ({ label: s.label, description: s.description })),
      ...SHORTCUT_TIPS.filter((t) => !slashItems.some((s) => s.label === t.label)),
    ];
  })();
  const tipIndex = tips.length > 0 ? Math.floor(Math.random() * tips.length) : 0;
  const tip = tips[Math.min(tipIndex, tips.length - 1)] ?? tips[0];

  // One line of context, in the same "·"-separated vocabulary as the status
  // bar. The model/thinking/cwd used to be a bordered three-row panel that
  // restated what the status bar already shows a few rows below.
  const thinking = opts.thinkingEnabled ? (opts.reasoningEffort ?? "on") : "off";
  const context = `${opts.model} · thinking ${thinking} · ${formatCwd(opts.cwd)}`;

  // chip() adds its own one-space padding on each side, so passing "NIB"
  // reproduces the original " NIB " reverse-video mark.
  const mark = chip("NIB", {
    fg: theme.theme.textInverse,
    bg: theme.theme.accent,
    colorEnabled: theme.colorEnabled,
  });
  const dimContext = theme.colorEnabled ? `\x1b[2m  ${context}\x1b[0m` : `  ${context}`;
  const markLine = mark + dimContext;

  const lines = ["", markLine, ""];
  if (tip) {
    const tipText = `Tip: ${tip.label} — ${tip.description}`;
    lines.push(theme.colorEnabled ? `\x1b[2m${tipText}\x1b[0m` : tipText);
  }
  lines.push("");
  return lines;
}
