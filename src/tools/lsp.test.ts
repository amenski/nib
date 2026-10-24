import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { registry } from "./index.js";
import type { ToolContext } from "./types.js";
import type { LspManager } from "../lsp/index.js";
import { parseUntrustedMarker } from "./untrusted-content.js";

/**
 * The read-only `lsp` tool: schema, path containment, the nine operations, and
 * the wire↔model conventions (1-based lines, untrusted wrapping).
 *
 * The manager is a stub that records the request and answers from a script —
 * real transport behaviour is covered by lsp/*.test.ts.
 */

type Responder = (method: string, params: any) => unknown;

function makeManager(
  responder: Responder,
  overrides: { serverFor?: (path: string) => unknown } = {},
) {
  const requests: Array<{ method: string; params: any }> = [];
  const synced: string[] = [];
  const server = {
    syncFile: async (path: string) => {
      synced.push(path);
    },
    request: async (method: string, params: any) => {
      requests.push({ method, params });
      return responder(method, params);
    },
  };
  const manager = {
    workspaceRoot: "/workspace",
    hasServers: true,
    serverFor: overrides.serverFor ?? (() => server),
    serverNameFor: () => "dart",
    diagnosticsFor: async () => new Map(),
  } as unknown as LspManager;
  return { manager, requests, synced, server };
}

const def = registry.getAllDefs().find((d) => d.name === "lsp")!;

function ctxFor(dir: string, manager?: LspManager, writeRoots?: string[]): ToolContext {
  return {
    workingDir: dir,
    sessionId: "test",
    signal: new AbortController().signal,
    fileMtimes: new Map(),
    ...(manager ? { lsp: manager } : {}),
    ...(writeRoots ? { writeRoots } : {}),
  };
}

async function call(args: Record<string, unknown>, ctx: ToolContext) {
  return registry.execute({ id: "t1", name: "lsp", arguments: args }, ctx);
}

describe("lsp tool schema", () => {
  it("is registered in the read group with the nine operations", () => {
    expect(def).toBeDefined();
    expect(def.parameters.required).toEqual(["operation", "filePath"]);
    expect((def.parameters.properties as any).operation.enum).toEqual([
      "goToDefinition",
      "findReferences",
      "hover",
      "documentSymbol",
      "goToImplementation",
      "workspaceSymbol",
      "prepareCallHierarchy",
      "incomingCalls",
      "outgoingCalls",
    ]);
  });

  it("says it is for navigation, not editing", () => {
    expect(def.description).toContain("Read-only");
    expect(def.description).toContain("Prefer this over grep");
  });
});

describe("lsp tool containment and configuration", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nib-lsptool-"));
    mkdirSync(join(dir, "lib"), { recursive: true });
    writeFileSync(join(dir, "lib", "a.dart"), "int a = 1;\n", "utf-8");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("denies a path outside the workspace", async () => {
    const { manager, requests } = makeManager(() => []);
    const out = await call(
      { operation: "hover", filePath: "/etc/passwd", line: 1, character: 1 },
      ctxFor(dir, manager),
    );
    expect(out.error).toContain("PERMISSION_DENIED");
    expect(out.content).toContain("lsp only reads files inside the workspace");
    expect(requests).toHaveLength(0);
  });

  it("denies a relative path that escapes with ..", async () => {
    const { manager, requests } = makeManager(() => []);
    const out = await call(
      { operation: "hover", filePath: "../../etc/passwd", line: 1, character: 1 },
      ctxFor(dir, manager),
    );
    expect(out.error).toContain("PERMISSION_DENIED");
    expect(requests).toHaveLength(0);
  });

  it("allows a path inside an explicit write root", async () => {
    const other = mkdtempSync(join(tmpdir(), "nib-lsptool-extra-"));
    try {
      writeFileSync(join(other, "b.dart"), "int b = 1;\n", "utf-8");
      const { manager } = makeManager(() => [{ uri: pathToFileURL(join(other, "b.dart")).toString(), range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }]);
      const out = await call(
        { operation: "goToDefinition", filePath: join(other, "b.dart"), line: 1, character: 1 },
        ctxFor(dir, manager, [other]),
      );
      expect(out.error).toBeUndefined();
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it("names the configuration key when no manager exists", async () => {
    const out = await call({ operation: "hover", filePath: join(dir, "lib/a.dart") }, ctxFor(dir));
    expect(out.error).toBe("No language server configured for .dart");
    expect(out.content).toContain("lspServers in settings");
  });

  it("names the extension when no server claims it", async () => {
    const { manager } = makeManager(() => [], { serverFor: () => undefined });
    const out = await call({ operation: "hover", filePath: join(dir, "lib/a.dart") }, ctxFor(dir, manager));
    expect(out.error).toBe("No language server configured for .dart");
  });

  it("rejects a missing filePath", async () => {
    const { manager } = makeManager(() => []);
    const out = await call({ operation: "hover" }, ctxFor(dir, manager));
    expect(out.error).toBe("filePath is required");
  });

  it("rejects an unknown operation", async () => {
    const { manager } = makeManager(() => []);
    const out = await call({ operation: "teleport", filePath: join(dir, "lib/a.dart") }, ctxFor(dir, manager));
    expect(out.error).toContain('unknown operation "teleport"');
  });

  it("syncs the file before querying, so the answer is about the file on disk", async () => {
    const { manager, synced } = makeManager(() => []);
    await call({ operation: "hover", filePath: join(dir, "lib/a.dart"), line: 1, character: 1 }, ctxFor(dir, manager));
    expect(synced).toEqual([join(dir, "lib/a.dart")]);
  });
});

describe("lsp tool operations", () => {
  let dir: string;
  let file: string;
  let uri: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nib-lsptool-"));
    mkdirSync(join(dir, "lib"), { recursive: true });
    file = join(dir, "lib", "a.dart");
    writeFileSync(file, "int a = 1;\n", "utf-8");
    uri = pathToFileURL(file).toString();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const location = (path: string, line: number, character: number) => ({
    uri: pathToFileURL(path).toString(),
    range: { start: { line, character }, end: { line, character: character + 1 } },
  });

  it("goToDefinition converts 1-based input to 0-based wire and back", async () => {
    const { manager, requests } = makeManager(() => [location(file, 11, 4)]);
    const out = await call(
      { operation: "goToDefinition", filePath: file, line: 2, character: 3 },
      ctxFor(dir, manager),
    );

    expect(requests[0]).toMatchObject({
      method: "textDocument/definition",
      params: { textDocument: { uri }, position: { line: 1, character: 2 } },
    });
    expect(out.content).toContain("lib/a.dart:12:5");
  });

  it("goToImplementation uses textDocument/implementation", async () => {
    const { manager, requests } = makeManager(() => [location(file, 0, 0)]);
    await call({ operation: "goToImplementation", filePath: file, line: 1, character: 1 }, ctxFor(dir, manager));
    expect(requests[0].method).toBe("textDocument/implementation");
  });

  it("findReferences asks for declarations too and lists each location", async () => {
    const other = join(dir, "lib", "b.dart");
    writeFileSync(other, "int b;\n", "utf-8");
    const { manager, requests } = makeManager(() => [location(file, 0, 0), location(other, 3, 2)]);

    const out = await call(
      { operation: "findReferences", filePath: file, line: 1, character: 1 },
      ctxFor(dir, manager),
    );

    expect(requests[0].params.context).toEqual({ includeDeclaration: true });
    expect(out.content).toContain("lib/a.dart:1:1");
    expect(out.content).toContain("lib/b.dart:4:3");
  });

  it("hover flattens a MarkupContent body", async () => {
    const { manager } = makeManager(() => ({ contents: { kind: "markdown", value: "```dart\nint a\n```" } }));
    const out = await call({ operation: "hover", filePath: file, line: 1, character: 5 }, ctxFor(dir, manager));
    expect(out.content).toContain("int a");
  });

  it("hover flattens the legacy string-array form", async () => {
    const { manager } = makeManager(() => ({ contents: ["int a", "a variable"] }));
    const out = await call({ operation: "hover", filePath: file, line: 1, character: 5 }, ctxFor(dir, manager));
    expect(out.content).toContain("int a");
    expect(out.content).toContain("a variable");
  });

  it("documentSymbol renders hierarchical symbols with a readable kind", async () => {
    const { manager, requests } = makeManager(() => [
      {
        name: "a",
        kind: 13,
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 10 } },
        selectionRange: { start: { line: 0, character: 4 }, end: { line: 0, character: 5 } },
      },
    ]);
    const out = await call({ operation: "documentSymbol", filePath: file }, ctxFor(dir, manager));

    expect(requests[0].method).toBe("textDocument/documentSymbol");
    expect(out.content).toContain("variable a");
    expect(out.content).toContain("lib/a.dart:1");
  });

  it("documentSymbol also accepts the flat SymbolInformation form", async () => {
    const { manager } = makeManager(() => [
      { name: "Widget", kind: 5, location: location(file, 6, 0) },
    ]);
    const out = await call({ operation: "documentSymbol", filePath: file }, ctxFor(dir, manager));
    expect(out.content).toContain("class Widget");
    expect(out.content).toContain("lib/a.dart:7");
  });

  it("workspaceSymbol requires a query and sends it", async () => {
    const { manager, requests } = makeManager(() => [{ name: "Widget", kind: 5, location: location(file, 6, 0) }]);

    const missing = await call({ operation: "workspaceSymbol", filePath: file }, ctxFor(dir, manager));
    expect(missing.error).toBe("query is required for workspaceSymbol");

    const out = await call({ operation: "workspaceSymbol", filePath: file, query: "Widget" }, ctxFor(dir, manager));
    expect(requests[0]).toMatchObject({ method: "workspace/symbol", params: { query: "Widget" } });
    expect(out.content).toContain("class Widget");
  });

  it("prepareCallHierarchy returns the first prepared item's location", async () => {
    const { manager, requests } = makeManager(() => [
      { name: "run", kind: 12, ...location(file, 9, 2) },
    ]);
    const out = await call({ operation: "prepareCallHierarchy", filePath: file, line: 10, character: 3 }, ctxFor(dir, manager));
    expect(requests[0].method).toBe("textDocument/prepareCallHierarchy");
    expect(out.content).toContain("lib/a.dart:10:3");
  });

  it("incomingCalls prepares first, then passes the item through", async () => {
    const item = { name: "run", kind: 12, ...location(file, 9, 2) };
    const { manager, requests } = makeManager((method, _params) => {
      if (method === "textDocument/prepareCallHierarchy") return [item];
      return [{ from: { name: "main", kind: 12, uri: uri, range: { start: { line: 20, character: 0 }, end: { line: 20, character: 4 } } } }];
    });

    const out = await call({ operation: "incomingCalls", filePath: file, line: 10, character: 3 }, ctxFor(dir, manager));

    expect(requests.map((r) => r.method)).toEqual([
      "textDocument/prepareCallHierarchy",
      "callHierarchy/incomingCalls",
    ]);
    expect(requests[1].params.item).toEqual(item);
    expect(out.content).toContain("main");
    expect(out.content).toContain("lib/a.dart:21");
  });

  it("outgoingCalls uses callHierarchy/outgoingCalls", async () => {
    const item = { name: "run", kind: 12, ...location(file, 9, 2) };
    const { manager, requests } = makeManager((method) =>
      method === "textDocument/prepareCallHierarchy"
        ? [item]
        : [{ to: { name: "helper", kind: 12, uri, range: { start: { line: 30, character: 0 }, end: { line: 30, character: 6 } } } }],
    );

    const out = await call({ operation: "outgoingCalls", filePath: file, line: 10, character: 3 }, ctxFor(dir, manager));
    expect(requests[1].method).toBe("callHierarchy/outgoingCalls");
    expect(out.content).toContain("helper");
  });

  it("returns No results (unwrapped — nib's own voice) for an empty answer", async () => {
    const { manager } = makeManager(() => []);
    const out = await call({ operation: "goToDefinition", filePath: file, line: 1, character: 1 }, ctxFor(dir, manager));
    expect(out.content).toBe("No results");
    expect(parseUntrustedMarker(out.content)).toBeUndefined();
  });

  it("returns No results when prepareCallHierarchy finds nothing", async () => {
    const { manager, requests } = makeManager(() => []);
    const out = await call({ operation: "incomingCalls", filePath: file, line: 1, character: 1 }, ctxFor(dir, manager));
    expect(out.content).toBe("No results");
    expect(requests).toHaveLength(1);
  });

  it("wraps server-supplied text as untrusted content with matching markers", async () => {
    const { manager } = makeManager(() => [location(file, 0, 0)]);
    const out = await call({ operation: "goToDefinition", filePath: file, line: 1, character: 1 }, ctxFor(dir, manager));

    const lines = out.content.split("\n");
    const markers = lines.map(parseUntrustedMarker).filter(Boolean);
    expect(markers).toHaveLength(2);
    expect(markers[0]!.id).toBe(markers[1]!.id);
  });

  it("caps the output at 50 lines", async () => {
    const many = Array.from({ length: 80 }, (_, i) => location(file, i, 0));
    const { manager } = makeManager(() => many);
    const out = await call({ operation: "findReferences", filePath: file, line: 1, character: 1 }, ctxFor(dir, manager));

    const locationLines = out.content.split("\n").filter((l) => /^lib\/a\.dart:\d+:\d+$/.test(l));
    expect(locationLines).toHaveLength(50);
  });

  it("strips control characters from a hover body", async () => {
    const { manager } = makeManager(() => ({ contents: "int a\u001B[31m red\u0007" }));
    const out = await call({ operation: "hover", filePath: file, line: 1, character: 1 }, ctxFor(dir, manager));
    expect(out.content).not.toContain("\u001B");
    expect(out.content).not.toContain("\u0007");
    expect(out.content).toContain("int a[31m red");
  });

  it("surfaces a transport error as nib's own voice", async () => {
    const manager = {
      workspaceRoot: dir,
      hasServers: true,
      serverFor: () => ({
        syncFile: async () => {},
        request: async () => {
          throw new Error("LSP request timed out after 10000ms (textDocument/hover)");
        },
      }),
      serverNameFor: () => "dart",
      diagnosticsFor: async () => new Map(),
    } as unknown as LspManager;

    const out = await call({ operation: "hover", filePath: file, line: 1, character: 1 }, ctxFor(dir, manager));
    expect(out.error).toContain("timed out");
    expect(parseUntrustedMarker(out.error!)).toBeUndefined();
  });

  it("gets a server that could not start into the error path, not a crash", async () => {
    const manager = {
      workspaceRoot: dir,
      hasServers: true,
      serverFor: () => ({
        syncFile: async () => {
          throw new Error("dart: spawn ENOENT");
        },
        request: async () => ({}),
      }),
      serverNameFor: () => "dart",
      diagnosticsFor: async () => new Map(),
    } as unknown as LspManager;

    const out = await call({ operation: "hover", filePath: file, line: 1, character: 1 }, ctxFor(dir, manager));
    expect(out.error).toContain("ENOENT");
  });
});
