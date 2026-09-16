import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface SessionTempDir {
  path: string;
  environment: Record<string, string>;
  cleanup(): void;
}

/** Creates the single private scratch directory inherited by all session children. */
export function createSessionTempDir(): SessionTempDir {
  const path = mkdtempSync(join(tmpdir(), "nib-session-"));
  chmodSync(path, 0o700);
  let cleaned = false;
  const onExit = () => cleanup();
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    process.removeListener("exit", onExit);
    rmSync(path, { recursive: true, force: true });
  };
  process.once("exit", onExit);
  return {
    path,
    environment: {
      TMPDIR: path,
      TMP: path,
      TEMP: path,
      npm_config_cache: join(path, "npm-cache"),
    },
    cleanup,
  };
}
