import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";
import { quoteForDisplay } from "./denials.js";
import { resolveCapabilityId, type Capability } from "./capabilities.js";

/**
 * Toolchains that write outside what the default profile allows, offered once
 * per project at startup instead of being discovered one denial at a time.
 * `TOOLCHAIN_WRITE_ROOTS` (seatbelt.ts) already covers the package caches;
 * these add what a build still writes: the SDK's own cache, the toolchain
 * manager's home.
 *
 * A preset is a bundle of ordinary `write:<dir>` capabilities, so every
 * never-grantable rule applies (a Homebrew install under /opt/homebrew is
 * simply left out) and "always" saves the individual ids — `sandbox.grants`
 * needs no new kind.
 */
export interface Preset extends Capability {
  /** The `write:<dir>` capabilities this preset bundles. */
  parts: Capability[];
}

interface Toolchain {
  id: string;
  title: string;
  markers: string[];
  /** Binary whose install root is the SDK, and how to get from binary to root. */
  sdk?: { tool: string; root: (realBinary: string) => string };
  /** Home-relative directories the toolchain writes, when they exist. */
  homeDirs: string[];
}

const TOOLCHAINS: Toolchain[] = [
  {
    id: "toolchain:flutter",
    title: "Flutter toolchain",
    markers: ["pubspec.yaml"],
    // <root>/bin/flutter: the SDK updates <root>/bin/cache and its own tool snapshots.
    sdk: { tool: "flutter", root: (bin) => dirname(dirname(bin)) },
    homeDirs: [".flutter", ".dart-tool", ".dartServer"],
  },
  {
    id: "toolchain:gradle",
    title: "Gradle toolchain",
    markers: ["build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts"],
    homeDirs: [".kotlin", ".konan"],
  },
  {
    id: "toolchain:rust",
    title: "Rust toolchain",
    markers: ["Cargo.toml"],
    // rustup installs and updates toolchains here; ~/.cargo/bin stays read-only.
    homeDirs: [".rustup"],
  },
  {
    id: "toolchain:cocoapods",
    title: "CocoaPods",
    markers: ["Podfile"],
    homeDirs: [".cocoapods"],
  },
];

export interface PresetDeps {
  which?: (tool: string) => string | null;
  home?: string;
}

function which(tool: string): string | null {
  try {
    const out = execFileSync("/usr/bin/which", [tool], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return out === "" ? null : out;
  } catch {
    return null;
  }
}

function realOrNull(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/** The presets this workspace's build files call for, with only the grantable directories that exist. */
export function detectPresets(workspace: string, deps: PresetDeps = {}): Preset[] {
  const home = deps.home ?? homedir();
  const presets: Preset[] = [];
  for (const tc of TOOLCHAINS) {
    if (!tc.markers.some((m) => existsSync(join(workspace, m)))) continue;
    const dirs: string[] = [];
    if (tc.sdk) {
      const bin = (deps.which ?? which)(tc.sdk.tool);
      const real = bin ? realOrNull(bin) : null;
      // A version-manager shim (asdf, mise) is a script, not a link to the SDK:
      // its "root" would be the manager's whole directory. Left out.
      if (real && !real.split(sep).includes("shims")) dirs.push(tc.sdk.root(real));
    }
    for (const rel of tc.homeDirs) dirs.push(join(home, rel));
    const parts: Capability[] = [];
    for (const dir of dirs) {
      if (!existsSync(dir)) continue;
      const cap = resolveCapabilityId(`write:${dir}`);
      if (cap && !("blocked" in cap) && !parts.some((p) => p.id === cap.id)) parts.push(cap);
    }
    if (parts.length === 0) continue;
    const names = parts.map((p) => quoteForDisplay(p.id.slice("write:".length))).join(", ");
    presets.push({
      id: tc.id,
      title: tc.title,
      risk: `This project uses ${tc.title}. Commands can create, change and delete files under ${names} — including the SDK files later builds run.`,
      lines: parts.flatMap((p) => p.lines),
      parts,
    });
  }
  return presets;
}
