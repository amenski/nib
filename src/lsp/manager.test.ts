import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LspManager, ALLOWED_LSP_COMMANDS, resolveLspServers } from "./manager.js";
import { detectBuiltinServers, resolveOnPath } from "./defaults.js";
import type { LspServerConfig } from "../config/loader.js";
import type { SpawnFn } from "./server.js";
import { createFakeLspServer, type FakeServerHandles } from "./testing/fake-server.js";

const DART: LspServerConfig = {
  command: "dart",
  args: ["language-server"],
  extensionToLanguage: { ".dart": "dart" },
};

describe("LspManager", () => {
  let dir: string;
  let fakes: FakeServerHandles[];
  let notes: string[];

  const countingSpawn: SpawnFn = () => {
    const fake = createFakeLspServer();
    fakes.push(fake);
    return fake.client;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nib-lspm-"));
    fakes = [];
    notes = [];
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function makeManager(
    servers: Record<string, LspServerConfig>,
    extra: Partial<ConstructorParameters<typeof LspManager>[0]> = {},
  ): LspManager {
    return new LspManager({
      rootDir: dir,
      servers,
      spawn: countingSpawn,
      onNote: (text) => notes.push(text),
      quietMs: 40,
      maxWaitMs: 300,
      ...extra,
    });
  }

  it("routes a path to the server that claims its extension", () => {
    const manager = makeManager({
      dart: DART,
      ts: { command: "typescript-language-server", extensionToLanguage: { ".ts": "typescript" } },
    });
    expect(manager.serverFor(join(dir, "a.dart"))?.name).toBe("dart");
    expect(manager.serverFor(join(dir, "b.ts"))?.name).toBe("ts");
    expect(manager.serverFor(join(dir, "c.rs"))).toBeUndefined();
    expect(manager.serverFor(join(dir, "noext"))).toBeUndefined();
  });

  it("starts a server once, on first use", async () => {
    const manager = makeManager({ dart: DART });
    expect(fakes).toHaveLength(0);

    writeFileSync(join(dir, "a.dart"), "int a = 1;\n", "utf-8");
    await manager.diagnosticsFor([join(dir, "a.dart")]);
    await manager.diagnosticsFor([join(dir, "a.dart")]);

    expect(fakes).toHaveLength(1);
  });

  it("returns diagnostics keyed by the path it was given", async () => {
    const file = join(dir, "a.dart");
    writeFileSync(file, "int x = 1;\n", "utf-8");
    const manager = makeManager({ dart: DART }, {
      spawn: () => {
        const fake = createFakeLspServer({
          publishes: { [file]: [[{ diagnostics: [[0, 4, 1, "bad"] ] }]] },
        });
        fakes.push(fake);
        return fake.client;
      },
    });

    const result = await manager.diagnosticsFor([file]);
    expect(result.get(file)?.map((d) => d.message)).toEqual(["bad"]);
  });

  it("omits a file with no server rather than reporting an error", async () => {
    const file = join(dir, "a.rs");
    writeFileSync(file, "fn main() {}\n", "utf-8");
    const manager = makeManager({ dart: DART });
    const result = await manager.diagnosticsFor([file]);
    expect(result.size).toBe(0);
  });

  it("swallows a server that will not start, keeping the rest of the batch", async () => {
    const dartFile = join(dir, "a.dart");
    const tsFile = join(dir, "b.ts");
    writeFileSync(dartFile, "int a = 1;\n", "utf-8");
    writeFileSync(tsFile, "const a = 1;\n", "utf-8");
    const manager = makeManager(
      { dart: DART, ts: { command: "typescript-language-server", extensionToLanguage: { ".ts": "typescript" } } },
      {
        spawn: (_config, name) => {
          if (name === "dart") {
            const fake = createFakeLspServer({ failInitialize: "not installed" });
            fakes.push(fake);
            return fake.client;
          }
          const fake = createFakeLspServer({ publishes: { [tsFile]: [[{ diagnostics: [[0, 6, 1, "ts bad"]] }]] } });
          fakes.push(fake);
          return fake.client;
        },
      },
    );

    const result = await manager.diagnosticsFor([dartFile, tsFile]);
    expect(result.has(dartFile)).toBe(false);
    expect(result.get(tsFile)?.map((d) => d.message)).toEqual(["ts bad"]);
  });

  it("refuses a command outside the allowlist under strictMcpConfig", () => {
    const manager = makeManager(
      { evil: { command: "./x", extensionToLanguage: { ".dart": "dart" } } },
      { strict: true },
    );

    expect(manager.status()[0]).toMatchObject({ name: "evil", state: "disabled" });
    expect(manager.blockedReason("evil")).toContain("blocked by strictMcpConfig");
    expect(manager.hasServers).toBe(false);
    expect(manager.serverFor(join(dir, "a.dart"))).toBeUndefined();
  });

  it.each(["./dart", "bin/dart", "/proj/bin/dart", "..\\dart"])(
    "refuses a path that merely ends in an allowlisted name (%s) under strictMcpConfig",
    (command) => {
      const manager = makeManager(
        { dart: { command, extensionToLanguage: { ".dart": "dart" } } },
        { strict: true },
      );
      expect(manager.blockedReason("dart")).toContain("blocked by strictMcpConfig");
      expect(manager.hasServers).toBe(false);
    },
  );

  it.each(["PATH", "DYLD_INSERT_LIBRARIES", "LD_PRELOAD", "NODE_OPTIONS", "BASH_ENV"])(
    "refuses an allowlisted command whose env sets %s under strictMcpConfig",
    (key) => {
      const manager = makeManager({ dart: { ...DART, env: { [key]: "x" } } }, { strict: true });
      expect(manager.blockedReason("dart")).toContain(`env "${key}"`);
      expect(manager.hasServers).toBe(false);
    },
  );

  it("allows harmless env under strictMcpConfig, and any env when strict is off", () => {
    const harmless = makeManager({ dart: { ...DART, env: { PUB_CACHE: "/c" } } }, { strict: true });
    expect(harmless.blockedReason("dart")).toBeUndefined();
    const lax = makeManager({ dart: { ...DART, env: { PATH: "/x" } } }, { strict: false });
    expect(lax.blockedReason("dart")).toBeUndefined();
  });

  it("allows an allowlisted native server under strictMcpConfig", () => {
    const manager = makeManager({ dart: DART }, { strict: true });
    expect(manager.status()[0]).toMatchObject({ name: "dart", state: "idle" });
    expect(manager.blockedReason("dart")).toBeUndefined();
  });

  it("keeps an explicitly permitted server when strictMcpConfig is off", () => {
    const manager = makeManager(
      { custom: { command: "/opt/tools/my-ls", extensionToLanguage: { ".foo": "foo" } } },
      { strict: false },
    );
    expect(manager.blockedReason("custom")).toBeUndefined();
    expect(manager.hasServers).toBe(true);
  });

  it("lets an earlier server win a shared extension, matching the loader's warning", () => {
    const manager = makeManager({
      first: { command: "dart", extensionToLanguage: { ".dart": "dart" } },
      second: { command: "other", extensionToLanguage: { ".dart": "other" } },
    });
    expect(manager.serverFor(join(dir, "a.dart"))?.name).toBe("first");
  });

  it("reports status without starting anything", () => {
    const manager = makeManager({ dart: DART });
    expect(manager.status()).toEqual([
      { name: "dart", state: "idle", extensions: [".dart"], command: "dart" },
    ]);
    expect(fakes).toHaveLength(0);
  });

  it("shuts every started server down", async () => {
    const file = join(dir, "a.dart");
    writeFileSync(file, "int a = 1;\n", "utf-8");
    const manager = makeManager({ dart: DART });
    await manager.diagnosticsFor([file]);
    await manager.shutdownAll();

    expect(fakes[0]!.received.map((m) => m.code ?? m.method)).toContain("shutdown");
  });

  it("never emits the disabled note for a server that never crashed", async () => {
    const file = join(dir, "a.dart");
    writeFileSync(file, "int a = 1;\n", "utf-8");
    const manager = makeManager({ dart: DART });
    await manager.diagnosticsFor([file]);
    expect(notes).toEqual([]);
  });
});

describe("ALLOWED_LSP_COMMANDS", () => {
  it("covers native servers the MCP launcher list would block", () => {
    expect(ALLOWED_LSP_COMMANDS.has("dart")).toBe(true);
    expect(ALLOWED_LSP_COMMANDS.has("gopls")).toBe(true);
    expect(ALLOWED_LSP_COMMANDS.has("rust-analyzer")).toBe(true);
  });
});

describe("detectBuiltinServers", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nib-lspb-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("requires BOTH the marker file and the binary on PATH", () => {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const fakeDart = join(bin, "dart");
    writeFileSync(fakeDart, "#!/bin/sh\n");
    chmodSync(fakeDart, 0o755);

    // Marker missing → nothing, even with the binary present.
    expect(detectBuiltinServers(dir, bin)).toEqual({});

    writeFileSync(join(dir, "pubspec.yaml"), "name: x\n", "utf-8");
    const found = detectBuiltinServers(dir, bin);
    expect(Object.keys(found)).toEqual(["dart"]);
    expect(found.dart).toMatchObject({
      command: "dart",
      args: ["language-server", "--protocol=lsp"],
      extensionToLanguage: { ".dart": "dart" },
    });
  });

  it("skips the built-in when the binary is not on PATH", () => {
    writeFileSync(join(dir, "pubspec.yaml"), "name: x\n", "utf-8");
    expect(detectBuiltinServers(dir, "")).toEqual({});
  });

  it("detects typescript from tsconfig.json", () => {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const fakeTls = join(bin, "typescript-language-server");
    writeFileSync(fakeTls, "#!/bin/sh\n");
    chmodSync(fakeTls, 0o755);
    writeFileSync(join(dir, "tsconfig.json"), "{}", "utf-8");

    const found = detectBuiltinServers(dir, bin);
    expect(found.typescript?.extensionToLanguage[".tsx"]).toBe("typescriptreact");
  });
});

describe("resolveOnPath", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nib-lspp-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("finds an executable by walking PATH", () => {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const exe = join(bin, "mytool");
    writeFileSync(exe, "");
    chmodSync(exe, 0o755);
    expect(resolveOnPath("mytool", `${join(dir, "nope")}:${bin}`)).toBe(exe);
  });

  it("ignores a non-executable file of the same name", () => {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "mytool"), "");
    chmodSync(join(bin, "mytool"), 0o644);
    expect(resolveOnPath("mytool", bin)).toBeUndefined();
  });

  it("returns undefined for an unknown command", () => {
    expect(resolveOnPath("definitely-not-installed-xyz", dir)).toBeUndefined();
  });
});

describe("resolveLspServers", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nib-lspr-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("merges built-ins with user entries, the user winning a name collision", () => {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const exe = join(bin, "dart");
    writeFileSync(exe, "");
    chmodSync(exe, 0o755);
    writeFileSync(join(dir, "pubspec.yaml"), "name: x\n", "utf-8");

    const merged = resolveLspServers(
      { lspServers: { dart: { command: "dart", args: ["custom"], extensionToLanguage: { ".dart": "dart" } } } },
      dir,
      bin,
    );

    expect(merged.dart?.args).toEqual(["custom"]);
  });

  it("honours lsp.builtinServers: false", () => {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const exe = join(bin, "dart");
    writeFileSync(exe, "");
    chmodSync(exe, 0o755);
    writeFileSync(join(dir, "pubspec.yaml"), "name: x\n", "utf-8");

    const merged = resolveLspServers({ lsp: { builtinServers: false } }, dir, bin);
    expect(merged).toEqual({});
  });
});
