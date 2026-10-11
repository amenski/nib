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
import { useTheme, useTerminalInfo } from "./contexts.js";
import { ansi256 } from "./theme.js";
import { USER_ECHO_TAG, COMMAND_ECHO_TAG, BULLET_TAG, ANSWER_CONT_TAG, VERBATIM_TAG, TOOL_HEADER_TAG, TOOL_RESULT_TAG, TOOL_RESULT_GUTTER, ANSWER_BULLET, PROMPT_CHEVRON } from "./constants.js";
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
  // Columns this line may occupy, for the table sizing inside MarkdownText: a
  // gutter line (below) sits two columns in, so it gets two fewer.
  const columns = useTerminalInfo().columns;

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
  // A later line of the same answer block (ANSWER_CONT_TAG) gets the same
  // two-column gutter, blank instead of "●", so the block reads as one column.
  const hasBullet = untagged.startsWith(BULLET_TAG);
  const isCont = !hasBullet && untagged.startsWith(ANSWER_CONT_TAG);
  const body = hasBullet ? untagged.slice(BULLET_TAG.length) : isCont ? untagged.slice(ANSWER_CONT_TAG.length) : untagged;
  // Progressive disclosure is for untagged bulk output only (a long tool
  // result or job line). An assistant answer never collapses: Claude Code shows
  // the whole answer, and a collapsed fence hid the text the user actually
  // asked for behind a "▼ N lines" footer (reported 2026-10-11).
  const summary = useMemo(
    () => (verbatim || hasBullet || isCont ? null : needsSummary(body)),
    [body, verbatim, hasBullet, isCont],
  );

  // A tool-call header (TOOL_HEADER_TAG) is pre-styled text: a dim glyph, a
  // bold name, plain arguments. It must NOT pass through MarkdownText — its
  // arguments are shell/path text where an inline marker is literal, so a glob
  // pattern was being italicised away as an emphasis span.
  if (untagged.startsWith(TOOL_HEADER_TAG)) {
    return <Text>{untagged.slice(TOOL_HEADER_TAG.length)}</Text>;
  }

  // A tool-result preview: the fixed gutter sits in its own box so a line wider
  // than the terminal wraps inside the text box and hangs under the text. The
  // colour escape that wraps the whole line is re-opened on the body.
  if (untagged.startsWith(TOOL_RESULT_TAG)) {
    const text = untagged.slice(TOOL_RESULT_TAG.length);
    const m = text.match(new RegExp(`^((?:\\x1b\\[[0-9;]*m)*)([\\s\\S]{${TOOL_RESULT_GUTTER}})([\\s\\S]*)$`));
    if (!m) return <Text>{text}</Text>;
    const [, open, gutter, rest] = m;
    return (
      <Box>
        <Box width={TOOL_RESULT_GUTTER} flexShrink={0}>
          <Text>{`${open}${gutter}\x1b[0m`}</Text>
        </Box>
        <Text>{`${open}${rest}`}</Text>
      </Box>
    );
  }

  if (hasBullet || isCont) {
    // Fixed two columns that never shrink: as a plain flex child, a long
    // paragraph beside it made the layout shrink the gutter to one column, so
    // some paragraphs (and wrapped list rows) sat at column 1 and others at 2.
    // The dot itself is the default text colour (Claude Code's answer marker),
    // with the platform's own glyph.
    const bulletEl = (
      <Box width={2} flexShrink={0}>
        <Text color={theme.colorEnabled ? ansi256(theme.theme.text) : undefined}>
          {hasBullet ? `${ANSWER_BULLET} ` : "  "}
        </Text>
      </Box>
    );
    return (
      <Box>
        {bulletEl}
        <MarkdownText theme={theme} width={columns - 2}>{body}</MarkdownText>
      </Box>
    );
  }

  // A user-echo line (tagged with USER_ECHO_TAG) renders as a dim "❯" then the
  // text in the terminal's own colour, with no background fill (the owner
  // dropped the grey user-message fill 2026-10-11: it filled only behind the
  // text, so wrapped rows and blank lines looked ragged). No foreground is set
  // either, so the text reads on a light terminal as well as a dark one.
  if (untagged.startsWith(USER_ECHO_TAG)) {
    // Draw the row on every line rather than flattening the message: the echo
    // must show what was actually submitted, newlines included. A verbatim
    // (replayed) echo is exempt from formatEcho's own line/char caps for the
    // same reason it is exempt from needsSummary — it is restored history, not
    // a live paste that might bury the transcript. Later lines are indented two
    // columns so the text block lines up under the first line's text.
    const { lines: msgLines, truncated } = verbatim
      ? formatEcho(untagged.slice(USER_ECHO_TAG.length), Infinity, Infinity)
      : formatEcho(untagged.slice(USER_ECHO_TAG.length));
    const dimFg = theme.colorEnabled ? ansi256(theme.theme.textDim) : undefined;
    return (
      <Box flexDirection="column">
        {msgLines.map((msg, i) => (
          <Box key={i}>
            <Box width={2} flexShrink={0}>
              <Text color={dimFg}>{i === 0 ? `${PROMPT_CHEVRON} ` : "  "}</Text>
            </Box>
            <Text>{msg}</Text>
          </Box>
        ))}
        {truncated !== null && (
          <Box>
            <Box width={2} flexShrink={0}>
              <Text>{"  "}</Text>
            </Box>
            <Text color={dimFg}>{truncated}</Text>
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
          <Text key={i} color={theme.colorEnabled ? ansi256(theme.theme.textDim) : undefined}>{i === 0 ? `› ${msg}` : `  ${msg}`}</Text>
        ))}
        {truncated !== null && <Text color={theme.colorEnabled ? ansi256(theme.theme.textDim) : undefined}>{`  ${truncated}`}</Text>}
      </Box>
    );
  }

  if (summary) {
    return (
      <Box flexDirection="column">
        <MarkdownText theme={theme} width={columns}>{summarizeText(untagged)}</MarkdownText>
        <Text color={theme.colorEnabled ? ansi256(theme.theme.textDim) : undefined}>{summary}</Text>
      </Box>
    );
  }

  return <MarkdownText theme={theme} width={columns}>{untagged}</MarkdownText>;
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
