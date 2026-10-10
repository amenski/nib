import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { projectDirPath } from "../config/paths.js";

const TEST_DIR = join(tmpdir(), `nib-aisdk-debug-${process.pid}`);

/**
 * The fake fullStream the mocked `streamText` hands back. Every other export is
 * a passthrough stub — this file never reaches the SDK's real machinery, so no
 * request is attempted.
 */
let streamEvents: unknown[] = [];
vi.mock("ai", () => ({
  streamText: () => ({
    fullStream: (async function* () {
      for (const event of streamEvents) {
        // An entry that is an Error models the iterator itself throwing (a
        // network failure), which never produces an `error` event.
        if (event instanceof Error) throw event;
        yield event;
      }
    })(),
  }),
  tool: (def: unknown) => def,
  jsonSchema: (schema: unknown) => schema,
  stepCountIs: () => () => false,
}));

describe("streamChat failure rows", () => {
  const originalCwd = process.cwd();

  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    process.chdir(TEST_DIR);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  /** Drives the real streamChat against the fake stream, with debug logging on. */
  async function runStream(
    events: unknown[],
    options?: { signal?: AbortSignal },
  ): Promise<{ error: unknown; rows: any[] }> {
    vi.resetModules();
    streamEvents = events;
    const { enableDebug } = await import("../debug/logger.js");
    enableDebug("sess-stream");
    const { createAISDKProvider } = await import("./aisdk.js");
    const provider = createAISDKProvider(
      { api: "openai", baseUrl: "https://example.invalid/v1" } as never,
      "test-model",
      "test-key",
    );

    let error: unknown;
    try {
      for await (const _ of provider.streamChat([{ role: "user", content: "hi" }], [], options)) {
        // drain
      }
    } catch (err) {
      error = err;
    }
    const file = join(projectDirPath(TEST_DIR), "debug", "sess-stream.jsonl");
    const rows = readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    return { error, rows };
  }

  it("writes an error row when the provider emits an error event, and rethrows it", async () => {
    const boom = new Error("provider exploded");
    const { error, rows } = await runStream([boom]);

    expect(error).toBe(boom);
    const errors = rows.filter((r) => r.type === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0].phase).toBe("provider-stream");
    expect(errors[0].error.message).toBe("provider exploded");
  });

  it("writes an error row when the stream throws out of the iterator", async () => {
    const { error, rows } = await runStream([new Error("socket hang up")]);

    expect((error as Error).message).toBe("socket hang up");
    expect(rows.filter((r) => r.type === "error")).toHaveLength(1);
  });

  it("writes an error row for a stream that ends without finish-step", async () => {
    const { error, rows } = await runStream([{ type: "text-delta", text: "partial" }]);

    expect(error).toBeUndefined();
    const errors = rows.filter((r) => r.type === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0].error.message).toContain("finish-step");
    // The request row is there with no response row beside it — the shape the
    // unexplained 10:01 stop left in the log.
    expect(rows.filter((r) => r.type === "request")).toHaveLength(1);
    expect(rows.filter((r) => r.type === "response")).toHaveLength(0);
  });

  it("writes no error row for a normal finished stream", async () => {
    const { rows } = await runStream([
      { type: "text-delta", text: "hi" },
      { type: "finish-step", usage: { inputTokens: 1, outputTokens: 1 } },
      { type: "finish", finishReason: "stop" },
    ]);

    expect(rows.filter((r) => r.type === "error")).toHaveLength(0);
    expect(rows.filter((r) => r.type === "response")).toHaveLength(1);
  });

  it("writes no error row when the turn was aborted by the user", async () => {
    const controller = new AbortController();
    controller.abort();
    const { error, rows } = await runStream([new Error("aborted")], { signal: controller.signal });

    expect(error).toBeInstanceOf(Error);
    expect(rows.filter((r) => r.type === "error")).toHaveLength(0);
  });
});
