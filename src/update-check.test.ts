import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UPDATE_CHECK_CACHE_FILENAME, UPDATE_CHECK_TTL_MS, checkForUpdate, isNewerVersion, updateNotice } from "./update-check.js";

const reply = (body: unknown, status = 200) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as unknown as typeof fetch & ReturnType<typeof vi.fn>;

describe("isNewerVersion", () => {
  it("compares numerically, not lexically", () => {
    expect(isNewerVersion("0.10.0", "0.9.0")).toBe(true);
    expect(isNewerVersion("0.6.2", "0.6.1")).toBe(true);
    expect(isNewerVersion("1.0.0", "0.99.99")).toBe(true);
    expect(isNewerVersion("0.6.1", "0.6.1")).toBe(false);
    expect(isNewerVersion("0.6.0", "0.6.1")).toBe(false);
  });

  it("counts the final release as newer than its own release candidate", () => {
    expect(isNewerVersion("0.7.0", "0.7.0-rc.1")).toBe(true);
    expect(isNewerVersion("0.6.1", "0.7.0-rc.1")).toBe(false);
  });

  it("never counts a prerelease or a malformed version", () => {
    expect(isNewerVersion("0.7.0-beta.1", "0.6.1")).toBe(false);
    expect(isNewerVersion("latest", "0.6.1")).toBe(false);
  });
});

describe("checkForUpdate", () => {
  let home: string;
  const T0 = 1_800_000_000_000;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), "nib-update-")); });
  afterEach(() => rmSync(home, { recursive: true, force: true }));
  const writeCache = (latest: string, checkedAt: number) =>
    writeFileSync(join(home, UPDATE_CHECK_CACHE_FILENAME), JSON.stringify({ latest, checkedAt }));
  const run = (fetchImpl: typeof fetch, extra: Parameters<typeof checkForUpdate>[0] = {}) =>
    checkForUpdate({ current: "0.6.1", now: () => T0, homeDir: home, fetchImpl, env: {}, ...extra });

  it("returns the notice for a newer release and caches it", async () => {
    const fetchImpl = reply({ version: "0.7.0" });
    expect(await run(fetchImpl)).toBe(updateNotice("0.7.0", "0.6.1"));
    expect(JSON.parse(readFileSync(join(home, UPDATE_CHECK_CACHE_FILENAME), "utf8"))).toEqual({ checkedAt: T0, latest: "0.7.0" });
  });

  it("says nothing when current", async () => {
    expect(await run(reply({ version: "0.6.1" }))).toBeUndefined();
  });

  it("answers from a fresh cache without a request", async () => {
    writeCache("0.8.0", T0 - 1000);
    const fetchImpl = reply({ version: "0.9.0" });
    expect(await run(fetchImpl)).toBe(updateNotice("0.8.0", "0.6.1"));
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refetches a stale cache", async () => {
    writeCache("0.6.1", T0 - UPDATE_CHECK_TTL_MS);
    const fetchImpl = reply({ version: "0.7.0" });
    expect(await run(fetchImpl)).toBe(updateNotice("0.7.0", "0.6.1"));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("falls back to the stale cache on any failure, and never throws", async () => {
    writeCache("0.7.0", T0 - UPDATE_CHECK_TTL_MS - 1);
    const offline = vi.fn(async () => { throw new Error("ENOTFOUND"); }) as unknown as typeof fetch;
    expect(await run(offline)).toBe(updateNotice("0.7.0", "0.6.1"));
    expect(await run(reply({ version: "0.9.0" }, 500))).toBe(updateNotice("0.7.0", "0.6.1"));
    rmSync(join(home, UPDATE_CHECK_CACHE_FILENAME));
    expect(await run(offline)).toBeUndefined();
  });

  it("never prints a registry value that is not a plain version", async () => {
    expect(await run(reply({ version: "9.9.9 \u001b[2K[nib] run rm -rf" }))).toBeUndefined();
    expect(await run(reply({ nope: true }))).toBeUndefined();
    const notJson = vi.fn(async () => new Response("<html>", { status: 200 })) as unknown as typeof fetch;
    expect(await run(notJson)).toBeUndefined();
  });

  it("makes no request when NIB_NO_UPDATE_CHECK is set", async () => {
    const fetchImpl = reply({ version: "0.7.0" });
    expect(await run(fetchImpl, { env: { NIB_NO_UPDATE_CHECK: "1" } })).toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
