import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, appendFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { resolveHome } from "../config/loader.js";

export interface CheckpointEntry {
  hash: string;
  message: string;
  timestamp: string;
}

// Explicit `-c` overrides applied to every shadow-repo git invocation so the
// checkpoint machinery never depends on — and can never be subverted by — the
// ambient global/system git config. Without an explicit identity, `git commit`
// aborts on any machine lacking a global user.name/user.email (e.g. CI), which
// silently broke checkpointing. The remaining overrides neutralize hostile or
// exotic global config that could otherwise block commits (commit.gpgsign),
// execute arbitrary code (core.hooksPath), or corrupt content (autocrlf).
const GIT_CONFIG_OVERRIDES = [
  "-c", "user.name=nib",
  "-c", "user.email=nib@local",
  "-c", "commit.gpgsign=false",
  "-c", "tag.gpgsign=false",
  "-c", "core.hooksPath=/dev/null",
  "-c", "core.autocrlf=false",
  "-c", "core.fileMode=false",
  "-c", "init.defaultBranch=main",
];

const execFileAsync = promisify(execFile);

export class CheckpointManager {
  private shadowDir: string;
  private workspaceDir: string;
  private initialized = false;
  private _lock: Promise<void> = Promise.resolve();

  constructor(sessionId: string, workspaceDir?: string, home: string = resolveHome()) {
    this.workspaceDir = resolve(workspaceDir ?? process.cwd());
    this.shadowDir = join(home, "checkpoints", sessionId);
  }

  get workspace(): string {
    return this.workspaceDir;
  }

  private async initialize(): Promise<void> {
    if (this.initialized) return;

    if (!existsSync(this.shadowDir)) {
      mkdirSync(this.shadowDir, { recursive: true });
      await execFileAsync("git", [...GIT_CONFIG_OVERRIDES, "init"], { cwd: this.shadowDir });

      const exclude = [
        ".git",
        "node_modules/",
        "*.bin", "*.exe", "*.dll", "*.so", "*.dylib",
        "*.zip", "*.tar", "*.gz", "*.7z", "*.rar",
        "*.png", "*.jpg", "*.jpeg", "*.gif", "*.ico", "*.webp",
        "*.mp3", "*.mp4", "*.avi", "*.mov",
        "*.ttf", "*.otf", "*.woff", "*.woff2",
        // Secret-adjacent backstop: excluded regardless of the workspace's own
        // .gitignore (which the shadow repo otherwise relies on via
        // --work-tree). Defense-in-depth only — this reduces but does not
        // eliminate T3 (session transcripts are still plaintext elsewhere).
        ".env", ".env.*", "*.pem", "*.key", "id_rsa", "id_rsa.*",
        "id_dsa*", "id_ecdsa*", "id_ed25519*",
        "credentials.yaml", "credentials.json",
        ".aws/**", ".ssh/**", "*.p12", "*.pfx",
        "",
      ].join("\n");

      try {
        appendFileSync(join(this.shadowDir, ".git", "info", "exclude"), exclude);
      } catch {
        // info/exclude might not exist after git init; skip silently
      }
    }

    this.initialized = true;
  }

  // Async by hard-won necessity, not style. The 2026-08-06 stall profile
  // (FOLLOWUPS §0) caught execSync here blocking the main thread for 475ms
  // during a mid-turn checkpoint — the "dots freeze / input stalls / catches
  // up" symptom that survived three earlier wrong diagnoses. Same disease the
  // git-status poll had before 08-04, in the organ nobody checked.
  //
  // execFile with an args ARRAY (no shell) also closes an injection hole the
  // shell string had: the commit message derives from raw prompt text, and the
  // old escaping handled `"` but not `$(…)` or backticks.
  private async git(args: string[]): Promise<string> {
    const { stdout } = await execFileAsync(
      "git",
      [
        ...GIT_CONFIG_OVERRIDES,
        `--work-tree=${this.workspaceDir}`,
        `--git-dir=${join(this.shadowDir, ".git")}`,
        ...args,
      ],
      { maxBuffer: 10 * 1024 * 1024 },
    );
    return stdout.trim();
  }

  private async gitSilent(args: string[]): Promise<string | null> {
    try {
      return await this.git(args);
    } catch {
      return null;
    }
  }

  async save(message?: string): Promise<string | null> {
    const prev = this._lock;
    let release: () => void;
    this._lock = new Promise<void>((r) => { release = r; });
    await prev;

    try {
      await this.initialize();

      const status = await this.gitSilent(["status", "--porcelain"]);
      if (!status) return null;

      await this.git(["add", "-A"]);

      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const commitMsg = message ?? `checkpoint ${timestamp}`;
      // Passed verbatim as ONE argv entry — no shell, no escaping, no injection.
      await this.git(["commit", "-m", commitMsg]);

      return await this.git(["rev-parse", "HEAD"]);
    } catch {
      return null;
    } finally {
      release!();
    }
  }

  async restore(type: "files" | "full"): Promise<{ restored: boolean; checkpointHash?: string }> {
    await this.initialize();

    const hash = await this.gitSilent(["rev-parse", "HEAD"]);
    if (!hash) {
      return { restored: false };
    }

    // See restoreFrom() for why this snapshot must happen first. Note it can
    // itself move HEAD forward (a real commit, indexing this turn's
    // untracked creations) — so the read-tree below targets the captured
    // `hash`, not the literal ref "HEAD", or it would restore to the
    // snapshot we just took instead of the intended checkpoint.
    await this.save("[pre-restore] automatic snapshot");

    try {
      await this.git(["read-tree", "--reset", "-u", hash]);
    } catch {
      return { restored: false };
    }

    return { restored: true, checkpointHash: hash };
  }

  async restoreFrom(hash: string): Promise<{ restored: boolean; checkpointHash?: string }> {
    await this.initialize();

    // Checkpoints are taken at TURN START, not after every tool call. A file
    // the agent creates THIS turn exists in the worktree but in no snapshot
    // and never entered the shadow index — git simply never saw it, so a
    // plain `read-tree --reset -u <hash>` cannot delete it (git can't delete
    // what it never tracked). Taking a snapshot of the present RIGHT NOW,
    // before the read-tree, runs `add -A` and indexes that file for the
    // first time, so the read-tree below can finally remove it.
    //
    // Bonus: this pre-restore snapshot becomes a real listed checkpoint, so
    // every undo is itself redoable by restoring forward to it. It carries no
    // [convLen:N] tag on purpose — cli.tsx's conversation-rewind regex keys
    // off that tag, and this snapshot should restore files only, leaving the
    // conversation transcript untouched.
    await this.save("[pre-restore] automatic snapshot");

    try {
      // read-tree --reset -u, NOT checkout <hash> -- . — checkout overlays the
      // snapshot's files but never DELETES files created after it, so undoing
      // a file creation silently left the file in place (found by the user's
      // very first live /undo test: "write a sample file, then undo it").
      // read-tree resets the index to the snapshot and syncs the worktree,
      // removals included, while HEAD stays put — so later checkpoints remain
      // listed and an undo can itself be undone by restoring forward.
      await this.git(["read-tree", "--reset", "-u", hash]);
    } catch {
      return { restored: false };
    }

    return { restored: true, checkpointHash: hash };
  }

  async list(): Promise<CheckpointEntry[]> {
    await this.initialize();

    const output = await this.gitSilent(["log", "--format=%H|||%s|||%ci"]);
    if (!output) return [];

    return output.split("\n").map((line) => {
      const [hash, message, timestamp] = line.split("|||");
      return {
        hash: hash ?? "",
        message: message ?? "",
        timestamp: timestamp ?? "",
      };
    });
  }
}
