import { describe, it, expect } from "vitest";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("MemoryStore home routing", () => {
  it("routes memory under an explicit home argument", async () => {
    const custom = mkdtempSync(join(tmpdir(), "nib-mem-home-"));
    try {
      const { MemoryStore } = await import("./store.js");
      const ms = new MemoryStore(process.cwd(), custom);
      await ms.init();
      expect(existsSync(join(custom, "memory", "MEMORY.md"))).toBe(true);
    } finally {
      rmSync(custom, { recursive: true, force: true });
    }
  });
});
