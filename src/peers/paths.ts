import { closeSync, fsyncSync, lstatSync, openSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { resolveHome } from "../config/loader.js";
import { ensurePrivateDirectory, PRIVATE_DIRECTORY_MODE, PRIVATE_FILE_MODE } from "../config/state-permissions.js";

/** Layout and permission checks for `$NIB_HOME/peers/` (docs/cross-session-inbox.md §3). */

// Ids become path segments; anything with dots or slashes could escape peers/.
const PEER_ID_REGEX = /^[A-Za-z0-9-]{1,64}$/;

export function isSafePeerId(id: unknown): id is string {
  return typeof id === "string" && PEER_ID_REGEX.test(id);
}

export function peersSupported(): boolean {
  return process.platform !== "win32" && typeof process.getuid === "function";
}

export class PeerDirError extends Error {}

export interface InboxDirs {
  base: string;
  tmp: string;
  new: string;
  cur: string;
  bad: string;
}

export function peersRoot(home: string = resolveHome()): string {
  return join(home, "peers");
}

export function registryDir(home?: string): string {
  return join(peersRoot(home), "registry");
}

export function inboxDirs(id: string, home?: string): InboxDirs {
  if (!isSafePeerId(id)) throw new PeerDirError(`invalid peer id: ${JSON.stringify(id)}`);
  const base = join(peersRoot(home), "inbox", id);
  return { base, tmp: join(base, "tmp"), new: join(base, "new"), cur: join(base, "cur"), bad: join(base, "bad") };
}

/** Throws unless `path` is a real directory (not a symlink), owned by us, mode exactly 0700. */
export function checkPrivateDir(path: string): void {
  const st = lstatSync(path);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new PeerDirError(`${path} is not a directory`);
  if (st.uid !== process.getuid!()) throw new PeerDirError(`${path} is not owned by the current user`);
  if ((st.mode & 0o777) !== PRIVATE_DIRECTORY_MODE) {
    throw new PeerDirError(`${path} has mode ${(st.mode & 0o777).toString(8)}, expected 700`);
  }
}

/**
 * Create (if missing) and verify every directory from `peers/` down to
 * `peers/<segments...>`. A pre-existing symlink is rejected, never followed.
 */
export function ensurePeerDir(home: string | undefined, ...segments: string[]): string {
  let current = peersRoot(home);
  for (const segment of ["", ...segments]) {
    if (segment) current = join(current, segment);
    if (!exists(current)) ensurePrivateDirectory(current);
    checkPrivateDir(current);
  }
  return current;
}

export function ensureRegistryDir(home?: string): string {
  return ensurePeerDir(home, "registry");
}

export function ensureInbox(id: string, home?: string): InboxDirs {
  const dirs = inboxDirs(id, home);
  for (const sub of ["tmp", "new", "cur", "bad"]) ensurePeerDir(home, "inbox", id, sub);
  return dirs;
}

/** Write `data` to `path` via an exclusive 0600 temp file + rename, so readers never see a partial file. */
export function writeAtomicPrivate(path: string, data: string): void {
  const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  writeExclusive(tmp, data);
  try {
    renameSync(tmp, path);
  } catch (err) {
    safeUnlink(tmp);
    throw err;
  }
}

/** Create `path` with O_EXCL (never follows or overwrites an existing file), write, fsync. */
export function writeExclusive(path: string, data: string): void {
  const fd = openSync(path, "wx", PRIVATE_FILE_MODE);
  try {
    writeSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function safeUnlink(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // already gone
  }
}

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}
