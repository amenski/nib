import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RepoMap, lspKindToMapKind } from "./index.js";
import { REPOMAP_BYTE_BUDGET } from "../prompt.js";
import type { WireSymbol } from "../lsp/protocol.js";

const ROOT = join(tmpdir(), `nib-repomap-${process.pid}`);

beforeEach(() => {
  mkdirSync(join(ROOT, "src"), { recursive: true });
  writeFileSync(
    join(ROOT, "src/utils.ts"),
    [
      "export function formatName(name: string): string {",
      "  return name.trim();",
      "}",
      "",
      "const internal = 1;",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(ROOT, "src/api.ts"),
    [
      'import { formatName } from "./utils.js";',
      "",
      "export class Client extends Base {",
      "  ready: boolean = false;",
      "  async send(body: string): Promise<void> {}",
      "}",
      "",
    ].join("\n"),
  );
});

afterEach(() => rmSync(ROOT, { recursive: true, force: true }));

describe("RepoMap interface-level detail (docs/todo.md D8)", () => {
  it("renders exported signatures", async () => {
    const map = new RepoMap(ROOT);
    const out = await map.getMap("", 1024);
    expect(out).toContain("function formatName(name: string): string");
  });

  it("renders import edges", async () => {
    const map = new RepoMap(ROOT);
    const out = await map.getMap("", 1024);
    expect(out).toMatch(/src\/api\.ts:.*imports src\/utils\.ts/);
  });

  it("renders private symbols with signatures when a file has no exports", async () => {
    writeFileSync(
      join(ROOT, "src/legacy.ts"),
      ['import { formatName } from "./utils.js";', "", "class Legacy {", "  count: number = 0;", "  bump(step: number): number {", "    this.count += step;", "    return this.count;", "  }", "}", ""].join("\n"),
    );
    const map = new RepoMap(ROOT);
    const out = await map.getMap("", 1024);
    expect(out).toContain("method Legacy.bump(step: number): number");
    expect(out).toContain("property Legacy.count: number");
  });

  it("is byte-stable across builds on an unchanged tree", async () => {
    const map = new RepoMap(ROOT);
    const first = await map.getMap("", 1024);
    const second = await map.getMap("", 1024);
    expect(first).toBe(second);
  });
});

describe("RepoMap LSP-sourced symbols (docs/todo.md D8)", () => {
  const pythonSymbols: WireSymbol[] = [
    { name: "serve", kind: "Function", path: "", line: 3 },
    { name: "Server", kind: "Class", path: "", line: 10 },
  ];

  it("a .py fixture with a configured LSP gets a map containing its symbols", async () => {
    writeFileSync(join(ROOT, "src/main.py"), "def serve():\n    pass\n\nclass Server:\n    pass\n");
    const map = new RepoMap(ROOT, {
      extraExtensions: [".py"],
      documentSymbols: async (path) => (path.endsWith(".py") ? pythonSymbols : []),
    });
    const out = await map.getMap("", 1024);
    expect(out).toContain("function serve");
    expect(out).toContain("class Server");
  });

  it("a failing or absent LSP source skips the file without killing the map", async () => {
    writeFileSync(join(ROOT, "src/broken.py"), "def x():\n    pass\n");
    const failing = new RepoMap(ROOT, {
      extraExtensions: [".py"],
      documentSymbols: async () => {
        throw new Error("server down");
      },
    });
    expect(await failing.getMap("", 1024)).not.toBe("(empty repository)");

    const absent = new RepoMap(ROOT, { extraExtensions: [".py"] });
    expect(await absent.getMap("", 1024)).not.toBe("(empty repository)");
  });
});

describe("map budget", () => {
  it("stays within the byte budget under a large tree", async () => {
    for (let i = 0; i < 40; i++) {
      writeFileSync(
        join(ROOT, `src/gen${i}.ts`),
        [...Array(20)].map((_, j) => `export function gen${i}_${j}(a: string, b: number): string { return ""; }`).join("\n") + "\n",
      );
    }
    const map = new RepoMap(ROOT);
    const out = await map.getMap("", Math.floor(REPOMAP_BYTE_BUDGET / 4));
    if (out !== "(empty repository)") {
      expect(out.length).toBeLessThanOrEqual(REPOMAP_BYTE_BUDGET);
    }
  });
});

describe("lspKindToMapKind", () => {
  it("maps the LSP kind names symbolsFromWire emits", () => {
    expect(lspKindToMapKind("function")).toBe("function");
    expect(lspKindToMapKind("class")).toBe("class");
    expect(lspKindToMapKind("method")).toBe("method");
    expect(lspKindToMapKind("constant")).toBe("constant");
    expect(lspKindToMapKind("namespace")).toBe("module");
    expect(lspKindToMapKind("struct")).toBe("struct");
    expect(lspKindToMapKind("variable")).toBe("variable");
    expect(lspKindToMapKind("galaxy")).toBe("variable");
  });
});
