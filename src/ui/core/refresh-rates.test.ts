import { describe, it, expect } from "vitest";
import { resolveRefreshProfile, REFRESH_PROFILE_NAMES, describeRefreshSource } from "./refresh-rates.js";

/**
 * These intervals are the only throttle on how often the UI writes to the
 * terminal. Measured over 1.5s of simulated streaming with incremental
 * rendering already enabled: the old fixed rates produced 125 writes / 6.1KB,
 * the default profile produces 71 / 2.5KB, and the slow profile 47 / 1.4KB.
 * On an emulator that paints every write (IntelliJ's terminal) that difference
 * is the difference between usable and not.
 */
describe("resolveRefreshProfile", () => {
  it("defaults to balanced when nothing is set", () => {
    const p = resolveRefreshProfile({});
    expect(p.flushMs).toBe(100);
    expect(p.activeLineMs).toBe(100);
    expect(p.indicatorMs).toBe(160);
  });

  it("selects a named profile", () => {
    expect(resolveRefreshProfile({ NIB_REFRESH: "slow" }).indicatorMs).toBe(200);
    expect(resolveRefreshProfile({ NIB_REFRESH: "fast" }).indicatorMs).toBe(80);
  });

  it("is case- and whitespace-insensitive", () => {
    expect(resolveRefreshProfile({ NIB_REFRESH: "  SLOW " }).flushMs).toBe(150);
  });

  it("falls back to the default on an unknown value rather than throwing", () => {
    // A typo in an env var must not stop the CLI from starting.
    expect(resolveRefreshProfile({ NIB_REFRESH: "quick" }).flushMs).toBe(100);
    expect(resolveRefreshProfile({ NIB_REFRESH: "" }).flushMs).toBe(100);
  });

  it("orders the profiles from most to least traffic", () => {
    const fast = resolveRefreshProfile({ NIB_REFRESH: "fast" });
    const balanced = resolveRefreshProfile({});
    const slow = resolveRefreshProfile({ NIB_REFRESH: "slow" });
    for (const key of ["flushMs", "activeLineMs", "indicatorMs"] as const) {
      expect(fast[key], `${key} should ascend fast < balanced < slow`).toBeLessThan(balanced[key]);
      expect(balanced[key], `${key} should ascend fast < balanced < slow`).toBeLessThan(slow[key]);
    }
  });

  it("keeps every indicator rate above the chosen minimum step rate", () => {
    // 4 steps/sec is a design budget we chose, not a measured perceptual
    // floor: below it we judged the indicator reads as intermittent flicker
    // rather than movement, which defeats the point of having one.
    for (const name of REFRESH_PROFILE_NAMES) {
      const { indicatorMs } = resolveRefreshProfile({ NIB_REFRESH: name });
      const stepsPerSecond = 1000 / indicatorMs;
      expect(stepsPerSecond, `${name} indicator is too slow to read as motion`)
        .toBeGreaterThanOrEqual(4);
    }
  });

  it("reports an unrecognised env value rather than silently ignoring it", () => {
    // The intervals fall back to the default (a typo must not stop the CLI
    // starting), but the raw value is carried through so /doctor can say the
    // setting was not understood.
    const typo = resolveRefreshProfile({ NIB_REFRESH: "slowww" });
    const fallback = resolveRefreshProfile({});
    expect(typo.flushMs).toBe(fallback.flushMs);
    expect(typo.indicatorMs).toBe(fallback.indicatorMs);
    expect(typo.source).toBe("default");
    expect(typo.invalid).toBe("slowww");
    expect(fallback.invalid).toBeUndefined();
  });

  it("prefers settings.json over the environment variable", () => {
    // Config is the deliberate, per-project choice and travels with the repo;
    // the env var is a per-invocation override for trying a profile.
    const r = resolveRefreshProfile({ NIB_REFRESH: "fast" }, "slow");
    expect(r.name).toBe("slow");
    expect(r.source).toBe("config");
  });

  it("falls back to the env var when config is absent or unknown", () => {
    expect(resolveRefreshProfile({ NIB_REFRESH: "slow" }, undefined).source).toBe("env");
    expect(resolveRefreshProfile({ NIB_REFRESH: "slow" }, "bogus").source).toBe("env");
  });

  it("labels the default so /doctor can distinguish it from an explicit choice", () => {
    expect(resolveRefreshProfile({}).source).toBe("default");
    expect(resolveRefreshProfile({}, "balanced").source).toBe("config");
  });

  it("exposes its profile names for help text", () => {
    expect(REFRESH_PROFILE_NAMES).toEqual(["fast", "balanced", "slow"]);
  });
});

describe("describeRefreshSource", () => {
  it("labels a config-sourced profile", () => {
    const r = resolveRefreshProfile({}, "slow");
    expect(describeRefreshSource(r)).toBe("(from settings.json)");
  });

  it("labels an env-sourced profile", () => {
    const r = resolveRefreshProfile({ NIB_REFRESH: "fast" });
    expect(describeRefreshSource(r)).toBe("(from NIB_REFRESH)");
  });

  it("names the unrecognised value when the env var wasn't understood", () => {
    const r = resolveRefreshProfile({ NIB_REFRESH: "slowww" });
    expect(describeRefreshSource(r)).toBe('(NIB_REFRESH="slowww" not recognised — using default)');
  });

  it("labels a plain default with no env or config involved", () => {
    const r = resolveRefreshProfile({});
    expect(describeRefreshSource(r)).toBe("(default)");
  });
});
