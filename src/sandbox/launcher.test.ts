import { describe, expect, it } from "vitest";
import { buildChildEnvironment, prepareSandboxedShell } from "./launcher.js";

describe("sandbox child launcher", () => {
  it("preserves the direct shell argv when no sandbox level applies", () => {
    expect(prepareSandboxedShell("echo hi", {
      cwd: process.cwd(),
      trustedRoot: process.cwd(),
    })).toEqual({ file: "/bin/sh", args: ["-c", "echo hi"] });
  });

  it("adds only the private session temp paths to the minimal environment", () => {
    const env = buildChildEnvironment("/private/tmp/nib-session-test");

    expect(env.TMPDIR).toBe("/private/tmp/nib-session-test");
    expect(env.TMP).toBe("/private/tmp/nib-session-test");
    expect(env.TEMP).toBe("/private/tmp/nib-session-test");
    expect(env.npm_config_cache).toBe("/private/tmp/nib-session-test/npm-cache");
    expect(Object.keys(env).filter((key) => !["PATH", "HOME", "TERM", "TMPDIR", "TMP", "TEMP", "npm_config_cache"].includes(key))).toEqual([]);
  });
});
