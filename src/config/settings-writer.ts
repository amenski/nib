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

/**
 * Append sandbox capability ids to `sandbox.grants` ("Allow always" at the
 * capability prompt). A settings file with no `sandbox` block gets
 * `enabled: true` — the default an absent block means — because the loader
 * requires `enabled` whenever the block exists, and a grant must not switch the
 * sandbox off or make the file invalid.
 */
export function addSandboxGrants(ids: string[], homeDir?: string): void {
  updateSettings((config) => {
    const sandbox = (config.sandbox && typeof config.sandbox === "object" && !Array.isArray(config.sandbox) ? config.sandbox : {}) as Record<string, unknown>;
    const grants = Array.isArray(sandbox.grants) ? sandbox.grants.filter((g): g is string => typeof g === "string") : [];
    for (const id of ids) if (!grants.includes(id)) grants.push(id);
    config.sandbox = { enabled: true, ...sandbox, grants };
  }, homeDir);
}
