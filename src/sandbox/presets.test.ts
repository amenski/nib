import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectPresets } from "./presets.js";
import { isPresetDeclined, recordPresetDecline } from "../config/folder-trust.js";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "nib-presets-")));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

let n = 0;
function fixture() {
  const root = join(scratch, `case-${n++}`);
  const ws = join(root, "ws");
  const home = join(root, "home");
  mkdirSync(ws, { recursive: true });
  mkdirSync(home, { recursive: true });
  return { root, ws, home };
}

describe("detectPresets", () => {
  it("offers nothing without a build file", () => {
    const { ws, home } = fixture();
    expect(detectPresets(ws, { home, which: () => null })).toEqual([]);
  });

  it("finds the Flutter SDK through its symlinked binary and the toolchain's home dirs that exist", () => {
    const { root, ws, home } = fixture();
    writeFileSync(join(ws, "pubspec.yaml"), "name: x\n");
    const sdk = join(root, "sdks", "flutter");
    mkdirSync(join(sdk, "bin"), { recursive: true });
    writeFileSync(join(sdk, "bin", "flutter"), "");
    symlinkSync(join(sdk, "bin", "flutter"), join(root, "flutter-link"));
    mkdirSync(join(home, ".dart-tool"));
    const [preset] = detectPresets(ws, { home, which: () => join(root, "flutter-link") });
    expect(preset.id).toBe("toolchain:flutter");
    expect(preset.parts.map((p) => p.id)).toEqual([`write:${sdk}`, `write:${join(home, ".dart-tool")}`]);
    expect(preset.lines).toEqual(preset.parts.flatMap((p) => p.lines));
    expect(preset.risk).toContain("Flutter toolchain");
  });

  it("skips a version-manager shim rather than granting the manager's directory", () => {
    const { root, ws, home } = fixture();
    writeFileSync(join(ws, "pubspec.yaml"), "");
    mkdirSync(join(root, ".asdf", "shims"), { recursive: true });
    writeFileSync(join(root, ".asdf", "shims", "flutter"), "");
    expect(detectPresets(ws, { home, which: () => join(root, ".asdf", "shims", "flutter") })).toEqual([]);
  });

  it("includes Flutter's user config dir (~/.config/flutter) when it exists", () => {
    const { ws, home } = fixture();
    writeFileSync(join(ws, "pubspec.yaml"), "");
    mkdirSync(join(home, ".config", "flutter"), { recursive: true });
    const [preset] = detectPresets(ws, { home, which: () => null });
    expect(preset.parts.map((p) => p.id)).toEqual([`write:${join(home, ".config", "flutter")}`]);
  });

  it("leaves out an SDK in a never-grantable place", () => {
    const { ws, home } = fixture();
    writeFileSync(join(ws, "pubspec.yaml"), "");
    mkdirSync(join(home, ".flutter"));
    // /usr/bin/true resolves under /usr: a system tree.
    const [preset] = detectPresets(ws, { home, which: () => "/usr/bin/true" });
    expect(preset.parts.map((p) => p.id)).toEqual([`write:${join(home, ".flutter")}`]);
  });

  it("maps the other build files to their toolchains", () => {
    const { ws, home } = fixture();
    for (const f of ["build.gradle.kts", "Cargo.toml", "Podfile"]) writeFileSync(join(ws, f), "");
    for (const d of [".kotlin", ".rustup", ".cocoapods"]) mkdirSync(join(home, d));
    expect(detectPresets(ws, { home, which: () => null }).map((p) => p.id)).toEqual(["toolchain:gradle", "toolchain:rust", "toolchain:cocoapods"]);
  });
});

describe("preset declines", () => {
  const previous = process.env.NIB_HOME;
  beforeEach(() => { process.env.NIB_HOME = join(scratch, `nib-home-${n++}`); });
  afterEach(() => {
    if (previous === undefined) delete process.env.NIB_HOME;
    else process.env.NIB_HOME = previous;
  });

  it("are remembered per project and per preset", () => {
    const a = fixture().ws;
    const b = fixture().ws;
    expect(isPresetDeclined(a, "toolchain:flutter")).toBe(false);
    recordPresetDecline(a, "toolchain:flutter");
    expect(isPresetDeclined(a, "toolchain:flutter")).toBe(true);
    expect(isPresetDeclined(a, "toolchain:rust")).toBe(false);
    expect(isPresetDeclined(b, "toolchain:flutter")).toBe(false);
  });
});
