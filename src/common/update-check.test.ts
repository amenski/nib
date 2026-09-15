import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { STATE_DIR_NAME } from "../config/paths.js";

// Regression coverage for the 2026-08-06 incident: this package is
// `private: true` and has never been published to npm, but the update
// checker queried the registry by name regardless — and the registry name it
// asked about (this project's own name at the time, `heirloom`) belongs to an
// unrelated photo-backup package, v0.3.0. Renaming to `nib` did not remove
// that trap: npm's `nib` is a stranger's Stylus-library package. These tests
// verify that a private packageInfo makes both entry points complete
// no-ops, and clears any pending entry a prior buggy run may have left
// on disk.

describe("update-check — private package gate", () => {
  let fakeHome: string;
  let spawnSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), "nib-update-check-"));
    spawnSpy = vi.fn();
  });

  afterEach(() => {
    rmSync(fakeHome, { recursive: true, force: true });
    vi.doUnmock("node:os");
    vi.doUnmock("node:child_process");
    vi.resetModules();
  });

  async function load() {
    vi.resetModules();
    vi.doMock("node:os", async (importOriginal) => {
      const original = await importOriginal<typeof import("node:os")>();
      return { ...original, homedir: () => fakeHome };
    });
    vi.doMock("node:child_process", async (importOriginal) => {
      const original = await importOriginal<typeof import("node:child_process")>();
      return { ...original, spawn: spawnSpy };
    });
    return await import("./update-check.js");
  }

  // The state dir under the mocked homedir — not a project dir. Resolved from
  // the constant rather than spelled out so it tracks the state dir's name.
  function stateFile() {
    return join(fakeHome, STATE_DIR_NAME, "update-check.json");
  }

  it("checkForNpmUpdate: private package never spawns npm view (no registry fetch)", async () => {
    const { checkForNpmUpdate } = await load();
    await checkForNpmUpdate({ name: "nib", version: "0.1.0", private: true });
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it("promptForPendingUpdate: private package with a stored pending entry does not prompt and clears the entry", async () => {
    mkdirSync(join(fakeHome, STATE_DIR_NAME), { recursive: true });
    writeFileSync(
      stateFile(),
      JSON.stringify({ ignoredVersions: [], pending: { version: "0.3.0", checkedAt: new Date().toISOString() } }),
      "utf-8",
    );

    const { promptForPendingUpdate, readUpdateState } = await load();
    await promptForPendingUpdate({ name: "nib", version: "0.1.0", private: true });

    // No render/spawn side effects (render() would need `ink`, but since we
    // never reach it, spawn — used by the install handler — must also be untouched).
    expect(spawnSpy).not.toHaveBeenCalled();

    const state = await readUpdateState();
    expect(state.pending).toBeNull();
    // Asserted on the raw file too: if the code read a different path, the
    // entry above would still be sitting here and the check above would pass
    // on an absent file rather than a cleared one.
    expect(JSON.parse(readFileSync(stateFile(), "utf-8")).pending).toBeNull();
  });

  it("checkForNpmUpdate: non-private package still queries the registry (existing behavior unchanged)", async () => {
    spawnSpy.mockImplementation(() => {
      const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter };
      child.stdout = new EventEmitter();
      setImmediate(() => {
        child.stdout.emit("data", Buffer.from('"9.9.9"'));
        child.emit("close", 0);
      });
      return child;
    });

    const { checkForNpmUpdate, readUpdateState } = await load();
    await checkForNpmUpdate({ name: "nib", version: "0.1.0", private: false });

    expect(spawnSpy).toHaveBeenCalledWith(
      "npm",
      ["view", "nib", "dist-tags.latest", "--json"],
      expect.anything(),
    );
    const state = await readUpdateState();
    expect(state.pending?.version).toBe("9.9.9");
  });
});
