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

  it("redacts secrets from persisted request messages and tool metadata", async () => {
    vi.resetModules();
    const { enableDebug, logRequest } = await import("./logger.js");
    enableDebug("sess-request-redaction");
    logRequest({
      model: "test-model",
      messages: [
        { role: "user", content: "Use token: 'request-token-that-is-long-enough'" },
        { role: "system", content: "Authorization: Bearer request-bearer-token-123456; api_key=d41d8cd98f00b204e9800998ecf8427e; sk-proj1234567890abcdefghij" },
      ],
      tools: [{ function: { name: "send" } }],
      max_tokens: 64,
    });

    const file = join(projectDirPath(TEST_DIR), "debug", "sess-request-redaction.jsonl");
    const persisted = readFileSync(file, "utf8");
    expect(persisted).not.toContain("request-token-that-is-long-enough");
    expect(persisted).not.toContain("request-bearer-token-123456");
    expect(persisted).not.toContain("sk-proj1234567890abcdefghij");
    expect(persisted).toContain("[redacted-token]");
    expect(persisted).toContain("[redacted-authorization]");
    expect(persisted).toContain("[redacted-api-key]");
  });

  it("redacts secrets from persisted tool-call arguments", async () => {
    vi.resetModules();
    const { enableDebug, logResponse } = await import("./logger.js");
    enableDebug("sess-tool-redaction");
    logResponse(
      { inputTokens: 3, metadata: { secret: "response-secret-value-123456" } },
      [
        {
          name: "send",
          function: { arguments: '{"password":"response-password-value-123456"}' },
        },
        { name: "fetch", args: "Authorization: Bearer response-bearer-token-123456" },
      ],
    );

    const file = join(projectDirPath(TEST_DIR), "debug", "sess-tool-redaction.jsonl");
    const persisted = readFileSync(file, "utf8");
    expect(persisted).not.toContain("response-secret-value-123456");
    expect(persisted).not.toContain("response-password-value-123456");
    expect(persisted).not.toContain("response-bearer-token-123456");
    expect(persisted).toContain("[redacted-secret]");
    expect(persisted).toContain("[redacted-password]");
    expect(persisted).toContain("[redacted-authorization]");
  });
});
