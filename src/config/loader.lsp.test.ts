import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectDirPath } from "./paths.js";
import { EXECUTION_CAPABLE_KEYS, loadConfig } from "./loader.js";

/**
 * `lspServers` / `lsp` config validation (the same rules validateMcpServers
 * gets, plus extension routing). NIB_HOME points at an empty dir so no global
 * settings interfere, matching the harness in loader.test.ts.
 */
let projectDir: string;
let homeDir: string;
let prevHome: string | undefined;

function writeProjectSettings(obj: unknown): void {
  mkdirSync(projectDirPath(projectDir), { recursive: true });
  writeFileSync(join(projectDirPath(projectDir), "settings.json"), JSON.stringify(obj), "utf-8");
}

function writeGlobalSettings(obj: unknown): void {
  writeFileSync(join(homeDir, "settings.json"), JSON.stringify(obj), "utf-8");
}

/** The sandbox notice is platform-dependent and unrelated to these rules. */
function relevantWarnings(warnings: string[]): string[] {
  return warnings.filter((w) => !w.startsWith("sandbox is macOS-only"));
}

const VALID_DART = {
  command: "dart",
  args: ["language-server", "--protocol=lsp"],
  extensionToLanguage: { ".dart": "dart" },
};

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "loader-lsp-proj-"));
  homeDir = mkdtempSync(join(tmpdir(), "loader-lsp-home-"));
  prevHome = process.env.NIB_HOME;
  process.env.NIB_HOME = homeDir;
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(homeDir, { recursive: true, force: true });
  if (prevHome === undefined) delete process.env.NIB_HOME;
  else process.env.NIB_HOME = prevHome;
});

describe("loadConfig lspServers", () => {
  it("accepts a well-formed server", () => {
    writeProjectSettings({ lspServers: { dart: VALID_DART } });
    const { config, errors, warnings } = loadConfig(projectDir);
    expect(errors).toEqual([]);
    expect(relevantWarnings(warnings)).toEqual([]);
    expect(config.lspServers?.dart).toEqual(VALID_DART);
  });

  it("keeps initializationOptions, settings and the timeouts", () => {
    writeProjectSettings({
      lspServers: {
        dart: {
          ...VALID_DART,
          initializationOptions: { a: 1 },
          settings: { b: [2] },
          startupTimeout: 5000,
          shutdownTimeout: 1000,
        },
      },
    });
    const { config, errors } = loadConfig(projectDir);
    expect(errors).toEqual([]);
    expect(config.lspServers?.dart).toMatchObject({
      initializationOptions: { a: 1 },
      settings: { b: [2] },
      startupTimeout: 5000,
      shutdownTimeout: 1000,
    });
  });

  it("requires command", () => {
    writeProjectSettings({ lspServers: { dart: { extensionToLanguage: { ".dart": "dart" } } } });
    const { config, errors } = loadConfig(projectDir);
    expect(errors).toContain("config: lspServers.dart.command is required");
    expect(config.lspServers?.dart).toBeUndefined();
  });

  it("rejects an empty command", () => {
    writeProjectSettings({ lspServers: { dart: { ...VALID_DART, command: "  " } } });
    expect(loadConfig(projectDir).errors).toContain("config: lspServers.dart.command is required");
  });

  it("requires extensionToLanguage", () => {
    writeProjectSettings({ lspServers: { dart: { command: "dart" } } });
    const { errors, config } = loadConfig(projectDir);
    expect(errors).toContain(
      "config: lspServers.dart.extensionToLanguage is required and must be an object",
    );
    expect(config.lspServers?.dart).toBeUndefined();
  });

  it("rejects an empty extensionToLanguage", () => {
    writeProjectSettings({ lspServers: { dart: { ...VALID_DART, extensionToLanguage: {} } } });
    expect(loadConfig(projectDir).errors).toContain(
      "config: lspServers.dart.extensionToLanguage must not be empty",
    );
  });

  it("drops the server when an extension key is malformed", () => {
    writeProjectSettings({
      lspServers: { dart: { ...VALID_DART, extensionToLanguage: { dart: "dart" } } },
    });
    const { config, errors } = loadConfig(projectDir);
    expect(errors).toContain(
      'config: lspServers.dart.extensionToLanguage key "dart" must look like ".dart"',
    );
    expect(config.lspServers?.dart).toBeUndefined();
  });

  it("rejects an empty language id", () => {
    writeProjectSettings({
      lspServers: { dart: { ...VALID_DART, extensionToLanguage: { ".dart": "" } } },
    });
    expect(loadConfig(projectDir).errors).toContain(
      'config: lspServers.dart.extensionToLanguage[".dart"] must be a non-empty string',
    );
  });

  it("warns and keeps the first server when two claim one extension", () => {
    writeProjectSettings({
      lspServers: {
        first: VALID_DART,
        second: { command: "dart", extensionToLanguage: { ".dart": "dart" } },
      },
    });
    const { config, errors, warnings } = loadConfig(projectDir);
    expect(errors).toEqual([]);
    expect(relevantWarnings(warnings).some((w) => w.includes('also claims ".dart"'))).toBe(true);
    expect(config.lspServers?.second?.extensionToLanguage).toEqual({});
  });

  it("rejects non-positive and non-finite timeouts", () => {
    for (const bad of [0, -1, Infinity, "1000"]) {
      writeProjectSettings({ lspServers: { dart: { ...VALID_DART, startupTimeout: bad } } });
      expect(loadConfig(projectDir).errors).toContain(
        "config: lspServers.dart.startupTimeout must be a positive number",
      );
    }
  });

  it("rejects a non-array args and a non-string env value", () => {
    writeProjectSettings({ lspServers: { dart: { ...VALID_DART, args: "x" } } });
    expect(loadConfig(projectDir).errors).toContain(
      "config: lspServers.dart.args must be an array of strings",
    );

    writeProjectSettings({ lspServers: { dart: { ...VALID_DART, env: { A: 1 } } } });
    expect(loadConfig(projectDir).errors).toContain("config: lspServers.dart.env.A must be a string");
  });

  it("warns on an unknown sub-key but keeps the server", () => {
    writeProjectSettings({ lspServers: { dart: { ...VALID_DART, weird: 1 } } });
    const { config, warnings } = loadConfig(projectDir);
    expect(relevantWarnings(warnings).some((w) => w.includes('unknown field "weird"'))).toBe(true);
    expect(config.lspServers?.dart?.command).toBe("dart");
  });

  it("errors when lspServers is not an object", () => {
    writeProjectSettings({ lspServers: [] });
    expect(loadConfig(projectDir).errors).toContain("config: lspServers must be an object");
  });
});

describe("loadConfig lspServers sandbox (global-only)", () => {
  it("honours a global sandbox:false for a server the project does not redefine", () => {
    writeGlobalSettings({ lspServers: { dart: { ...VALID_DART, sandbox: false } } });
    writeProjectSettings({});
    const { config } = loadConfig(projectDir);
    expect(config.lspServers?.dart?.sandbox).toBe(false);
  });

  it("ignores a project sandbox:false with a warning", () => {
    writeProjectSettings({ lspServers: { dart: { ...VALID_DART, sandbox: false } } });
    const { config, warnings } = loadConfig(projectDir);
    expect(
      relevantWarnings(warnings).some((w) => w.includes("lspServers.dart.sandbox is global-only")),
    ).toBe(true);
    expect(config.lspServers?.dart?.sandbox).toBeUndefined();
  });
});

describe("loadConfig lsp options block", () => {
  it("accepts the two off-switches", () => {
    writeProjectSettings({ lsp: { diagnostics: false, builtinServers: false } });
    const { config, errors } = loadConfig(projectDir);
    expect(errors).toEqual([]);
    expect(config.lsp).toEqual({ diagnostics: false, builtinServers: false });
  });

  it("rejects a non-boolean value", () => {
    writeProjectSettings({ lsp: { diagnostics: "no" } });
    expect(loadConfig(projectDir).errors).toContain("config: lsp.diagnostics must be a boolean");
  });

  it("rejects an unknown field, so the block stays off-switches only", () => {
    writeProjectSettings({ lsp: { servers: {} } });
    expect(loadConfig(projectDir).errors).toContain('config: lsp: unknown field "servers"');
  });

  it("is not itself an execution-capable key (it can only narrow)", () => {
    expect(EXECUTION_CAPABLE_KEYS.has("lsp")).toBe(false);
    writeProjectSettings({ lsp: { diagnostics: false } });
    expect(loadConfig(projectDir).projectExecutionKeys).toEqual([]);
  });
});

describe("lspServers TOFU detection", () => {
  it("flags a project that declares lspServers", () => {
    writeProjectSettings({ lspServers: { dart: VALID_DART } });
    expect(loadConfig(projectDir).projectExecutionKeys).toEqual(["lspServers"]);
  });

  it("does not flag a malformed lspServers block (it never reaches config anyway)", () => {
    writeProjectSettings({ lspServers: "nope" });
    expect(loadConfig(projectDir).projectExecutionKeys).toEqual([]);
  });

  it("does not flag a global-only lspServers declaration", () => {
    writeGlobalSettings({ lspServers: { dart: VALID_DART } });
    writeProjectSettings({});
    expect(loadConfig(projectDir).projectExecutionKeys).toEqual([]);
  });
});
