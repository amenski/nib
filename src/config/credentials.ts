import { readFileSync, existsSync, statSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { resolveHome } from "./loader.js";

// Resolved lazily (per call, not baked in at module load) so tests can mock
// the home (and because NIB_HOME may change between calls). Honors the
// same override as the config loader (resolveHome). This is the single source
// of truth for where credentials live; auth/wizard.ts imports these helpers so
// the write and read paths cannot drift.
export function credsDir(): string {
  return join(resolveHome());
}

export function credsFile(): string {
  return join(credsDir(), "credentials.yaml");
}

/**
 * Parse a flat `key: value` YAML map (one entry per line). Quotes around the
 * value are stripped; blank lines and `#` comments are ignored. This is the
 * exact shape `heirloom auth` writes.
 */
export function parseFlatYaml(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf(":");
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) result[key] = value;
  }
  return result;
}

/**
 * Read the flat `provider: key` map from `~/.heirloom/credentials.yaml` — the
 * file `heirloom auth` writes. Never throws: a missing or unreadable file
 * resolves to an empty map. If the file's permissions are looser than 0600 they
 * are fixed in place (a warning is printed).
 */
export function readCredentialsFile(
  path: string = credsFile(),
): Record<string, string> {
  if (!existsSync(path)) return {};
  try {
    const perms = statSync(path).mode & 0o777;
    if (perms !== 0o600) {
      console.warn(
        `warning: ${path} permissions are ${perms.toString(8)}, expected 600. Fixing.`,
      );
      chmodSync(path, 0o600);
    }
    return parseFlatYaml(readFileSync(path, "utf-8"));
  } catch {
    return {};
  }
}

/**
 * Look up a single provider's key from `~/.heirloom/credentials.yaml`.
 * Returns undefined when absent or empty.
 */
export function getCredential(
  name: string,
  path: string = credsFile(),
): string | undefined {
  const value = readCredentialsFile(path)[name];
  return value || undefined;
}
