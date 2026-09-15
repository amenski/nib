// The two directory names this app owns, in one leaf module.
//
// Deliberately dependency-free: `permissions/` needs these names, and
// `config/loader.ts` imports `permissions/`, so putting them in the loader
// would close a cycle. Everything that needs a project- or state-dir name
// imports from here.
//
// Both are also the *only* place the names are spelled. Every settings path
// is built by `projectSettingsPath()`, so the four sites that read it — the
// loader, the two trust gates, and folder-trust — cannot drift apart. They
// must not: a trust gate pointed at one path while the loader reads another
// would report a stale entry as trusted and let a project's settings take
// effect with no prompt.

import { join } from "node:path";

/** Per-project config directory, e.g. `<project>/.nib/`. */
export const PROJECT_DIR_NAME = ".nib";

/** State directory under the user's home, e.g. `~/.nib/` (see `resolveHome`). */
export const STATE_DIR_NAME = ".nib";

/** The project-local config directory for `dir`. */
export function projectDirPath(dir: string): string {
  return join(dir, PROJECT_DIR_NAME);
}

/** The project-local settings file the trust gate must hash and the loader reads. */
export function projectSettingsPath(dir: string): string {
  return join(dir, PROJECT_DIR_NAME, "settings.json");
}
