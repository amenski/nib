import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureGitStatus, buildVolatileContext } from "./prompt.js";

/**
 * The environment block's git line tags each dirty file as "(pre-existing)"
 * (dirty before this session's baseline) or "(this session)" (dirtied after).
 * This needs a real git repo to exercise — the pure source-scan guard in
 * prompt.nonblocking.test.ts deliberately avoids spawning git, so the
 * behavior is pinned here instead.
 */
describe("git environment block — dirty baseline tagging", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "nib-gitenv-"));
    const git = (args: string[]) =>
      execFileSync("git", args, { cwd: dir, encoding: "utf-8", stdio: "pipe" });
    git(["init", "-q"]);
    git(["config", "user.email", "test@example.com"]);
    git(["config", "user.name", "Test"]);
    writeFileSync(join(dir, "a.txt"), "a");
    git(["add", "-A"]);
    git(["commit", "-qm", "init"]);
    // Pre-existing dirt: modified before the session baseline is captured.
    writeFileSync(join(dir, "a.txt"), "changed");
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("tags pre-existing vs this-session files", async () => {
    const baseline = await captureGitStatus(dir);
    // Agent-created during the "session": absent from the baseline.
    writeFileSync(join(dir, "b.txt"), "b");

    const out = await buildVolatileContext({ workingDir: dir, dirtyBaseline: baseline });

    expect(out).toContain("a.txt (pre-existing)");
    expect(out).toContain("b.txt (this session)");
    expect(out).toMatch(/1 pre-existing, 1 this session/);
  });
});
