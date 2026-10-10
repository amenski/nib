import { describe, it, expect, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ToolRegistry } from "./registry.js";
import { registerFiles } from "./files.js";
import type { ToolContext } from "./types.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);

describe("read_file", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nib-readfile-"));
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  const registry = new ToolRegistry();
  registerFiles(registry);

  function makeCtx(): ToolContext {
    return { workingDir: root, sessionId: "test", signal: new AbortController().signal, fileMtimes: new Map() };
  }

  const read = (p: string, ctx = makeCtx()) =>
    registry.execute({ id: "1", name: "read_file", arguments: { path: p } }, ctx);

  it("reads text with line numbers and records the mtime", async () => {
    const file = path.join(root, "a.ts");
    fs.writeFileSync(file, "export const a = 1;\nexport const b = 2;");
    const ctx = makeCtx();

    const result = await read(file, ctx);

    expect(result.error).toBeUndefined();
    expect(result.content).toContain("1: export const a = 1;");
    expect(result.content).toContain("2: export const b = 2;");
    expect(ctx.fileMtimes!.has(file)).toBe(true);
  });

  it("refuses an image instead of decoding it into mojibake", async () => {
    const file = path.join(root, "cat.png");
    fs.writeFileSync(file, PNG);

    const result = await read(file);

    expect(result.content).toContain("image/png image");
    expect(result.content).toContain("not text");
    // The model is given a next step rather than a dead end.
    expect(result.content).toContain("view_image");
    expect(result.content).toContain("@path");
    // No mojibake: the replacement character never reaches the model.
    expect(result.content).not.toContain("\uFFFD");
  });

  it("refuses a non-image binary with a generic message", async () => {
    const file = path.join(root, "blob.bin");
    fs.writeFileSync(file, Buffer.from([0x00, 0x01, 0x02, 0x03]));

    const result = await read(file);

    expect(result.content).toContain("binary file");
    expect(result.content).toContain("not text");
    expect(result.content).not.toContain("view_image");
  });

  it("still reports a missing file as an error", async () => {
    const result = await read(path.join(root, "nope.ts"));
    expect(result.content).toContain("Error reading file");
  });
});

describe("read_file line ranges (2026-10-10)", () => {
  // read_file only took a path, so reading part of a file meant `sed -n` in
  // run_bash — 354 Bash reads vs 105 read_file calls in one onramp session.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nib-readrange-"));
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
  const registry = new ToolRegistry();
  registerFiles(registry);
  const makeCtx = (): ToolContext => ({ workingDir: root, sessionId: "test", signal: new AbortController().signal, fileMtimes: new Map() });
  const read = (args: Record<string, unknown>, ctx = makeCtx()) =>
    registry.execute({ id: "1", name: "read_file", arguments: args }, ctx);
  const file = (name: string, lines: number) => {
    const p = path.join(root, name);
    fs.writeFileSync(p, Array.from({ length: lines }, (_, i) => `line ${i + 1}`).join("\n"));
    return p;
  };

  it("returns the requested range with real line numbers and a footer", async () => {
    const p = file("ten.txt", 10);
    const ctx = makeCtx();
    const r = await read({ path: p, offset: 4, limit: 3 }, ctx);
    expect(r.content).toContain("4: line 4");
    expect(r.content).toContain("6: line 6");
    expect(r.content).not.toContain("3: line 3");
    expect(r.content).not.toContain("7: line 7");
    expect(r.content).toContain("(lines 4–6 of 10. Use offset/limit to read more.)");
    expect(ctx.fileMtimes!.has(p)).toBe(true);
  });

  it("returns a whole short file unchanged, with no footer", async () => {
    const r = await read({ path: file("three.txt", 3) });
    expect(r.content).toContain("3: line 3");
    expect(r.content).not.toContain("Use offset/limit");
  });

  it("reports an offset past the end with the line count", async () => {
    const p = file("five.txt", 5);
    const r = await read({ path: p, offset: 9 });
    expect(r.content).toBe(`Error reading file: ${p} has 5 lines; offset 9 is past the end.`);
  });

  it("caps at 2000 lines and says how to read on", async () => {
    const p = file("big.txt", 2500);
    const r = await read({ path: p, limit: 5000 });
    expect(r.content).toContain("2000: line 2000");
    expect(r.content).not.toContain("2001: line 2001");
    expect(r.content).toContain("(lines 1–2000 of 2500. Use offset/limit to read more.)");
  });

  it("ignores non-integer or non-positive values", async () => {
    const r = await read({ path: file("four.txt", 4), offset: 0, limit: -2 });
    expect(r.content).toContain("1: line 1");
    expect(r.content).toContain("4: line 4");
  });
});
