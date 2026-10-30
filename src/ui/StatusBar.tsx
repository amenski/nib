/**
 * Nib StatusBar — the session status line, the last row of the frame.
 *
 * Segments are built by the caller (see buildStatusBar in cli.tsx) and
 * typically include: active mode/posture, context usage (meter + %), and
 * session cost on the left; effort level and the active model on the right
 * (`align: "right"`). This component adds gitStatus, the running-job count
 * and the optional session timer to the left group, and owns the frame's only
 * animation: a spinner slot at the very start of the row.
 *
 * All colors are theme-driven via ThemeContext.
 */

import React, { useState, useEffect, useMemo, memo } from "react";
import { Box, Text } from "ink";
import type { StatusSegment, GitStatus } from "./types.js";
import { useTheme, useTerminalInfo, useRefresh } from "./contexts.js";
import { ansiFg, ANSI_RESET, ANSI } from "./theme.js";

interface StatusBarProps {
  segments: StatusSegment[];
  /** Optional git status to display */
  gitStatus?: GitStatus | null;
  /** Running background jobs; shown after git, only while at least one runs */
  runningJobs?: number;
  /** True while a turn or compaction runs: animates the leading spinner slot. */
  working?: boolean;
  /** Whether to show the session timer */
  showTimer?: boolean;
  /** Unix timestamp when the session started (ms) */
  sessionStart?: number;
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
/** Glyph + space, reserved whether or not it animates so nothing shifts. */
const SPINNER_SLOT = 2;

/**
 * Format elapsed time as HH:MM:SS.
 */
function formatElapsed(startMs: number, nowMs: number): string {
  const elapsed = Math.floor((nowMs - startMs) / 1000);
  const hours = Math.floor(elapsed / 3600);
  const minutes = Math.floor((elapsed % 3600) / 60);
  const seconds = elapsed % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function formatElapsedShort(startMs: number, nowMs: number): string {
  const elapsed = Math.floor((nowMs - startMs) / 1000);
  const hours = Math.floor(elapsed / 3600);
  const minutes = Math.floor((elapsed % 3600) / 60);
  const seconds = elapsed % 60;

  if (hours > 0) {
    return `${hours}h${minutes}m`;
  }
  return `${minutes}m${seconds}s`;
}

/**
 * Build a git status indicator string.
 */
function gitStatusString(
  git: GitStatus,
  paint?: { colorEnabled: boolean; added: number; deleted: number; conflict: number; dimFg?: number },
): string {
  const parts: string[] = [];
  // Diff counts follow the convention every other tool uses \u2014 additions green,
  // deletions red \u2014 so the row is scannable without reading the symbols. Only
  // the counts are coloured; the branch and ahead/behind stay dim, since a
  // dirty tree is the normal working state and shouldn't read as an alarm.
  const paintFg = (code: number, s: string) =>
    paint?.colorEnabled
      ? `${ansiFg(code)}${s}${ANSI_RESET}${paint.dimFg !== undefined ? ansiFg(paint.dimFg) : ""}`
      : s;

  // Branch name
  parts.push(git.branch);

  // Dirty indicator
  if (git.dirty) {
    const indicators: string[] = [];
    if (git.modified > 0) indicators.push(`~${git.modified}`);
    if (git.added > 0) indicators.push(paintFg(paint?.added ?? 0, `+${git.added}`));
    if (git.deleted > 0) indicators.push(paintFg(paint?.deleted ?? 0, `-${git.deleted}`));
    if (git.staged > 0) indicators.push(`\u25CF${git.staged}`);
    if (git.conflicts > 0) indicators.push(paintFg(paint?.conflict ?? 0, `!${git.conflicts}`));
    // Spaced rather than run together: "~5 +4 -3" reads as three counts,
    // "~5+4-3" reads as one token.
    if (indicators.length > 0) parts.push(indicators.join(" "));
  }

  // Ahead/behind
  if (git.ahead > 0 && git.behind > 0) {
    parts.push(`\u2191${git.ahead}\u2193${git.behind}`);
  } else if (git.ahead > 0) {
    parts.push(`\u2191${git.ahead}`);
  } else if (git.behind > 0) {
    parts.push(`\u2193${git.behind}`);
  }

  return parts.join(" ");
}

function StatusBar({
  segments,
  gitStatus,
  runningJobs = 0,
  working = false,
  showTimer = false,
  sessionStart,
}: StatusBarProps) {
  const theme = useTheme();
  const term = useTerminalInfo();
  const [now, setNow] = useState(Date.now());
  const [frame, setFrame] = useState(0);
  // Advances on the shared refresh cadence so all repaint timers move together.
  const TICK_MS = useRefresh().indicatorMs;

  // The frame is LOCAL state: a tick re-renders only this row, never App's
  // subtree (which would re-lay-out the whole transcript 12.5x/second — the
  // original "Working…" freeze).
  useEffect(() => {
    if (!working) return;
    setFrame(0);
    const timer = setInterval(() => setFrame((f) => f + 1), TICK_MS);
    return () => clearInterval(timer);
  }, [working, TICK_MS]);

  // Update timer every second
  useEffect(() => {
    if (!showTimer || !sessionStart) return;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [showTimer, sessionStart]);

  // No segments + no git status + no timer + no tokens = nothing to show
  if (segments.length === 0 && !gitStatus && !showTimer && !working) return null;

  const t = theme.theme.statusBar;
  const dim = (s: string) => theme.fg(theme.theme.textDim, s);
  const fg = (c: number, s: string) => (theme.colorEnabled ? `\x1b[38;5;${c}m${s}\x1b[0m` : s);

  // ansi256 codes for named colors used by config-driven statusline providers.
  const NAMED_ANSI256: Record<string, number> = {
    cyan: 51, green: 46, blue: 39, magenta: 201, white: 231, gray: 244, grey: 244,
  };

  // Build the full status string from segments
  const segmentTexts = segments.map((seg) => {
    let text = seg.text;

    // Pre-rendered ANSI (chips, meters) passes through: re-wrapping it would
    // nest escapes and clobber its embedded background runs.
    if (seg.raw) return text;

    if (t && theme.colorEnabled) {
      if (seg.color === "red") {
        text = fg(t.errorFg, text);
      } else if (seg.color === "yellow") {
        text = fg(t.warningFg, text);
      } else if (seg.color && seg.color in NAMED_ANSI256) {
        text = fg(NAMED_ANSI256[seg.color], text);
      } else if (seg.bold) {
        text = fg(t.modelFg, text);
      } else if (seg.dimColor) {
        text = dim(text);
      }
    }

    return text;
  });

  const sep = dim(" · ");
  const leftTexts = segmentTexts.filter((_, i) => segments[i].align !== "right");
  const statusLine = leftTexts.join(sep);
  const rightStr = segmentTexts.filter((_, i) => segments[i].align === "right").join(sep);

  // Git status (if available). Joined with the same "·" separator as everything
  // else — a bare space made it read as a continuation of the preceding segment
  // ("high main ~4+4-3" looked like one value). Dim overall, with only the diff
  // counts carrying colour: a dirty worktree is the normal state while working,
  // so colouring the whole thing cried wolf.
  let gitStr = "";
  if (gitStatus) {
    // `sep` is already dim-wrapped; dim the git text separately rather than
    // wrapping the pair, which would nest escape sequences.
    // Explicit 256-colour diff greens/reds rather than theme.success/error,
    // which are low ANSI (2/1) and get remapped by each terminal's palette —
    // the counts would not match the rest of the 256-colour chrome. These are
    // conventional diff colours, not theme accents, so pinning them is right.
    gitStr = sep + dim(gitStatusString(gitStatus, {
      colorEnabled: theme.colorEnabled,
      added: ANSI.lime,
      deleted: ANSI.coral,
      conflict: ANSI.coral,
      dimFg: theme.theme.textDim,
    }));
  }

  // Last in the left group: it appears and disappears, so anywhere earlier it
  // would shift the stable items sideways.
  const jobsStr = runningJobs > 0 ? sep + dim(`${runningJobs} ${runningJobs === 1 ? "job" : "jobs"}`) : "";

  // Session timer — adaptive format based on duration
  let timerStr = "";
  if (showTimer && sessionStart) {
    const elapsed = now - sessionStart;
    if (elapsed > 3600000) {
      // Over an hour: show HH:MM:SS
      timerStr = dim(` ${formatElapsed(sessionStart, now)}`);
    } else {
      timerStr = dim(` ${formatElapsedShort(sessionStart, now)}`);
    }
  }

  // A single status line (no extra horizontal rule \u2014 the input box above already
  // provides the visual divider). Fixed trailing info (git/jobs/timer) is
  // always kept; the mode/posture/ctx/cost segments fill the remaining width,
  // and any that don't fit are dropped behind an ellipsis. The right group is
  // only shown when the whole left group fits with a gap to spare.
  const cleanLen = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").length;
  const sepLen = cleanLen(sep);
  const maxWidth = Math.max(term.columns - 1, 10);
  const fixedLen = cleanLen(gitStr) + cleanLen(jobsStr) + cleanLen(timerStr);

  const segBudget = maxWidth - SPINNER_SLOT - fixedLen;
  const fullSegLen = cleanLen(statusLine);

  let segmentBody: string;
  if (fullSegLen <= segBudget) {
    segmentBody = statusLine;
  } else {
    const kept: string[] = [];
    let used = 0;
    const ellipsisLen = 2; // "\u2026"
    for (const segText of leftTexts) {
      const len = cleanLen(segText);
      const addLen = (kept.length > 0 ? sepLen : 0) + len;
      if (used + addLen + sepLen + ellipsisLen <= segBudget) {
        kept.push(segText);
        used += addLen;
      } else {
        break;
      }
    }
    segmentBody = kept.length > 0 ? `${kept.join(sep)}${dim(" \u2026")}` : dim("\u2026");
  }

  // Full-intensity accent so the animation reads at a glance against the dim row.
  const glyph = SPINNER_FRAMES[frame % SPINNER_FRAMES.length];
  const spinner = working
    ? (theme.colorEnabled ? `${ansiFg(theme.theme.accent)}${glyph}${ANSI_RESET}` : glyph) + " "
    : " ".repeat(SPINNER_SLOT);
  const left = `${spinner}${segmentBody}${gitStr}${jobsStr}${timerStr}`;
  const gap = maxWidth - cleanLen(left) - cleanLen(rightStr);
  const body = rightStr && gap >= 2 ? left + " ".repeat(gap) + rightStr : left;

  return (
    <Box>
      <Text>{body}</Text>
    </Box>
  );
}

export default memo(StatusBar);
