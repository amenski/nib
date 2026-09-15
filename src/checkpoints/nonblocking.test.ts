import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The 2026-08-06 stall profile (NIB_PROFILE=1 on a real session) caught
 * execSync inside the checkpoint manager blocking the main thread for 475ms —
 * the surviving cause of the FOLLOWUPS §0 freeze after the render amplifiers
 * were eliminated. Mid-turn checkpoint saves froze the working indicator and
 * queued keystrokes: "stalls mid-chat, won't take input, then catches up."
 *
 * Same guard style as ui/git-poll-nonblocking.test.ts, which protects the
 * identical fix made to the git-status poll on 2026-08-04. The checkpoint
 * manager was the organ that check never covered.
 */
describe("checkpoint manager stays off the main thread", () => {
  const src = readFileSync(join(process.cwd(), "src", "checkpoints", "index.ts"), "utf-8");

  it("does not CALL execSync (or any *Sync spawn) anywhere", () => {
    // Matches call sites only — the module's comments legitimately name
    // execSync when explaining why it was removed.
    expect(src).not.toMatch(/\b(?:execSync|spawnSync|execFileSync)\s*\(/);
  });

  it("invokes git through execFile with an args array, never a shell string", () => {
    // The shell-string path also carried an injection surface: the commit
    // message derives from raw prompt text, and quoting handled `"` but not
    // `$(…)` or backticks. An argv array has no shell to inject into.
    expect(src).toContain('execFileAsync(\n      "git"');
    expect(src).not.toMatch(/execFileAsync\(\s*`/);
  });
});
