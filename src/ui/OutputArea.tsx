/**
 * Nib OutputArea — High-performance scrolling output viewer
 *
 * Features:
 * - Static (committed) line rendering via Ink's <Static> — flushed once into
 *   native terminal scrollback, never repainted
 * - Active line streaming for in-flight content
 * - Progressive disclosure: long blocks auto-collapse with summary
 * - Theme integration via ThemeContext
 * - React.memo for performance
 */

import React, { useMemo, memo } from "react";
import { Box, Static, Text } from "ink";
import MarkdownText from "./MarkdownText.js";
import { useTheme } from "./contexts.js";
import { ansi256 } from "./theme.js";
import { USER_ECHO_TAG, COMMAND_ECHO_TAG, BULLET_TAG, VERBATIM_TAG } from "./constants.js";
import { formatEcho } from "./core/echo-format.js";
import type { TabDefinition } from "./types.js";

interface OutputAreaProps {
  /** Committed (past) output lines */
  lines: string[];
  /** Currently streaming active line */
  activeLine: string;
  /** Whether the agent is busy generating */
  busy: boolean;
  /**
   * Bumping this remounts the <Static> block, resetting its internal
   * rendered-index so previously-flushed items render again. Ink's standard
   * reset pattern for Static — used when the scrollback itself is cleared
   * (e.g. /clear, /new) and the committed lines array is reset to match.
   */
  staticEpoch: number;
  /** Active tab info (for multiplex mode) */
  tab?: TabDefinition;
}

/**
 * Check if a string is a long block that needs summarizing.
 */
function needsSummary(text: string): string | null {
  const clean = text.replace(/\x1b\[[0-9;]*m/g, "");
  const lines = clean.split("\n");
  if (lines.length > 20) {
    return `  \u25BC ${lines.length} lines`;
  }
  if (clean.length > 1000) {
    return `  \u25BC ${clean.length} chars`;
  }
  return null;
}

/**
 * Collapse a long text to a preview.
 *
 * The inline marker and the needsSummary() footer used to report two
 * different figures for the same block \u2014 the marker counted chars dropped
 * from a fixed 300-char slice, the footer reported the total length \u2014 so a
 * summarized block read as internally inconsistent (e.g. "... (1121 more
 * chars)" next to a footer saying "1421 chars" for the same text, with no
 * way to tell those numbers described the same thing). Both now cite the
 * same total, just phrased for their position: the inline marker says how
 * much is showing out of that total, the footer states the total.
 */
function summarizeText(text: string): string {
  const clean = text.replace(/\x1b\[[0-9;]*m/g, "");
  const lines = clean.split("\n");
  if (lines.length > 20) {
    return [lines[0], lines[1], "", "  ...", `  (${lines.length} lines)`, "", lines[lines.length - 1]].join(
      "\n",
    );
  }
  if (clean.length > 1000) {
    return clean.slice(0, 300) + `\n  ... (showing 300 of ${clean.length} chars)`;
  }
  return text;
}

// ── Memoized Output Line ──

const OutputLine = memo(function OutputLine({
  line,
}: {
  line: string;
}) {
  const theme = useTheme();

  // A verbatim-tagged line (tagged with VERBATIM_TAG) comes from resumed-
  // session replay (buildReplayLines) rather than live streaming. Progressive
  // disclosure — collapsing long blocks — is right for a huge tool result
  // streaming by mid-turn, where the model already saw the full text; it is
  // wrong for restored conversation, where the user explicitly asked to see
  // their own history again and truncating it destroys their only view of
  // it. VERBATIM_TAG is stripped first, ahead of the other tags, so a
  // replayed USER_ECHO_TAG or BULLET_TAG line is still detected and gets its
  // normal gutter/bullet — it just skips summarization underneath.
  const verbatim = line.startsWith(VERBATIM_TAG);
  const untagged = verbatim ? line.slice(VERBATIM_TAG.length) : line;

  // A bullet-tagged line (tagged with BULLET_TAG) marks the first line of a
  // fresh assistant answer block. The dim "●" renders as its own element
  // beside <MarkdownText> rather than being string-prepended to the markdown
  // — prepending "● " would defeat block-level markdown regexes anchored at
  // the start of the line (e.g. a heading or list item).
  const hasBullet = untagged.startsWith(BULLET_TAG);
  const body = hasBullet ? untagged.slice(BULLET_TAG.length) : untagged;
  const summary = useMemo(() => (verbatim ? null : needsSummary(body)), [body, verbatim]);

  if (hasBullet) {
    const bulletEl = <Text dimColor>{"● "}</Text>;
    if (summary) {
      return (
        <Box flexDirection="column">
          <Box>
            {bulletEl}
            <MarkdownText>{summarizeText(body)}</MarkdownText>
          </Box>
          <Text dimColor>{summary}</Text>
        </Box>
      );
    }
    return (
      <Box>
        {bulletEl}
        <MarkdownText>{body}</MarkdownText>
      </Box>
    );
  }

  // A user-echo line (tagged with USER_ECHO_TAG) renders with a blue gutter bar
  // on the left and plain text — the gutter is what marks input, so assistant
  // replies can stay plain flush-left text. (A full-width background fill was
  // tried and read as heavier/noisier, so this uses a subtle left rule instead.)
  if (untagged.startsWith(USER_ECHO_TAG)) {
    // Draw the gutter on every line rather than flattening the message: the
    // echo must show what was actually submitted, newlines included. A
    // verbatim (replayed) echo is exempt from formatEcho's own line/char caps
    // for the same reason it is exempt from needsSummary — it is restored
    // history, not a live paste that might bury the transcript.
    const { lines: msgLines, truncated } = verbatim
      ? formatEcho(untagged.slice(USER_ECHO_TAG.length), Infinity, Infinity)
      : formatEcho(untagged.slice(USER_ECHO_TAG.length));
    const gutter = theme.colorEnabled ? ansi256(theme.theme.promptFg) : undefined;
    return (
      <Box flexDirection="column">
        {msgLines.map((msg, i) => (
          <Box key={i}>
            <Text color={gutter}>{"▌ "}</Text>
            <Text>{msg}</Text>
          </Box>
        ))}
        {truncated !== null && (
          <Box>
            <Text color={gutter}>{"▌ "}</Text>
            <Text dimColor>{truncated}</Text>
          </Box>
        )}
      </Box>
    );
  }

  // A slash-command echo (tagged with COMMAND_ECHO_TAG) renders as a plain dim
  // "›" line — a lightweight record of what was typed. Unlike the user-echo bar
  // it gets no background fill, marking it as out-of-band (it makes no model
  // call and is not counted toward context usage).
  if (untagged.startsWith(COMMAND_ECHO_TAG)) {
    const { lines: msgLines, truncated } = verbatim
      ? formatEcho(untagged.slice(COMMAND_ECHO_TAG.length), Infinity, Infinity)
      : formatEcho(untagged.slice(COMMAND_ECHO_TAG.length));
    return (
      <Box flexDirection="column">
        {msgLines.map((msg, i) => (
          <Text key={i} dimColor>{i === 0 ? `› ${msg}` : `  ${msg}`}</Text>
        ))}
        {truncated !== null && <Text dimColor>{`  ${truncated}`}</Text>}
      </Box>
    );
  }

  if (summary) {
    return (
      <Box flexDirection="column">
        <MarkdownText>{summarizeText(untagged)}</MarkdownText>
        <Text dimColor>{summary}</Text>
      </Box>
    );
  }

  return <MarkdownText>{untagged}</MarkdownText>;
});

// ── Main OutputArea ──

function OutputArea({
  lines,
  activeLine,
  busy,
  staticEpoch,
}: OutputAreaProps) {
  return (
    <>
      {/* Committed lines flush ONCE into native terminal scrollback via Ink's
          <Static> and are never repainted — the transcript stops being a live
          region Ink re-lays-out every frame, which is what let per-frame cost
          scale with session length (and made slow terminal emulators tear).
          `items` is append-only so an index key is stable. Bumping
          `staticEpoch` (via the `key` prop) remounts Static and resets its
          internal rendered-index, the standard reset used when the scrollback
          itself is cleared (see App.tsx's /clear and /new handling). */}
      <Static key={staticEpoch} items={lines}>
        {(line, i) => <OutputLine key={i} line={line} />}
      </Static>

      {/* Active streaming line (carries the same gutter tag as committed output) */}
      {activeLine !== "" && !busy && <OutputLine line={activeLine} />}
    </>
  );
}

export default memo(OutputArea);
