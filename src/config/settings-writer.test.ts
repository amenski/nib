import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addSandboxGrants } from "./settings-writer.js";

describe("addSandboxGrants", () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), "nib-writer-")); });
  afterEach(() => rmSync(home, { recursive: true, force: true }));
  const read = () => JSON.parse(readFileSync(join(home, "settings.json"), "utf8"));

  it("creates a valid sandbox block (enabled: true) when there was none", () => {
    writeFileSync(join(home, "settings.json"), JSON.stringify({ theme: { mode: "dark" } }));
    addSandboxGrants(["mach:com.apple.foo"], home);
    expect(read()).toEqual({ theme: { mode: "dark" }, sandbox: { enabled: true, grants: ["mach:com.apple.foo"] } });
  });

  it("keeps the user's own enabled value and other keys, and does not duplicate ids", () => {
    writeFileSync(join(home, "settings.json"), JSON.stringify({ sandbox: { enabled: false, writeRoots: ["~/x"], grants: ["a:1"] } }));
    addSandboxGrants(["a:1", "b:2"], home);
    expect(read().sandbox).toEqual({ enabled: false, writeRoots: ["~/x"], grants: ["a:1", "b:2"] });
  });
});
