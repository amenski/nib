import { describe, it, expect, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ToolRegistry } from "./registry.js";
import { registerFiles } from "./files.js";
import type { ToolContext } from "./types.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);

describe("read_file", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "heirloom-readfile-"));
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
