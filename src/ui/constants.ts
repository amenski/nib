export const ARGS_SEPARATOR = " | ";
export const ANSI_CLEAR_SCREEN = "[2J[3J[H";
export const PROMPT_PREFIX_WIDTH = 2;
/**
 * Sentinel prefixed onto an echoed user message so OutputArea renders it as a
 * full-width highlighted bar (grey background + "›" chevron), the way Claude
 * Code marks user input. Uses non-printing control chars that never occur in
 * real message text.
 */
export const USER_ECHO_TAG = "\u0001\u0003";

/**
 * Sentinel prefixed onto an echoed slash command (e.g. "/model", "/compact") so
 * OutputArea renders it as a lightweight dim "\u203a" line rather than the
 * highlighted prompt bar. Commands never call the model, so this echo is purely
 * a visible record of what was typed \u2014 it is not counted toward context usage.
 */
export const COMMAND_ECHO_TAG = "\u0001\u0004";

/**
 * Sentinel prefixed onto the first committed line of an assistant answer block
 * so OutputArea renders the dim bullet as its own element beside
 * <MarkdownText>, instead of the raw markdown line being string-prefixed with
 * the bullet. Block-level markdown (headings, lists, blockquotes) is anchored
 * at the start of the line, so prepending the bullet directly defeated that
 * parsing (e.g. a heading line no longer matched the heading regex).
 */
export const BULLET_TAG = "\u0001\u0005";

/**
 * Sentinel prefixed onto every LATER committed line of an assistant answer
 * block (the first carries BULLET_TAG). OutputArea renders it behind a
 * two-column gutter so the block's paragraphs, and their wrapped rows, line up
 * under the text after "● " instead of starting at column 0 — which made a
 * wrapped sentence look like a stray line break. Not BEL (\u0007): raw display
 * mode writes committed lines, tags included, straight to the terminal.
 */
export const ANSWER_CONT_TAG = "\u0001\u0002";

/**
 * Sentinel prefixed onto a committed line to mark it "verbatim" -- never run
 * through OutputArea's progressive-disclosure summarizer (needsSummary /
 * summarizeText). Progressive disclosure is right for a huge tool result
 * streaming by mid-turn, but wrong for a resumed transcript: the user asked
 * to reload their own prior conversation and it must come back intact, not
 * truncated to a stub. buildReplayLines (src/ui/core/replay.ts) prefixes
 * every line it produces with this tag. It composes with the other tags --
 * always placed outermost (first), so OutputArea strips it before detecting
 * USER_ECHO_TAG / COMMAND_ECHO_TAG / BULLET_TAG underneath.
 */
export const VERBATIM_TAG = "\u0001\u0006";
