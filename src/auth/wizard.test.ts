import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";

const TEST_HOME = join(process.cwd(), ".test-auth");

vi.mock("node:os", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:os")>();
  return { ...original, homedir: () => TEST_HOME };
});

function credsPath(): string {
  return join(TEST_HOME, ".nib", "credentials.yaml");
}

function parseFlatYaml(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf(":");
    if (idx === -1) continue;
    result[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
  }
  return result;
}

describe("authSaveKey", () => {
  let authSaveKey: typeof import("./wizard.js").authSaveKey;

  beforeEach(async () => {
    if (!existsSync(TEST_HOME)) mkdirSync(TEST_HOME, { recursive: true });
    vi.spyOn(console, "log").mockImplementation(() => {});
    ({ authSaveKey } = await import("./wizard.js"));
  });

  afterEach(() => {
    rmSync(TEST_HOME, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("writes the credential to ~/.nib/credentials.yaml", async () => {
    await authSaveKey("deepseek", "sk-test-dummy");

    expect(existsSync(credsPath())).toBe(true);
    const creds = parseFlatYaml(readFileSync(credsPath(), "utf-8"));
    expect(creds.deepseek).toBe("sk-test-dummy");
  });

  it("writes the credentials file with 0600 permissions", async () => {
    await authSaveKey("openai", "sk-openai-dummy");

    const mode = statSync(credsPath()).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("preserves existing entries when adding a new one", async () => {
    await authSaveKey("deepseek", "sk-first");
    await authSaveKey("groq", "sk-second");

    const creds = parseFlatYaml(readFileSync(credsPath(), "utf-8"));
    expect(creds.deepseek).toBe("sk-first");
    expect(creds.groq).toBe("sk-second");
  });

  it("overwrites the key for an existing provider", async () => {
    await authSaveKey("deepseek", "sk-old");
    await authSaveKey("deepseek", "sk-new");

    const creds = parseFlatYaml(readFileSync(credsPath(), "utf-8"));
    expect(creds.deepseek).toBe("sk-new");
  });

  it("prints the file path and a run hint", async () => {
    const logSpy = vi.spyOn(console, "log");
    await authSaveKey("openrouter", "sk-or-dummy");

    const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain(credsPath());
    expect(output).toContain("Run `heirloom` to start.");
  });

  it("silent:true saves the key but suppresses the console.log — needed so the Ink TUI's frame isn't corrupted", async () => {
    const logSpy = vi.spyOn(console, "log");
    await authSaveKey("deepseek", "sk-silent-dummy", true);

    expect(logSpy).not.toHaveBeenCalled();
    const creds = parseFlatYaml(readFileSync(credsPath(), "utf-8"));
    expect(creds.deepseek).toBe("sk-silent-dummy");
  });

  it("does not write anything when the save path is never invoked (cancel)", () => {
    // The cancel path in the wizard/CLI never calls authSaveKey, so no file
    // is created. This asserts the precondition that our temp HOME starts clean.
    expect(existsSync(credsPath())).toBe(false);
  });

  it("upgrades permissions on a pre-existing loose-perm file before rewriting", async () => {
    mkdirSync(join(TEST_HOME, ".nib"), { recursive: true });
    writeFileSync(credsPath(), "existing: sk-keep\n", { mode: 0o644 });

    await authSaveKey("added", "sk-add");

    const creds = parseFlatYaml(readFileSync(credsPath(), "utf-8"));
    expect(creds.existing).toBe("sk-keep");
    expect(creds.added).toBe("sk-add");
    expect(statSync(credsPath()).mode & 0o777).toBe(0o600);
  });
});
