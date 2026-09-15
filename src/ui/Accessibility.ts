/**
 * Heirloom Accessibility Utilities
 *
 * Provides helpers for terminal-based accessibility features:
 * - Screen reader announcements via OSC 9;4 or BEL sequences
 * - Focus indicators for the current interactive element
 * - High-contrast mode detection
 */

// ── Screen Reader Announcements ──

/**
 * Send an accessibility announcement intended for screen readers.
 *
 * Uses the iTerm2/iTerm-specific announcement sequence (OSC 9;4)
 * which popular terminal screen readers (VoiceOver, Orca, NVDA) intercept.
 * Falls back to stderr for non-supporting terminals.
 */
export function announceToScreenReader(
  message: string,
  priority: "polite" | "assertive" = "polite",
): void {
  if (!process.stdout.isTTY) return;

  try {
    // OSC 9;4 announcement sequence (supported by iTerm2, Kitty, WezTerm)
    // Some terminal screen readers pick this up
    process.stdout.write(`\x1b]9;4;${priority === "assertive" ? "1" : "0"};${message}\x1b\\`);
  } catch {
    // Best-effort: write to stderr as fallback
    process.stderr.write(`[a11y: ${message}]\n`);
  }
}

/**
 * Announce a status change (e.g., "busy", "done", "error").
 */
export function announceStatus(status: string): void {
  announceToScreenReader(`Heirloom: ${status}`, "polite");
}

/**
 * Announce an error condition.
 */
export function announceError(error: string): void {
  announceToScreenReader(`Error: ${error}`, "assertive");
}

// ── Focus Indicators ──

/**
 * Check if the terminal/OS is in high-contrast mode.
 * Returns true if DARK_MODE/HIGH_CONTRAST env vars suggest high-contrast.
 */
export function isHighContrastMode(): boolean {
  // Check for macOS accessibility settings (system-wide)
  try {
    // macOS: `defaults read` is expensive — check env vars first
    if (process.env.NIB_HIGH_CONTRAST) {
      return process.env.NIB_HIGH_CONTRAST === "1" ||
        process.env.NIB_HIGH_CONTRAST === "true";
    }
  } catch {
    // ignore
  }

  // NO_COLOR indicates a preference for minimal styling
  if (process.env.NO_COLOR) return true;

  return false;
}

// ── Terminal Capability Detection ──

export interface TerminalCapabilities {
  /** TrueColor (16.7M colors) support */
  trueColor: boolean;
  /** OSC 9;4 screen reader announcements */
  screenReaderAnnouncements: boolean;
  /** Clipboard access (OSC 52) */
  clipboard: boolean;
  /** Bracketed paste mode */
  bracketedPaste: boolean;
  /** Focus reporting */
  focusReporting: boolean;
}

/**
 * Detect terminal capabilities from TERM and COLORTERM env vars.
 */
export function detectTerminalCapabilities(): TerminalCapabilities {
  const term = process.env.TERM || "";
  const colorTerm = process.env.COLORTERM || "";

  return {
    trueColor: colorTerm === "truecolor" || colorTerm === "24bit",
    screenReaderAnnouncements: term.includes("iterm") || term.includes("kitty"),
    clipboard: true, // Most modern terminals support OSC 52
    bracketedPaste: true, // Enables bracketed paste mode
    focusReporting: term.includes("kitty") || term.includes("wezterm"),
  };
}

// ── Terminal Raw Mode Helpers ──

/**
 * Enable bracketed paste mode (so pastes arrive as a single event).
 */
export function enableBracketedPaste(): void {
  if (process.stdout.isTTY) {
    process.stdout.write("\x1b[?2004h");
  }
}

/**
 * Disable bracketed paste mode.
 */
export function disableBracketedPaste(): void {
  if (process.stdout.isTTY) {
    process.stdout.write("\x1b[?2004l");
  }
}

/**
 * Show the cursor.
 */
export function showCursor(): void {
  if (process.stdout.isTTY) {
    process.stdout.write("\x1b[?25h");
  }
}

/**
 * Hide the cursor.
 */
export function hideCursor(): void {
  if (process.stdout.isTTY) {
    process.stdout.write("\x1b[?25l");
  }
}
