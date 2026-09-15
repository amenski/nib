import { spawn } from "node:child_process";
import { join } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { render } from "ink";
import { createElement } from "react";
import UpdatePrompt from "../ui/views/UpdatePrompt.js";
import { resolveHome } from "../config/loader.js";

// Resolved per call, not at import: a module-level constant freezes the state
// dir before a test can point NIB_HOME at a temp dir, and this file both
// reads and *clears* its state file.
function statePath(): string {
  return join(resolveHome(), "update-check.json");
}

interface UpdateState {
  ignoredVersions: string[];
  pending: { version: string; checkedAt: string } | null;
}

function cmpSemver(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const va = pa[i] || 0;
    const vb = pb[i] || 0;
    if (va > vb) return 1;
    if (va < vb) return -1;
  }
  return 0;
}

async function ensureDir(): Promise<void> {
  try { await mkdir(resolveHome(), { recursive: true }); } catch {}
}

export async function readUpdateState(): Promise<UpdateState> {
  try {
    const raw = await readFile(statePath(), "utf-8");
    return JSON.parse(raw);
  } catch {
    return { ignoredVersions: [], pending: null };
  }
}

async function writeUpdateState(state: UpdateState): Promise<void> {
  await ensureDir();
  await writeFile(statePath(), JSON.stringify(state, null, 2), "utf-8");
}

// Incident (2026-08-06): this repo's package has never been published to npm
// (`private: true` in package.json is deliberate), but the update checker
// queried the registry by name anyway. The npm registry's `heirloom` is an
// unrelated package (a photo-backup-to-S3 tool, maintainer briangershon,
// v0.3.0) — a stranger's code. While package.json still carried the scaffold
// version 1.0.0 this was invisibly masked (1.0.0 > 0.3.0, so "no update"),
// but setting the honest 0.1.0 exposed it: the CLI started prompting to
// install v0.3.0 of someone else's package globally. A private package is by
// definition not on npm under this name, so any registry answer is always
// about someone else's package — both entry points below must no-op.
export async function checkForNpmUpdate(packageInfo: { name: string; version: string; private?: boolean }): Promise<void> {
  if (packageInfo.private) return;
  const { name, version: installed } = packageInfo;
  try {
    const latest = await fetchLatestVersion(name);
    if (!latest) return;
    if (cmpSemver(latest, installed) <= 0) return;

    const state = await readUpdateState();
    if (state.ignoredVersions.includes(latest)) return;

    state.pending = { version: latest, checkedAt: new Date().toISOString() };
    await writeUpdateState(state);
  } catch {}
}

function fetchLatestVersion(packageName: string): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const child = spawn("npm", ["view", packageName, "dist-tags.latest", "--json"], {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10000,
    });

    let output = "";
    const MAX_OUTPUT = 10240;

    child.stdout?.on("data", (chunk: Buffer) => {
      if (output.length < MAX_OUTPUT) {
        output += chunk.toString("utf-8");
      }
    });

    child.on("error", () => {
      if (!settled) { settled = true; resolve(null); }
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (code !== 0 || !output.trim()) {
        resolve(null);
        return;
      }
      try {
        const parsed = JSON.parse(output.trim());
        const version = typeof parsed === "string" ? parsed : null;
        if (typeof version === "string" && /^\d+\.\d+\.\d+/.test(version)) {
          resolve(version);
        } else {
          resolve(null);
        }
      } catch {
        resolve(null);
      }
    });

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill("SIGTERM");
        resolve(null);
      }
    }, 10000);
    child.on("close", () => clearTimeout(timer));
  });
}

export async function promptForPendingUpdate(packageInfo: { name: string; version: string; private?: boolean }): Promise<void> {
  if (packageInfo.private) {
    // Clear any pending entry a prior (buggy) run may have already persisted
    // for the unrelated npm `heirloom` package — see incident note above.
    const state = await readUpdateState();
    if (state.pending) {
      state.pending = null;
      await writeUpdateState(state);
    }
    return;
  }

  const state = await readUpdateState();
  if (!state.pending) return;
  if (state.ignoredVersions.includes(state.pending.version)) return;

  const pendingVersion = state.pending.version;

  return new Promise<void>((resolve) => {
    const { waitUntilExit } = render(
      createElement(UpdatePrompt, {
        version: pendingVersion,
        installedVersion: packageInfo.version,
        onInstall: () => {
          const child = spawn("npm", ["install", "-g", `${packageInfo.name}@${pendingVersion}`], {
            stdio: "inherit",
            shell: true,
          });
          child.on("exit", () => process.exit(0));
        },
        onIgnore: async () => {
          const s = await readUpdateState();
          s.pending = null;
          await writeUpdateState(s);
          resolve();
        },
        onIgnoreVersion: async () => {
          const s = await readUpdateState();
          if (!s.ignoredVersions.includes(pendingVersion)) {
            s.ignoredVersions.push(pendingVersion);
          }
          s.pending = null;
          await writeUpdateState(s);
          resolve();
        },
      }),
    );
    (waitUntilExit as () => Promise<void>)().then(() => resolve());
  });
}
