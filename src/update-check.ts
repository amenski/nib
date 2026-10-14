import { readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { resolveHome } from "./config/loader.js";
import { ensurePrivateDirectory, writePrivateFileSync } from "./config/state-permissions.js";
import { pkg } from "./version.js";

/**
 * Startup notice when npm has a newer nib. One request a day at most, to the
 * public registry, from the interactive TUI only (headless `exec` never calls
 * this). Off with `"updateCheck": false` or `NIB_NO_UPDATE_CHECK=1`. Same
 * temp-file + rename cache convention as providers/live-models.ts.
 */
export const UPDATE_CHECK_CACHE_FILENAME = "update-check.json";
export const UPDATE_CHECK_TTL_MS = 24 * 60 * 60 * 1000;
const TIMEOUT_MS = 3000;
const REGISTRY_URL = `https://registry.npmjs.org/${pkg.name.replace("/", "%2f")}/latest`;
/** The only shape printed: a registry body is untrusted text. */
const VERSION = /^\d+\.\d+\.\d+(-[\w.]+)?$/;

interface UpdateCache {
  checkedAt: number;
  latest: string;
}

/** True when `latest` is a newer release than `current`. A prerelease `latest` never counts. */
export function isNewerVersion(latest: string, current: string): boolean {
  if (!VERSION.test(latest) || latest.includes("-")) return false;
  const a = latest.split(".").map(Number);
  const b = current.split("-")[0].split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return false;
}

export function updateNotice(latest: string, current: string): string {
  return `nib ${latest} is available (you have ${current}) — npm i -g ${pkg.name}`;
}

function readCache(home: string): UpdateCache | null {
  try {
    const parsed = JSON.parse(readFileSync(join(home, UPDATE_CHECK_CACHE_FILENAME), "utf-8")) as Partial<UpdateCache>;
    if (typeof parsed?.checkedAt === "number" && typeof parsed.latest === "string" && VERSION.test(parsed.latest)) {
      return { checkedAt: parsed.checkedAt, latest: parsed.latest };
    }
    return null;
  } catch {
    return null;
  }
}

function writeCache(cache: UpdateCache, home: string): void {
  try {
    ensurePrivateDirectory(home);
    const tmpPath = join(home, `.${UPDATE_CHECK_CACHE_FILENAME}.tmp-${process.pid}-${Date.now()}`);
    writePrivateFileSync(tmpPath, `${JSON.stringify(cache, null, 2)}\n`);
    renameSync(tmpPath, join(home, UPDATE_CHECK_CACHE_FILENAME));
  } catch {
    // A read-only HOME must not break startup.
  }
}

async function fetchLatest(fetchImpl: typeof fetch): Promise<string | null> {
  try {
    const res = await fetchImpl(REGISTRY_URL, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: "manual",
      headers: { accept: "application/json", "user-agent": `nib/${pkg.version} (+cli)` },
    });
    if (res.status !== 200) return null;
    const body = (await res.json()) as { version?: unknown };
    return typeof body?.version === "string" && VERSION.test(body.version) ? body.version : null;
  } catch {
    return null;
  }
}

/** The notice line, or undefined when nib is current or the check is off or failed. Never throws. */
export async function checkForUpdate(opts: {
  current?: string;
  now?: () => number;
  homeDir?: string;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
} = {}): Promise<string | undefined> {
  const env = opts.env ?? process.env;
  if (env.NIB_NO_UPDATE_CHECK) return undefined;
  const current = opts.current ?? pkg.version;
  const now = opts.now ?? Date.now;
  const home = opts.homeDir ?? resolveHome();
  const cached = readCache(home);
  let latest = cached?.latest;
  if (!cached || now() - cached.checkedAt >= UPDATE_CHECK_TTL_MS) {
    const fetched = await fetchLatest(opts.fetchImpl ?? fetch);
    if (fetched) {
      writeCache({ checkedAt: now(), latest: fetched }, home);
      latest = fetched;
    }
  }
  return latest && isNewerVersion(latest, current) ? updateNotice(latest, current) : undefined;
}
