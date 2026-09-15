import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("credentials", () => {
  let dir: string;
  let yamlPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "heirloom-creds-test-"));
    yamlPath = join(dir, "credentials.yaml");
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.resetModules();
  });

  async function load() {
    // Fresh module per test so module-level state resets.
    vi.resetModules();
    return await import("./credentials.js");
  }

  describe("getCredential — canonical YAML", () => {
    it("returns the key for a present provider", async () => {
      const { getCredential } = await load();
      writeFileSync(yamlPath, "deepseek: sk-test-dummy\nopenrouter: sk-or-test-dummy\n", { mode: 0o600 });
      expect(getCredential("deepseek", yamlPath)).toBe("sk-test-dummy");
      expect(getCredential("openrouter", yamlPath)).toBe("sk-or-test-dummy");
    });

    it("returns undefined for an absent provider", async () => {
      const { getCredential } = await load();
      writeFileSync(yamlPath, "deepseek: sk-test-dummy\n", { mode: 0o600 });
      expect(getCredential("openai", yamlPath)).toBeUndefined();
    });

    it("returns undefined when the file does not exist", async () => {
      const { getCredential } = await load();
      expect(getCredential("deepseek", join(dir, "nope.yaml"))).toBeUndefined();
    });

    it("returns undefined for an empty-string value", async () => {
      const { getCredential } = await load();
      writeFileSync(yamlPath, "deepseek:\n", { mode: 0o600 });
      expect(getCredential("deepseek", yamlPath)).toBeUndefined();
    });

    it("strips surrounding quotes from the value", async () => {
      const { getCredential } = await load();
      writeFileSync(yamlPath, 'deepseek: "sk-quoted"\n', { mode: 0o600 });
      expect(getCredential("deepseek", yamlPath)).toBe("sk-quoted");
    });
  });

  describe("readCredentialsFile", () => {
    it("returns an empty map for a missing file", async () => {
      const { readCredentialsFile } = await load();
      expect(readCredentialsFile(join(dir, "nope.yaml"))).toEqual({});
    });

    it("parses a flat YAML map", async () => {
      const { readCredentialsFile } = await load();
      writeFileSync(yamlPath, "deepseek: sk-a\ngroq: sk-b\n", { mode: 0o600 });
      expect(readCredentialsFile(yamlPath)).toEqual({ deepseek: "sk-a", groq: "sk-b" });
    });

    it("fixes loose (non-0600) permissions in place", async () => {
      const { readCredentialsFile } = await load();
      writeFileSync(yamlPath, "deepseek: sk-a\n", { mode: 0o644 });
      readCredentialsFile(yamlPath);
      expect(statSync(yamlPath).mode & 0o777).toBe(0o600);
    });
  });

  describe("round-trip: auth save -> provider resolution", () => {
    it("resolves a key written by authSaveKey through the shared read path", async () => {
      const FAKE_HOME = mkdtempSync(join(tmpdir(), "heirloom-roundtrip-"));
      vi.doMock("node:os", async (importOriginal) => {
        const original = await importOriginal<typeof import("node:os")>();
        return { ...original, homedir: () => FAKE_HOME };
      });
      try {
        mkdirSync(FAKE_HOME, { recursive: true });
        const { authSaveKey } = await import("../auth/wizard.js");
        vi.spyOn(console, "log").mockImplementation(() => {});
        await authSaveKey("deepseek", "sk-roundtrip");

        const { getCredential } = await import("./credentials.js");
        expect(getCredential("deepseek")).toBe("sk-roundtrip");
      } finally {
        vi.doUnmock("node:os");
        rmSync(FAKE_HOME, { recursive: true, force: true });
      }
    });
  });
});

describe("credsDir — NIB_HOME", () => {
  it("honors NIB_HOME over the mocked homedir", async () => {
    const prev = process.env.NIB_HOME;
    process.env.NIB_HOME = "/tmp/hh-creds";
    try {
      const { credsDir } = await import("./credentials.js");
      expect(credsDir()).toBe("/tmp/hh-creds");
    } finally {
      if (prev === undefined) delete process.env.NIB_HOME;
      else process.env.NIB_HOME = prev;
    }
  });
});
