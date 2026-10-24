import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LspServer } from "./server.js";
import type { SpawnFn } from "./server.js";
import type { LspServerConfig } from "../config/loader.js";
import { createFakeLspServer, type FakeServerHandles, type FakeServerScript } from "./testing/fake-server.js";

const CONFIG: LspServerConfig = {
  command: "dart",
  args: ["language-server"],
  extensionToLanguage: { ".dart": "dart" },
};

/** Short windows keep the suite fast; the ratios are what the tests assert. */
const QUIET_MS = 60;
const MAX_WAIT_MS = 400;

describe("LspServer", () => {
  let dir: string;
  let file: string;
  let fakes: FakeServerHandles[];
  let spawn: SpawnFn;
  let notes: string[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nib-lsp-"));
    file = join(dir, "a.dart");
    writeFileSync(file, "int f() => 1;\n", "utf-8");
    fakes = [];
    notes = [];
    spawn = (): any => {
      const fake = createFakeLspServer();
      fakes.push(fake);
      return fake.client;
    };
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** A server whose scripted peer is built fresh per spawn. */
  function serverWith(
    script: FakeServerScript = {},
    overrides: Partial<ConstructorParameters<typeof LspServer>[0]> = {},
  ): LspServer {
    return new LspServer({
      name: "dart",
      config: CONFIG,
      rootDir: dir,
      spawn: () => {
        const fake = createFakeLspServer(script);
        fakes.push(fake);
        return fake.client;
      },
      onNote: (text) => notes.push(text),
      quietMs: QUIET_MS,
      readyQuietMs: 5,
      maxWaitMs: MAX_WAIT_MS,
      ...overrides,
    });
  }

  it("handshakes: initialize, then initialized, then ready", async () => {
    const server = serverWith();
    await server.start();

    expect(server.currentState).toBe("ready");
    expect(fakes[0]!.received.map((m) => m.method)).toEqual(
      expect.arrayContaining(["initialize", "initialized"]),
    );
    const initialize = fakes[0]!.received.find((m) => m.method === "initialize") as any;
    expect(initialize.params.capabilities.textDocument.synchronization.dynamicRegistration).toBe(false);
    expect(initialize.params.rootUri).toContain(dir);
  });

  it("sends initializationOptions and settings when configured", async () => {
    const server = serverWith(
      {},
      {
        config: {
          ...CONFIG,
          initializationOptions: { hints: true },
          settings: { analysis: { enabled: true } },
        },
      },
    );
    await server.start();

    const methods = fakes[0]!.received.map((m) => m.method);
    expect(methods).toContain("workspace/didChangeConfiguration");
    const initialize = fakes[0]!.received.find((m) => m.method === "initialize") as any;
    expect(initialize.params.initializationOptions).toEqual({ hints: true });
  });

  it("uses didOpen the first time and didChange with an incremented version after", async () => {
    const server = serverWith();
    await server.syncFile(file);
    await server.syncFile(file);

    const syncs = fakes[0]!.received.filter(
      (m) => m.method === "textDocument/didOpen" || m.method === "textDocument/didChange",
    ) as any[];

    expect(syncs.map((m) => m.method)).toEqual([
      "textDocument/didOpen",
      "textDocument/didChange",
    ]);
    expect(syncs[0].params.textDocument).toMatchObject({ languageId: "dart", version: 1, text: "int f() => 1;\n" });
    expect(syncs[1].params.textDocument.version).toBe(2);
    expect(syncs[1].params.contentChanges).toEqual([{ text: "int f() => 1;\n" }]);
  });

  it("waits out an empty publish and settles on the real one", async () => {
    const server = serverWith({
      publishes: {
        [file]: [
          [
            { diagnostics: [] },
            { diagnostics: [[0, 8, 1, "A value of type 'String' can't be assigned", "invalid_assignment"]], delayMs: 30 },
          ],
        ],
      },
    });

    await server.syncFile(file);
    const diagnostics = await server.waitForDiagnostics(file);

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      line: 1,
      character: 9,
      severity: 1,
      code: "invalid_assignment",
    });
  });

  it("resets the quiet window on each publish, so a still-talking server is not cut off", async () => {
    const server = serverWith({
      publishes: {
        [file]: [
          [
            { diagnostics: [[0, 0, 2, "first"]], delayMs: 0 },
            // Inside the quiet window: this publish must push the settle out.
            { diagnostics: [[1, 0, 2, "second"]], delayMs: QUIET_MS - 20 },
          ],
        ],
      },
    });

    await server.syncFile(file);
    const started = Date.now();
    const diagnostics = await server.waitForDiagnostics(file);
    const elapsed = Date.now() - started;

    // publishDiagnostics replaces the file's list, so the later publish is the
    // answer — and it only arrived because the window was extended past it.
    expect(diagnostics.map((d) => d.message)).toEqual(["second"]);
    expect(elapsed).toBeGreaterThanOrEqual(QUIET_MS + 20);
  });

  it("settles early on $/progress end", async () => {
    const server = serverWith({
      progress: true,
      publishes: {
        [file]: [[{ diagnostics: [[0, 0, 1, "real"]], delayMs: 10 }]],
      },
    });

    await server.syncFile(file);
    const started = Date.now();
    const diagnostics = await server.waitForDiagnostics(file);
    const elapsed = Date.now() - started;

    expect(diagnostics.map((d) => d.message)).toEqual(["real"]);
    // Progress end arrives with the publish (during the first-open warm-up),
    // so only the short quiet window for an already-recorded publish remains.
    expect(elapsed).toBeLessThan(QUIET_MS + 40);
  });

  it("gives up at the hard cap when the server never settles", async () => {
    const server = serverWith({
      publishes: {
        [file]: [[{ diagnostics: [[0, 0, 1, "late"]], delayMs: MAX_WAIT_MS * 4 }]],
      },
    });

    await server.syncFile(file);
    const started = Date.now();
    const diagnostics = await server.waitForDiagnostics(file);
    const elapsed = Date.now() - started;

    expect(diagnostics).toEqual([]);
    expect(elapsed).toBeGreaterThanOrEqual(MAX_WAIT_MS - 20);
    expect(elapsed).toBeLessThan(MAX_WAIT_MS * 2);
  });

  it("answers workspace/configuration with the configured settings", async () => {
    const server = serverWith(
      { serverRequest: { method: "workspace/configuration", params: { items: [{}, {}] } } },
      { config: { ...CONFIG, settings: { a: 1 } } },
    );
    await server.start();
    // The fake sends it right after `initialized`; the reply is a write away.
    await new Promise((resolve) => setTimeout(resolve, 10));

    const answer = fakes[0]!.answered.find((a) => a.method === "workspace/configuration");
    expect(answer?.result).toEqual([{ a: 1 }, { a: 1 }]);
  });

  it("answers an unknown server request with an error instead of hanging", async () => {
    const server = serverWith({ serverRequest: { method: "custom/weird" } });
    await server.start();
    await new Promise((resolve) => setTimeout(resolve, 10));

    const answer = fakes[0]!.answered.find((a) => a.method === "custom/weird");
    expect(answer?.result).toMatchObject({ code: -32603 });
  });

  it("survives one crash, restarts on the next use, and disables after the second", async () => {
    const server = serverWith({
      publishes: { [file]: [[{ diagnostics: [[0, 0, 1, "still here"]] }]] },
    });

    await server.start();
    fakes[0]!.crash();
    expect(server.currentState).toBe("dead");
    expect(notes).toEqual([]);

    // Next use restarts it.
    await server.syncFile(file);
    expect(server.currentState).toBe("ready");
    expect(fakes).toHaveLength(2);

    fakes[1]!.crash();
    expect(server.currentState).toBe("disabled");
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("dart language server crashed twice");
    expect(notes[0]).toContain(".dart");

    // A disabled server never spawns a third process.
    await server.syncFile(file);
    expect(fakes).toHaveLength(2);
  });

  it("settles a pending wait when the server crashes instead of hanging to the cap", async () => {
    const server = serverWith({
      publishes: { [file]: [[{ diagnostics: [[0, 0, 1, "x"]], delayMs: MAX_WAIT_MS * 4 }]] },
    });

    await server.syncFile(file);
    const started = Date.now();
    const pending = server.waitForDiagnostics(file);
    fakes[0]!.crash();
    const diagnostics = await pending;

    expect(diagnostics).toEqual([]);
    expect(Date.now() - started).toBeLessThan(MAX_WAIT_MS / 2);
  });

  it("rejects start() when initialize fails, and does not report ready", async () => {
    const server = serverWith({ failInitialize: "no dart here" });
    await expect(server.start()).rejects.toThrow("no dart here");
    expect(server.currentState).toBe("dead");
  });

  it("failed start: one retry, then disabled with one note and the reason", async () => {
    const server = serverWith({ failInitialize: "Could not find a valid TypeScript installation\nmore" });
    await expect(server.start()).rejects.toThrow();
    expect(server.currentState).toBe("dead");
    await expect(server.syncFile(file)).rejects.toThrow(); // the one retry
    expect(server.currentState).toBe("disabled");
    expect(fakes).toHaveLength(2);
    await server.syncFile(file); // no spawn
    expect(fakes).toHaveLength(2);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("language server failed to start (LSP error -32000: Could not find a valid TypeScript installation); LSP disabled for .dart this session");
    expect(server.disabledReason).toBe("LSP error -32000: Could not find a valid TypeScript installation");
  });

  it("an exit before the initialize response takes the same failed-start path", async () => {
    spawn = (): any => {
      const fake = createFakeLspServer();
      fakes.push(fake);
      // Dies on receiving `initialize`, before any response.
      return { ...fake.client, write: () => fake.crash() };
    };
    const server = serverWith({}, { spawn });
    await expect(server.start()).rejects.toThrow();
    expect(server.currentState).toBe("dead");
    await expect(server.syncFile(file)).rejects.toThrow();
    expect(server.currentState).toBe("disabled");
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("failed to start");
  });

  it("start() waits out the ready quiet window when the server sends no progress", async () => {
    const server = serverWith({}, { readyQuietMs: 120 });
    const t = Date.now();
    await server.start();
    expect(Date.now() - t).toBeGreaterThanOrEqual(100);
    expect(server.currentState).toBe("ready");
  });

  it("shutdown sends shutdown then exit", async () => {
    const server = serverWith();
    await server.start();
    await server.shutdown();

    const methods = fakes[0]!.received.map((m) => m.method);
    expect(methods).toContain("shutdown");
    expect(methods).toContain("exit");
  });

  it("skips syncing a file that disappeared between edit and read", async () => {
    const server = serverWith();
    await server.start();
    await server.syncFile(join(dir, "gone.dart"));

    const methods = fakes[0]!.received.map((m) => m.method);
    expect(methods).not.toContain("textDocument/didOpen");
  });

  it("exposes its extensions", () => {
    expect(serverWith().extensions).toEqual([".dart"]);
  });
});
