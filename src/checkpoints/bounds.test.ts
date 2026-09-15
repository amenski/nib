import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, readdirSync, existsSync, mkdirSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

/**
 * Incident 2026-08-17: two sessions whose cwd was $HOME — /Users/amanuel,
 * 235 GB — left 26 GB of dead packs under ~/.heirloom/checkpoints. Neither was
 * corruption. `git add -A` over --work-tree had no bound beyond an
 * extension-based exclude list, and a repack killed mid-write stranded its
 * `tmp_pack_*` (14.5 GB and 12.4 GB) because nothing ever gc'd the shadow repo
 * to collect it. These tests pin both halves of the fix.
 */

let TEST_HOME = "";

vi.mock("node:os", async (importOriginal) => {
  const orig = await importOriginal<typeof import("node:os")>();
  return { ...orig, homedir: () => TEST_HOME };
});

describe("checkpoint resource bounds", () => {
  let workspaceDir: string;

  async function chkptManager() {
    const mod = await import("./index.js");
    return new mod.CheckpointManager("test-session", workspaceDir);
  }

  function shadowGitDir(): string {
    return join(TEST_HOME, ".nib", "checkpoints", "test-session", ".git");
  }

  // Objects on disk in the shadow repo. Zero after `git init` and before any
  // `add`, so a nonzero count is direct proof that staging happened.
  function stagedObjectCount(): number {
    const objects = join(shadowGitDir(), "objects");
    if (!existsSync(objects)) return 0;
    return readdirSync(objects)
      .filter((n) => n !== "pack" && n !== "info")
      .reduce((acc, n) => acc + readdirSync(join(objects, n)).length, 0);
  }

  beforeEach(() => {
    TEST_HOME = mkdtempSync(join(tmpdir(), "nib-bounds-home-"));
    workspaceDir = mkdtempSync(join(tmpdir(), "nib-bounds-ws-"));
    execSync("git init", { cwd: workspaceDir, stdio: "pipe" });
    writeFileSync(join(workspaceDir, "app.ts"), "console.log('hello');\n");
  });

  afterEach(() => {
    rmSync(workspaceDir, { recursive: true, force: true });
    rmSync(TEST_HOME, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("sweeps a stale tmp_pack left by a killed repack, keeping real packs", async () => {
    const mgr = await chkptManager();
    await mgr.save("first"); // initializes the shadow repo

    const packDir = join(shadowGitDir(), "objects", "pack");
    // Both shapes: the stranded temp file (mode 0444, as git leaves it) and a
    // legitimately-finished pack that must survive.
    const stale = join(packDir, "tmp_pack_ntG1qq");
    writeFileSync(stale, "dead bytes");
    chmodSync(stale, 0o444); // as git leaves it
    writeFileSync(join(packDir, "pack-abc123.pack"), "real bytes");

    // A fresh manager re-runs initialize() and must collect the residue.
    const fresh = await chkptManager();
    await fresh.save("second");

    const remaining = readdirSync(packDir);
    expect(remaining).not.toContain("tmp_pack_ntG1qq");
    expect(remaining).toContain("pack-abc123.pack");
  });

  it("leaves no temp pack behind after an ordinary checkpoint", async () => {
    const mgr = await chkptManager();
    await mgr.save("msg");

    const packDir = join(shadowGitDir(), "objects", "pack");
    if (existsSync(packDir)) {
      expect(readdirSync(packDir).filter((n) => n.startsWith("tmp_pack_"))).toEqual([]);
    }
  });

  it("still checkpoints a normally-sized workspace", async () => {
    const mgr = await chkptManager();
    const hash = await mgr.save("msg");
    expect(hash).toBeTruthy();
  });

  it("refuses to stage a workspace past the entry cap, writing no objects", async () => {
    // Past MAX_CHECKPOINT_ENTRIES. Bulk-created through one xargs rather than
    // 5001 writeFileSync calls: ~0.2s instead of several thousand syscalls.
    execSync("seq 1 5001 | xargs touch", { cwd: workspaceDir, stdio: "pipe" });

    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const mgr = await chkptManager();

    const hash = await mgr.save("msg");

    expect(hash).toBeNull();
    // The real assertion: `add -A` never ran, so no blobs exist. This is what
    // the 26 GB incident was made of.
    expect(stagedObjectCount()).toBe(0);
    expect(stderr.mock.calls.map((c) => String(c[0])).join("")).toContain("checkpoints are off");
  });

  it("warns once per session, not once per save", async () => {
    execSync("seq 1 5001 | xargs touch", { cwd: workspaceDir, stdio: "pipe" });

    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const mgr = await chkptManager();

    // tools/edit.ts saves after every write, so a per-call notice would repeat
    // on every single tool call.
    await mgr.save("a");
    await mgr.save("b");
    await mgr.save("c");

    const notices = stderr.mock.calls.filter((c) =>
      String(c[0]).includes("checkpoints are off"),
    );
    expect(notices).toHaveLength(1);
  });

  it("guards the staging bound with gc.auto=0", () => {
    // Not observable through the public API — the overrides are per-invocation
    // `-c` flags, not repo config — so the invariant is pinned at the source,
    // the same way nonblocking.test.ts pins its shape. Without it git is free
    // to repack after `commit`, which is how the stranded temp packs appeared.
    const src = readFileSync(join(process.cwd(), "src", "checkpoints", "index.ts"), "utf-8");
    expect(src).toMatch(/"-c", "gc\.auto=0"/);
  });

  it("counts untracked files inside a subdirectory, not the collapsed dir", async () => {
    // The regression this pins: default --porcelain reports an untracked
    // subdirectory as ONE line. $HOME measures 206 that way and 1,146,894 with
    // -uall, so the cap would silently never fire on the incident it guards.
    const sub = join(workspaceDir, "data");
    mkdirSync(sub);
    execSync("seq 1 5001 | xargs touch", { cwd: sub, stdio: "pipe" });

    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const mgr = await chkptManager();
    const hash = await mgr.save("msg");

    expect(hash).toBeNull();
    expect(stagedObjectCount()).toBe(0);
    expect(stderr.mock.calls.map((c) => String(c[0])).join("")).toContain("checkpoints are off");
  });
});
