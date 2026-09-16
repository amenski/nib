import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, appendFileSync, lstatSync, readdirSync, unlinkSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { resolveHome } from "../config/loader.js";
import { ensurePrivateStateDirectory, hardenPrivateTree } from "../config/state-permissions.js";

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

  // Never let git repack the shadow repo. `gc --auto` fires after `commit` once
  // the loose-object count trips gc.auto, and repack writes its output to
  // `tmp_pack_*`, renaming it to `pack-<hash>.pack` only on success. Interrupt
  // it — the user quits, the machine sleeps — and the temp file is stranded
  // forever, because nothing here ever gc's or prunes the shadow repo to
  // collect it. Incident 2026-08-17: two sessions whose cwd was $HOME left
  // 14.5 GB and 12.4 GB dead packs under checkpoints/. The repo is per-session
  // and short-lived, so it has nothing to gain from packing anyway.
  "-c", "gc.auto=0",
];

// A workspace presenting more entries than this to a fresh shadow repo is not a
// project being edited — it is whatever directory happened to be the cwd. This
// is the only bound on what `add -A` below can stage: the info/exclude list
// filters by extension, so without a cap the ceiling is whatever the workspace
// contains, not whatever the agent touched. Same incident as above: cwd was
// $HOME (235 GB), and the extension filter let 14 GB of it through.
//
// Calibration, measured against the two real trees: this repo presents 404
// entries, $HOME presents 1,146,894. 5000 is ~12x a normally-sized project and
// four orders of magnitude below the pathological case. Note this bounds ENTRY
// COUNT, not bytes — a workspace of a few very large files still slips past —
// which is why gc.auto=0 above and sweepStaleTempPacks() exist: together they
// bound the consequence instead.
const MAX_CHECKPOINT_ENTRIES = 5000;
/** Default per-session shadow-repository budget. Configurable via retention. */
export const DEFAULT_MAX_CHECKPOINT_BYTES = 512 * 1024 * 1024;
/** Headroom for trees, commits, and Git bookkeeping around changed blobs. */
const CHECKPOINT_OVERHEAD_BYTES = 64 * 1024;

export interface CheckpointOptions {
  maxBytes?: number;
}

const execFileAsync = promisify(execFile);

function hardenCheckpointTree(path: string): void {
  try {
    hardenPrivateTree(path);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`nib: failed to secure checkpoint state at ${path}: ${reason}`, { cause: err });
  }
}

function directoryByteSize(root: string): number {
  let total = 0;
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop()!;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      try {
        const stat = lstatSync(path);
        if (stat.isDirectory()) pending.push(path);
        else total += stat.size;
      } catch {
        // A concurrently removed file is not evidence that the checkpoint is
        // over budget; the next save will remeasure the private tree.
      }
    }
  }
  return total;
}

function statusPaths(status: string): string[] {
  const fields = status.split("\0").filter(Boolean);
  const paths: string[] = [];
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i]!;
    if (field.length < 4) continue;
    paths.push(field.slice(3));
    // With porcelain -z, a rename/copy has a second NUL-delimited path.
    if (field[1] === "R" || field[1] === "C" || field[0] === "R" || field[0] === "C") {
      if (fields[i + 1] !== undefined) paths.push(fields[++i]!);
    }
  }
  return paths;
}

export class CheckpointManager {
  private shadowDir: string;
  private workspaceDir: string;
  private initialized = false;
  private warnedUnbounded = false;
  private warnedByteLimit = false;
  private _lock: Promise<void> = Promise.resolve();
  private readonly maxBytes: number;

  constructor(
    sessionId: string,
    workspaceDir?: string,
    home: string = resolveHome(),
    options: CheckpointOptions = {},
  ) {
    this.workspaceDir = resolve(workspaceDir ?? process.cwd());
    this.shadowDir = join(home, "checkpoints", sessionId);
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_CHECKPOINT_BYTES;
  }

  get workspace(): string {
    return this.workspaceDir;
  }

  private async initialize(): Promise<void> {
    if (this.initialized) return;

    const checkpointsDir = dirname(this.shadowDir);
    const stateDir = dirname(checkpointsDir);
    const existed = existsSync(this.shadowDir);
    ensurePrivateStateDirectory(stateDir, basename(checkpointsDir), basename(this.shadowDir));
    if (!existed) {
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

    hardenCheckpointTree(this.shadowDir);

    this.sweepStaleTempPacks();

    this.initialized = true;
  }

  // A repack killed mid-write leaves its temp pack behind permanently (see
  // gc.auto=0 above for the mechanism and the incident). `gc.auto=0` stops new
  // ones being created; this collects the ones already sitting in a repo this
  // session is about to use, so resuming a session heals its own residue
  // instead of carrying it forever. Deliberately outside the `existsSync`
  // branch above — the residue lives in shadow repos initialized long before
  // this code existed.
  //
  // Scope, stated plainly: this only touches the repo for THIS session id. The
  // 26 GB stranded by the two dead $HOME sessions of 2026-08-17 is not
  // reclaimed here — those ids are never constructed again — and still needs
  // removing by hand.
  //
  // Unconditional, with no age check: the shadow repo is per-session, a session
  // id is unique per run, and gc.auto=0 means no checkpoint-driven repack can be
  // in flight. A `tmp_pack_*` here is dead by construction. The files are mode
  // 0444, but unlink needs write permission on the directory, not the file.
  private sweepStaleTempPacks(): void {
    const packDir = join(this.shadowDir, ".git", "objects", "pack");
    let names: string[];
    try {
      names = readdirSync(packDir);
    } catch {
      return; // no pack dir yet — nothing has ever been packed here
    }

    for (const name of names) {
      if (!name.startsWith("tmp_pack_")) continue;
      try {
        unlinkSync(join(packDir, name));
      } catch {
        // Read-only, in use, or already gone — never fatal to a checkpoint.
      }
    }
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
    hardenCheckpointTree(this.shadowDir);
    return stdout.trim();
  }

  private async gitSilent(args: string[]): Promise<string | null> {
    try {
      return await this.git(args);
    } catch {
      return null;
    }
  }

  // Once per session, not once per call: tools/edit.ts saves after every write,
  // so an unguarded notice would repeat on every single tool call. stderr is the
  // established channel for this class of notice (see config/folder-trust.ts).
  private warnUnboundedWorkspace(): void {
    if (this.warnedUnbounded) return;
    this.warnedUnbounded = true;
    process.stderr.write(
      `nib: checkpoints are off for this session — the workspace has more than ` +
        `${MAX_CHECKPOINT_ENTRIES} changed or untracked entries, so snapshotting ` +
        `it would be unbounded. /undo is unavailable here.\n`,
    );
  }

  private warnByteLimit(): void {
    if (this.warnedByteLimit) return;
    this.warnedByteLimit = true;
    process.stderr.write(
      `nib: checkpoints are off for this session — the shadow repository would exceed ` +
        `${this.maxBytes} bytes. /undo is unavailable for further changes.\n`,
    );
  }

  private async changedWorkspaceBytes(status: string): Promise<number> {
    let total = 0;
    for (const relative of statusPaths(status)) {
      const absolute = resolve(this.workspaceDir, relative);
      if (absolute !== this.workspaceDir && !absolute.startsWith(`${this.workspaceDir}/`)) {
        return this.maxBytes + CHECKPOINT_OVERHEAD_BYTES;
      }
      try {
        const stat = lstatSync(absolute);
        if (stat.isFile() || stat.isSymbolicLink()) total += stat.size;
        else if (stat.isDirectory()) total += directoryByteSize(absolute);
      } catch {
        // Deleted paths contribute no bytes.
      }
      if (total > this.maxBytes) return total;
    }
    return total;
  }

  private async rollbackShadowChanges(previousHash: string | null, committed = false): Promise<void> {
    try {
      if (previousHash) {
        await this.git(["reset", "--mixed", previousHash]);
      } else {
        // `git reset` has no commit to target before the first checkpoint, but
        // after a too-large first commit HEAD must be deleted explicitly.
        if (committed) await this.git(["update-ref", "-d", "HEAD"]);
        await this.git(["reset"]);
      }
    } catch {
      // The shadow repo remains private and the next save will fail closed if
      // it is still over budget; never touch the user's worktree as recovery.
    }
    // Only unreachable objects in this session's shadow repo are collected.
    await this.gitSilent(["prune", "--expire=now"]);
  }

  async save(message?: string): Promise<string | null> {
    const prev = this._lock;
    let release: () => void;
    this._lock = new Promise<void>((r) => { release = r; });
    await prev;

    try {
      await this.initialize();

      // -uall is load-bearing, not tidiness. Plain --porcelain collapses an
      // untracked directory into ONE entry while `add -A` below recurses into
      // all of it — so the default undercounts by exactly the factor that
      // matters here. Measured: $HOME reports 206 entries by default and
      // 1,146,894 under -uall. A 5000 cap on the default count would never have
      // fired on the very incident it exists to prevent.
      //
      // (The 10 MB maxBuffer on git() is a second, coarser backstop: at ~40
      // bytes an entry it trips around 250k, so a tree that size returns null
      // from the ENOBUFS throw before the cap is ever compared. Same outcome —
      // nothing is staged — just without the notice.)
      const previousHash = await this.gitSilent(["rev-parse", "HEAD"]);
      const status = await this.gitSilent(["status", "--porcelain", "-uall", "-z"]);
      if (!status) return null;

      if (statusPaths(status).length > MAX_CHECKPOINT_ENTRIES) {
        this.warnUnboundedWorkspace();
        return null;
      }

      const currentBytes = directoryByteSize(this.shadowDir);
      const changedBytes = await this.changedWorkspaceBytes(status);
      if (
        currentBytes > this.maxBytes ||
        changedBytes > this.maxBytes - currentBytes - CHECKPOINT_OVERHEAD_BYTES
      ) {
        this.warnByteLimit();
        return null;
      }

      await this.git(["add", "-A"]);

      if (directoryByteSize(this.shadowDir) > this.maxBytes) {
        await this.rollbackShadowChanges(previousHash);
        this.warnByteLimit();
        return null;
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const commitMsg = message ?? `checkpoint ${timestamp}`;
      // Passed verbatim as ONE argv entry — no shell, no escaping, no injection.
      await this.git(["commit", "-m", commitMsg]);

      if (directoryByteSize(this.shadowDir) > this.maxBytes) {
        await this.rollbackShadowChanges(previousHash, true);
        this.warnByteLimit();
        return null;
      }

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
