import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A throwaway `$HOME` for the macOS read-boundary tests. The boundary denies
 * credential stores under `$HOME`, so a fixture needs a credential directory
 * (`.ssh`) to be denied — and must never touch the real one. Node's
 * `homedir()` reads `$HOME`, so pointing it at a temp directory moves the
 * profile's deny paths with it. `restore` puts the real value back and removes
 * the directory.
 */
export function enterFakeHome(prefix: string): { root: string; restore: () => void } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  const previous = process.env.HOME;
  process.env.HOME = root;
  return {
    root,
    restore: () => {
      if (previous === undefined) delete process.env.HOME;
      else process.env.HOME = previous;
      rmSync(root, { recursive: true, force: true });
    },
  };
}
