import {
  chmodSync,
  mkdirSync,
  openSync,
  readdirSync,
  writeFileSync,
  writeSync,
  closeSync,
} from "node:fs";
import { chmod, mkdir, open, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Private modes for Nib-owned state, independent of the process umask. */
export const PRIVATE_DIRECTORY_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

/** Create (or repair) one Nib-owned directory with mode 0700. */
export function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  chmodSync(path, PRIVATE_DIRECTORY_MODE);
}

/** Async counterpart to ensurePrivateDirectory. */
export async function ensurePrivateDirectoryAsync(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  await chmod(path, PRIVATE_DIRECTORY_MODE);
}

/**
 * Create every component below a known Nib state root with mode 0700.
 * Callers pass only app-owned path segments; this deliberately does not walk
 * arbitrary ancestors such as a workspace or the user's home directory.
 */
export function ensurePrivateStateDirectory(baseDir: string, ...segments: string[]): string {
  let current = baseDir;
  ensurePrivateDirectory(current);
  for (const segment of segments) {
    current = join(current, segment);
    ensurePrivateDirectory(current);
  }
  return current;
}

/** Async counterpart to ensurePrivateStateDirectory. */
export async function ensurePrivateStateDirectoryAsync(baseDir: string, ...segments: string[]): Promise<string> {
  let current = baseDir;
  await ensurePrivateDirectoryAsync(current);
  for (const segment of segments) {
    current = join(current, segment);
    await ensurePrivateDirectoryAsync(current);
  }
  return current;
}

/** Write a sensitive state file with mode 0600, including existing files. */
export function writePrivateFileSync(path: string, data: string): void {
  writeFileSync(path, data, { mode: PRIVATE_FILE_MODE });
  chmodSync(path, PRIVATE_FILE_MODE);
}

/** Async counterpart to writePrivateFileSync. */
export async function writePrivateFile(path: string, data: string): Promise<void> {
  await writeFile(path, data, { mode: PRIVATE_FILE_MODE });
  await chmod(path, PRIVATE_FILE_MODE);
}

/** Append to a sensitive state file, creating it with mode 0600 if needed. */
export function appendPrivateFileSync(path: string, data: string): void {
  const fd = openSync(path, "a", PRIVATE_FILE_MODE);
  try {
    writeSync(fd, data);
  } finally {
    closeSync(fd);
  }
  chmodSync(path, PRIVATE_FILE_MODE);
}

/** Async counterpart to appendPrivateFileSync. */
export async function appendPrivateFile(path: string, data: string): Promise<void> {
  const handle = await open(path, "a", PRIVATE_FILE_MODE);
  try {
    await handle.write(data);
  } finally {
    await handle.close();
  }
  await chmod(path, PRIVATE_FILE_MODE);
}

/** Repair all files/directories in a private state tree without following symlinks. */
export function hardenPrivateTree(path: string): void {
  chmodSync(path, PRIVATE_DIRECTORY_MODE);
  // Kept intentionally sync: checkpoint initialization already runs outside
  // the UI turn, and this is the only reliable way to cover files Git creates.
  // The checkpoint entry cap bounds the tree this visits.
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) hardenPrivateTree(child);
    else if (entry.isFile()) chmodSync(child, PRIVATE_FILE_MODE);
  }
}
