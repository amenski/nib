import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, chmodSync, realpathSync } from "node:fs";
import { dirname } from "node:path";
import { resolveHome, type DeepCodeSettings } from "./loader.js";

/**
 * Trust-on-first-use store for project `.nib/settings.json` files that
 * declare execution-capable keys (EXECUTION_CAPABLE_KEYS in loader.ts:
 * statusline, mcpServers, notify, env — see loader.ts for why each is
 * execution-capable). Mirrors skill-trust.json / hooks-trust.json: a JSON
 * file under ~/.nib (NIB_HOME honored, same as every other
 * user-level file) keyed by the settings file's absolute path, storing only
 * the full sha256 of the file's content — never the content itself. The
 * user's own global ~/.nib/settings.json never consults this store — it
 * is trusted implicitly (same split hooks-spec §6 and skill-spec §6 chose for
 * global vs project content).
 *
 * An unseen or edited project settings file is withheld from taking effect
 * for its execution-capable keys until the user explicitly confirms:
 * `checkSettingsTrust` only classifies (trusted | new | changed), and
 * `trustSettings` records the decision. Interactive sessions ask via the
 * SettingsTrustPrompt modal; headless runs strip the execution-capable keys
 * with a stderr warning — fail closed, like hooks and skills.
 */

export interface SettingsTrustEntry {
  path: string;
  hash: string;
  firstSeen: number;
  lastChanged?: number;
  trusted: boolean;
}

export interface SettingsTrustStore {
  settings: Record<string, SettingsTrustEntry>;
}

function settingsTrustFilePath(): string {
  return `${resolveHome()}/settings-trust.json`;
}

export function loadSettingsTrust(): SettingsTrustStore {
  const path = settingsTrustFilePath();
  if (!existsSync(path)) return { settings: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    if (parsed && typeof parsed === "object" && parsed.settings && typeof parsed.settings === "object") {
      return parsed as SettingsTrustStore;
    }
    return { settings: {} };
  } catch {
    return { settings: {} };
  }
}

/**
 * Write the trust store: mode 0600, atomic (tmp + rename), and any failure is
 * swallowed with a stderr note — a trust-save failure must never become an
 * unhandled rejection at a turn boundary. The execution-capable keys stay
 * stripped for the session; only the persistence is lost.
 */
export function saveSettingsTrust(store: SettingsTrustStore): void {
  const path = settingsTrustFilePath();
  const dir = dirname(path);
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}`;
    writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
    renameSync(tmp, path);
    chmodSync(path, 0o600);
  } catch (err) {
    process.stderr.write(`nib: failed to write settings-trust.json: ${(err as Error).message}\n`);
  }
}

/**
 * Canonicalize a settings path for store keys: realpath, so the same file is
 * always the same key. Without this, a workspace reached through a symlink
 * (or, on macOS, the `/var` → `/private/var` spelling difference) would get
 * two keys and re-ask every session. Falls back to the raw path if the file
 * is gone (e.g. deleted while the trust modal was open).
 */
function realSettingsPath(settingsPath: string): string {
  try {
    return realpathSync(settingsPath);
  } catch {
    return settingsPath;
  }
}

/** Full sha256 of a settings file's content — the trust key, not the content itself. */
export function settingsContentHash(settingsPath: string): string {
  return createHash("sha256").update(readFileSync(settingsPath)).digest("hex");
}

export type SettingsTrustResult =
  | { status: "trusted" }
  | { status: "new" }
  | { status: "changed" };

/**
 * Classify a project settings file's current content against the trust store
 * WITHOUT persisting anything: the trust decision is recorded only when the
 * user explicitly confirms (trustSettings), so an unseen or edited project
 * settings file's execution-capable keys can be withheld until the ask-tier
 * confirmation. A hash mismatch (content edit) re-classifies as `changed` —
 * the tamper signal.
 */
export function checkSettingsTrust(settingsPath: string): SettingsTrustResult {
  const key = realSettingsPath(settingsPath);
  const hash = settingsContentHash(key);
  const store = loadSettingsTrust();
  const entry = store.settings[key];
  if (!entry) return { status: "new" };
  if (entry.hash !== hash) return { status: "changed" };
  return { status: "trusted" };
}

/**
 * Record an explicit "trust forever" decision: store the current content
 * hash, keyed by the canonical (realpath) source path. First trust sets
 * firstSeen; a re-trust after a content change records lastChanged.
 */
export function trustSettings(settingsPath: string): void {
  const key = realSettingsPath(settingsPath);
  const store = loadSettingsTrust();
  const existing = store.settings[key];
  const hash = settingsContentHash(key);
  store.settings[key] = {
    path: key,
    hash,
    firstSeen: existing?.firstSeen ?? Date.now(),
    lastChanged: existing && existing.hash !== hash ? Date.now() : existing?.lastChanged,
    trusted: true,
  };
  saveSettingsTrust(store);
}

/**
 * Remove execution-capable keys from an untrusted project settings file's
 * effect on the session. Mutates nothing — returns a new config object.
 *
 * `env` is special-cased: only `BASE_URL` is stripped (the traffic-redirect
 * concern), not the whole block, since API_KEY/MODEL/etc. carry no execution
 * risk of their own (config `env` is never splatted into process.env).
 * An `env` left with no keys after stripping BASE_URL is dropped entirely so
 * callers don't have to special-case an empty object.
 *
 * `strictMcpConfig` is stripped like any other key (plain `delete`), which
 * leaves it `undefined` rather than forcing `false` — that matters, because
 * `undefined` is the SECURE direction here. The sole consumer
 * (connectMCPServers in mcp/connector.ts) resolves it as
 * `options?.strictMcpConfig ?? true`, so an untrusted project's attempt to
 * set `strictMcpConfig: false` (disabling the MCP command allowlist) is
 * neutralized back to the allowlist being ON, not left off.
 *
 * `permissions` is stripped like any other key (plain `delete`): the sole
 * consumer, `PermissionEngine`, resolves an absent config to no rules +
 * `defaultMode: "askAll"` (engine.ts) — the strictest possible state.
 * `undefined` is the secure direction here, same as `strictMcpConfig`.
 *
 * `permissionProfile` and `sandbox` are the opposite case and must NOT be
 * plain-deleted. Verified from the consumers (permission-profile.md §9,
 * ProfileEvaluator's constructor, cli.tsx/exec-runner.ts's setSandboxLevel
 * call): an ABSENT `permissionProfile` resolves to `level: "unrestricted"`
 * ("layer 1 does not exist... today's behavior byte-for-byte" — i.e. the
 * *least* restrictive state, since the profile layer can only ever narrow,
 * never grant, on top of the rule engine), and an absent `sandbox` resolves
 * to the mechanical Seatbelt layer being off. A hostile project sets
 * `permissionProfile.level: "unrestricted"` / `sandbox.enabled: false`
 * specifically to reach those same absent-equivalent states — so a plain
 * `delete` would land the untrusted run in EXACTLY the state the attacker
 * asked for; it looks like a strip but is a no-op against this attack.
 * Instead these two are overridden to the strictest concrete value
 * (`permissionProfile: { level: "strict-sandbox" }` — read-only, network
 * denied by the level's own preset defaults, permission-profile.md §3 table
 * — and `sandbox: { enabled: true }`) whenever the project declared them.
 * `setSandboxLevel` requires BOTH `sandbox.enabled` and a non-"unrestricted"
 * `permissionProfile.level` to actually engage the OS layer (cli.tsx /
 * exec-runner.ts), so forcing only one of the two would leave the sandbox
 * inert if the project touched only the other key — both are forced
 * independently, each only when the project itself declared that key
 * (`keys` here is always `projectExecutionKeys`, so a key the project never
 * touched — e.g. inherited only from the user's own global settings — is
 * left completely alone).
 *
 * `webSearch` is special-cased like `env`: only `searxngUrl` is stripped
 * (the host-control / traffic-redirect risk — same shape as env.BASE_URL),
 * not the whole block. `enrich` carries no host/network control and is
 * preserved. An untrusted absent `searxngUrl` resolves to the Bing-only
 * path (web-search.ts), the existing default and the strictest available
 * option, so a plain delete of just that sub-key is the secure direction —
 * no forcing needed, unlike permissionProfile/sandbox. A `webSearch` left
 * with no keys after stripping `searxngUrl` is dropped entirely, same as
 * an emptied `env`.
 */
export function stripExecutionKeys(
  config: DeepCodeSettings,
  keys: readonly string[],
): DeepCodeSettings {
  if (keys.length === 0) return config;
  const result = { ...config };
  for (const key of keys) {
    if (key === "env") {
      if (result.env && "BASE_URL" in result.env) {
        const { BASE_URL: _drop, ...rest } = result.env;
        result.env = Object.keys(rest).length > 0 ? rest : undefined;
      }
      continue;
    }
    if (key === "permissionProfile") {
      // Absent resolves to "unrestricted" (the least restrictive state) —
      // see the doc comment above. Forcing the strictest preset, not
      // deleting, is what actually neutralizes a hostile project's attempt
      // to widen or remove this layer.
      result.permissionProfile = { level: "strict-sandbox" };
      continue;
    }
    if (key === "sandbox") {
      // Absent resolves to the Seatbelt layer being off (see doc comment
      // above) — force it on instead of deleting. A GLOBAL sandbox.writeRoots
      // (the user's own trusted grant, docs/unified-write-boundary.md §3 —
      // the loader never merges a project value into it) survives the strip:
      // it's the project's untrusted `enabled` being neutralized, not the
      // user's write-set widening.
      const writeRoots = result.sandbox?.writeRoots;
      result.sandbox =
        writeRoots && writeRoots.length > 0 ? { enabled: true, writeRoots } : { enabled: true };
      continue;
    }
    if (key === "webSearch") {
      if (result.webSearch && "searxngUrl" in result.webSearch) {
        const { searxngUrl: _drop, ...rest } = result.webSearch;
        result.webSearch = Object.keys(rest).length > 0 ? rest : undefined;
      }
      continue;
    }
    delete (result as Record<string, unknown>)[key];
  }
  return result;
}
