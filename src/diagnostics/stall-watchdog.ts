// Measures event-loop stalls directly rather than inferring them from render
// cost. FOLLOWUPS.md §0: three code-reading diagnoses of the "Working…"
// freeze were wrong, so this is measurement, not another guess — a 20ms
// timer that watches its own lateness, backed by a CPU profiler when one is
// available, so a >=150ms stall can be traced to the actual blocking frame.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveHome } from "../config/loader.js";

export type StallEvent = { at: number; lagMs: number };

export type StallReport = {
  count: number;
  worstLagMs: number;
  events: StallEvent[];
  profilePath: string | null;
};

const MAX_EVENTS = 1000;

function defaultProfileDir(): string {
  return join(resolveHome(), "profiles");
}

export function startStallWatchdog(opts?: {
  thresholdMs?: number;
  intervalMs?: number;
  profileDir?: string;
}): { getStallCount(): number; stop(): Promise<StallReport> } {
  const thresholdMs = opts?.thresholdMs ?? 150;
  const intervalMs = opts?.intervalMs ?? 20;
  const profileDir = opts?.profileDir ?? defaultProfileDir();

  const events: StallEvent[] = [];
  let worstLagMs = 0;
  let lastTick = Date.now();

  const timer = setInterval(() => {
    const now = Date.now();
    const lag = now - lastTick - intervalMs;
    lastTick = now;
    if (lag >= thresholdMs) {
      if (lag > worstLagMs) worstLagMs = lag;
      events.push({ at: now, lagMs: lag });
      if (events.length > MAX_EVENTS) events.shift();
    }
  }, intervalMs);
  timer.unref();

  // Profiling degrades gracefully: node:inspector's Session.connect() throws
  // inside worker threads (exactly where vitest runs), and a stall watchdog
  // must never crash or block the app it is trying to observe.
  let session: any = null;
  let profilingActive = false;
  let profilingSetup: Promise<void> = Promise.resolve();

  try {
    profilingSetup = (async () => {
      const inspector = await import("node:inspector");
      const s = new inspector.Session();
      s.connect();
      await new Promise<void>((resolve, reject) => {
        s.post("Profiler.enable", (err: Error | null) => (err ? reject(err) : resolve()));
      });
      await new Promise<void>((resolve, reject) => {
        s.post("Profiler.setSamplingInterval", { interval: 1000 }, (err: Error | null) =>
          err ? reject(err) : resolve(),
        );
      });
      await new Promise<void>((resolve, reject) => {
        s.post("Profiler.start", (err: Error | null) => (err ? reject(err) : resolve()));
      });
      session = s;
      profilingActive = true;
    })().catch(() => {
      session = null;
      profilingActive = false;
    });
  } catch {
    session = null;
    profilingActive = false;
    profilingSetup = Promise.resolve();
  }

  return {
    getStallCount(): number {
      return events.length;
    },
    async stop(): Promise<StallReport> {
      clearInterval(timer);
      await profilingSetup;

      let profilePath: string | null = null;
      if (profilingActive && session) {
        try {
          const profile = await new Promise<any>((resolve, reject) => {
            session.post("Profiler.stop", (err: Error | null, result: any) =>
              err ? reject(err) : resolve(result.profile),
            );
          });
          mkdirSync(profileDir, { recursive: true });
          const stamp = new Date().toISOString().replace(/[:.]/g, "-");
          const base = join(profileDir, `stall-${stamp}`);
          writeFileSync(`${base}.cpuprofile`, JSON.stringify(profile));
          writeFileSync(`${base}.stalls.jsonl`, events.map((e) => JSON.stringify(e) + "\n").join(""));
          profilePath = `${base}.cpuprofile`;
        } catch {
          profilePath = null;
        }
      }

      return {
        count: events.length,
        worstLagMs,
        events,
        profilePath,
      };
    },
  };
}
