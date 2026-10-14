import { existsSync, readFileSync, renameSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { resolveHome } from "./loader.js";
import { ensurePrivateDirectory, writePrivateFileSync } from "./state-permissions.js";

/**
 * Read-modify-write the user-level settings.json: read (tolerating a missing
 * or corrupt file), hand the parsed object to `mutate` to merge in whatever
 * changed, then write back atomically (temp file + rename), mirroring the
 * permission engine's persist(). `homeDir` defaults to NIB_HOME. Never
 * writes project settings.
 *
 * Shared by every settings.json writer (the theme and model pickers, `nib mcp`,
 * sandbox capability grants) so there is exactly one atomic-write implementation.
 */
export function updateSettings(
  mutate: (config: Record<string, unknown>) => void,
  homeDir?: string,
): void {
  const dir = homeDir ?? resolveHome();
  const settingsPath = join(dir, "settings.json");

  let config: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try {
      const parsed = JSON.parse(readFileSync(settingsPath, "utf-8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        config = parsed as Record<string, unknown>;
      }
    } catch {
      // Corrupt file — start from empty rather than clobber-and-crash.
    }
  }

  mutate(config);

  ensurePrivateDirectory(dir);

  const tmpPath = join(dir, `.settings.json.${randomBytes(6).toString("hex")}.tmp`);
  writePrivateFileSync(tmpPath, JSON.stringify(config, null, 2));
  renameSync(tmpPath, settingsPath);
}
