// How often the UI is allowed to repaint.
//
// Every tick of these timers dirties part of the frame and makes Ink write to
// the terminal, so they are a direct throttle on repaint traffic. Fast
// emulators (iTerm, Terminal.app, Alacritty) coalesce writes and the cost is
// invisible. Slower ones — notably IntelliJ's embedded terminal — paint each
// write, so a high refresh rate reads as continuous flicker.
//
// Measured over 1.5s of simulated streaming (transcript growing, active line
// changing, indicator animating), with incremental rendering already on:
//
//   profile        flush  indicator   writes   bytes
//   fast (was)      50ms       80ms      125    6.1KB
//   balanced       100ms      160ms       71    2.5KB
//   slow           150ms      200ms       47    1.4KB
//
// "balanced" is the default: 2.4x less traffic than before, and the indicator
// still advances 6.3 times a second — above 4 steps/sec, the minimum we chose
// as a budget for the animation still reading as motion (a design choice,
// not a measured perceptual constant).
//
// 2026-08-06: the numbers above predate the <Static> migration (see
// OutputArea.tsx and FOLLOWUPS.md §0). Committed transcript lines now flush
// once into terminal scrollback and are never repainted, so the live region
// these profiles were tuned against has shrunk to ~6 rows (streaming tail,
// composer, status, hints) — these profiles may be retirable, or at least
// re-measurable at much higher default rates, but that hasn't been measured
// yet. Values unchanged pending that measurement.

export type RefreshProfile = {
  /** Interval for draining queued output lines into the transcript. */
  flushMs: number;
  /** Interval for committing the streaming active line to the rendered frame. */
  activeLineMs: number;
  /** Interval for advancing the working indicator. */
  indicatorMs: number;
};

const PROFILES: Record<string, RefreshProfile> = {
  // For terminals that coalesce writes well. Smoothest, most traffic.
  fast: { flushMs: 50, activeLineMs: 50, indicatorMs: 80 },
  // Default. Halves the traffic with no perceptible loss of smoothness.
  balanced: { flushMs: 100, activeLineMs: 100, indicatorMs: 160 },
  // For emulators that paint every write (IntelliJ, some SSH sessions, tmux
  // over a slow link). Streaming text arrives in visible chunks rather than
  // continuously, which is the tradeoff for a stable frame. flushMs and
  // activeLineMs also delay committed content — tool results and echoes —
  // by up to 150ms, but those timers only fire while there's content to
  // flush, so during a turn the indicator's timer is the sole one that runs
  // unconditionally.
  slow: { flushMs: 150, activeLineMs: 150, indicatorMs: 200 },
};

const DEFAULT_PROFILE = "balanced";

export type RefreshSource = "config" | "env" | "default";

export type ResolvedRefresh = RefreshProfile & {
  /** Which profile is active, for display. */
  name: string;
  /** Where the value came from, so `/doctor` can say. */
  source: RefreshSource;
  /** The raw value that was not understood, if any. */
  invalid?: string;
};

/**
 * Resolve the active refresh profile.
 *
 * Precedence: settings.json `refresh` > `NIB_REFRESH` > default.
 *
 * Config wins because it is the deliberate, per-project choice that travels
 * with the repo; the env var stays as a per-invocation override for trying a
 * profile without editing a file. An unrecognised env value falls back rather
 * than throwing — a typo in a shell export should not stop the CLI starting —
 * whereas an unrecognised settings.json value is a validation error, since the
 * user edited config deliberately and expects it to apply.
 */
export function resolveRefreshProfile(
  env: NodeJS.ProcessEnv = process.env,
  configured?: string,
): ResolvedRefresh {
  const fromConfig = (configured ?? "").trim().toLowerCase();
  if (fromConfig && PROFILES[fromConfig]) {
    return { ...PROFILES[fromConfig], name: fromConfig, source: "config" };
  }

  const raw = (env.NIB_REFRESH ?? "").trim();
  const fromEnv = raw.toLowerCase();
  if (fromEnv && PROFILES[fromEnv]) {
    return { ...PROFILES[fromEnv], name: fromEnv, source: "env" };
  }

  return {
    ...PROFILES[DEFAULT_PROFILE],
    name: DEFAULT_PROFILE,
    source: "default",
    ...(raw ? { invalid: raw } : {}),
  };
}

/** The profile names a user can select, for help text and validation. */
export const REFRESH_PROFILE_NAMES = Object.keys(PROFILES);

/** Describe where a resolved refresh profile came from, for `/doctor` and `nib doctor`. */
export function describeRefreshSource(r: ResolvedRefresh): string {
  return r.source === "config"
    ? "(from settings.json)"
    : r.source === "env"
      ? "(from NIB_REFRESH)"
      : r.invalid
        ? `(NIB_REFRESH="${r.invalid}" not recognised — using default)`
        : "(default)";
}
