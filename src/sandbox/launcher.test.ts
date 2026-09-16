import { describe, expect, it } from "vitest";
import { buildChildEnvironment, prepareSandboxedCommand, prepareSandboxedShell } from "./launcher.js";

describe("sandbox child launcher", () => {
  it("preserves the direct shell argv when no sandbox level applies", () => {
    expect(prepareSandboxedShell("echo hi", {
      cwd: process.cwd(),
      trustedRoot: process.cwd(),
    })).toEqual({ file: "/bin/sh", args: ["-c", "echo hi"] });
  });

  it("preserves direct command argv when no sandbox level applies", () => {
    expect(prepareSandboxedCommand("node", ["server.js", "--stdio"], {
      cwd: process.cwd(),
      trustedRoot: process.cwd(),
    })).toEqual({ file: "node", args: ["server.js", "--stdio"] });
  });

  // Regression guard for the off-by-one that made every contained stdio MCP
  // server run as `sh <command> <args>` (measured 2026-09-16: "cannot execute
  // binary file"). Containment must change what the child may touch, never
  // how it is launched — the same rule the unsandboxed row above states.
  it.skipIf(process.platform !== "darwin")("keeps the configured argv byte-for-byte when a profile applies (no shell is inserted)", () => {
    const spec = prepareSandboxedCommand("node", ["server.js", "--stdio"], {
      cwd: process.cwd(),
      trustedRoot: process.cwd(),
      sandboxLevel: "workspace-write",
    });

    expect(spec.file).toBe("/usr/bin/sandbox-exec");
    expect(spec.args[0]).toBe("-p");
    // Everything before the command is the `-p <profile>` pair, and nothing
    // else: a `/bin/sh` here is the bug this test exists to catch.
    expect(spec.args.slice(2)).toEqual(["node", "server.js", "--stdio"]);
    expect(spec.args).not.toContain("/bin/sh");
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
