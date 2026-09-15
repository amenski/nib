import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { projectDirPath } from "../config/paths.js";
import { tmpdir } from "node:os";

const TEST_DIR = join(tmpdir(), `nib-debug-logger-${process.pid}`);

describe("debug logger timing", () => {
  const originalCwd = process.cwd();

  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    process.chdir(TEST_DIR);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("does nothing before enableDebug is called", async () => {
    vi.resetModules();
    const { logTiming } = await import("./logger.js");
    logTiming({ phase: "prompt_assembly", durationsMs: { total: 1 } });
    expect(existsSync(join(projectDirPath(TEST_DIR), "debug"))).toBe(false);
  });

  it("writes a timing row once enabled", async () => {
    vi.resetModules();
    const { enableDebug, logTiming } = await import("./logger.js");
    enableDebug("sess-timing");
    logTiming({
      phase: "request",
      model: "deepseek-v4-flash",
      effort: "low",
      promptBytes: 42,
      toolCount: 0,
      cachedTokens: 10,
      durationsMs: { total: 120, toFirstEvent: 80, toFirstText: 90 },
    });

    const file = join(projectDirPath(TEST_DIR), "debug", "sess-timing.jsonl");
    const lines = readFileSync(file, "utf8").trim().split("\n");
    const entry = JSON.parse(lines[lines.length - 1]);
    expect(entry.type).toBe("timing");
    expect(entry.phase).toBe("request");
    expect(entry.model).toBe("deepseek-v4-flash");
    expect(entry.durationsMs).toEqual({ total: 120, toFirstEvent: 80, toFirstText: 90 });
  });
});
