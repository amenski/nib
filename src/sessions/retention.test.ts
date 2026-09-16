import { describe, it, expect, afterEach } from "vitest";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionStore, slugify } from "./store.js";

describe("SessionStore retention", () => {
  const homes: string[] = [];

  afterEach(() => {
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
  });

  it("keeps the active session, prunes only project JSONL files, and leaves sibling state alone", async () => {
    const home = join(tmpdir(), `nib-session-retention-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    homes.push(home);
    const store = new SessionStore(home, { maxSessions: 2 });
    const meta = { cwd: process.cwd(), provider: "test", model: "test", mode: "general" };
    const ids = [await store.create(meta), await store.create(meta), await store.create(meta)];

    const sibling = join(home, "sessions", "sibling-project", "keep.jsonl");
    mkdirSync(join(home, "sessions", "sibling-project"), { recursive: true });
    writeFileSync(sibling, "keep me\n");

    const removed = await store.pruneRetention(ids[2]);
    expect(removed).toBe(1);

    const remaining = await store.list();
    expect(remaining).toHaveLength(2);
    expect(remaining.map((entry) => entry.id)).toContain(ids[2]);
    expect(existsSync(sibling)).toBe(true);

    const projectSessionDir = join(home, "sessions", slugify(process.cwd()));
    const deletedIds = ids.filter((id) => !existsSync(join(projectSessionDir, `${id}.jsonl`)));
    expect(deletedIds).toHaveLength(1);
    expect(deletedIds).not.toContain(ids[2]);
  });
});
