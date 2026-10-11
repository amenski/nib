/**
 * Whether the composer must add a row of its own above itself, or whether the
 * transcript has already left that row blank.
 *
 * The gap between the transcript and the prompt box was missing for slash
 * commands. Most entries commit a trailing blank line (a message echo, the turn
 * footer, the welcome banner all end with one), but a slash-command echo does
 * not — so `/model`, `/skills` and friends sat flush against the prompt rule.
 *
 * A constant margin fixes that case and doubles the gap everywhere else: with
 * the margin applied unconditionally, a turn ended with TWO blank rows under
 * "✳ Worked for Ns" (measured in the frame, 2026-10-11). So the margin is
 * conditional — applied only when nothing above the composer has already left a
 * blank row there.
 */

export interface ComposerGapArgs {
  /**
   * True when the todo checklist (TodoPanel) or the queued-follow-up stack is
   * rendered between the transcript and the composer. Both end flush against
   * the prompt, whatever the transcript's last line did.
   */
  panelAbove: boolean;
  /**
   * True when the mid-turn live tail owns the last output row. The tail is
   * in-flight text, so it is never blank.
   */
  liveTail: boolean;
  /** The last committed transcript entry; undefined when there is none. */
  lastOutputLine: string | undefined;
}

export function needsComposerGap({
  panelAbove,
  liveTail,
  lastOutputLine,
}: ComposerGapArgs): boolean {
  if (panelAbove || liveTail) return true;
  // An empty transcript (undefined) has no blank row of its own either, so it
  // needs the margin just as a line of text does.
  return lastOutputLine !== "";
}
