import { describe, it, expect, vi } from "vitest";
import { JsonRpcConnection, type Transport } from "./client.js";
import { createFakeLspServer } from "./testing/fake-server.js";

/**
 * A transport with no peer at all: it records writes and lets the test inject
 * raw bytes, which is what the framing/failure paths need directly.
 */
function makeTransport() {
  const written: Buffer[] = [];
  const dataHandlers: Array<(chunk: Buffer) => void> = [];
  const closeHandlers: Array<(code: number | null, stderrTail: string) => void> = [];
  let killed = false;
  const transport: Transport = {
    write: (bytes) => written.push(bytes),
    onData: (cb) => dataHandlers.push(cb),
    onClose: (cb) => closeHandlers.push(cb),
    kill: () => {
      killed = true;
    },
  };
  return {
    transport,
    written,
    killed: () => killed,
    /** Feed one JSON-RPC message the way a child's stdout would. */
    emit: (message: unknown) => {
      const body = Buffer.from(JSON.stringify(message), "utf-8");
      const bytes = Buffer.concat([
        Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"),
        body,
      ]);
      for (const handler of dataHandlers) handler(bytes);
    },
    /** Emit raw bytes, bypassing framing — for the desync path. */
    emitRaw: (bytes: Buffer) => {
      for (const handler of dataHandlers) handler(bytes);
    },
    close: (code: number | null = 1, stderrTail = "") => {
      for (const handler of closeHandlers) handler(code, stderrTail);
    },
  };
}

/** The last message the connection wrote, decoded. */
function lastWritten(written: Buffer[]): any {
  const buffer = written[written.length - 1]!;
  const headerEnd = buffer.indexOf("\r\n\r\n");
  return JSON.parse(buffer.subarray(headerEnd + 4).toString("utf-8"));
}

describe("JsonRpcConnection", () => {
  it("resolves a request with the response payload", async () => {
    const peer = makeTransport();
    const conn = new JsonRpcConnection(peer.transport);

    const pending = conn.request<{ ok: true }>("initialize", { a: 1 });
    const sent = lastWritten(peer.written);
    expect(sent).toMatchObject({ jsonrpc: "2.0", id: sent.id, method: "initialize", params: { a: 1 } });

    peer.emit({ jsonrpc: "2.0", id: sent.id, result: { ok: true } });
    await expect(pending).resolves.toEqual({ ok: true });
  });

  it("rejects with the server's error message", async () => {
    const peer = makeTransport();
    const conn = new JsonRpcConnection(peer.transport);
    const pending = conn.request("textDocument/hover", {});
    const sent = lastWritten(peer.written);
    peer.emit({ jsonrpc: "2.0", id: sent.id, error: { code: -32601, message: "no hover" } });
    await expect(pending).rejects.toThrow("LSP error -32601: no hover");
  });

  it("times out a request that gets no answer", async () => {
    vi.useFakeTimers();
    try {
      const peer = makeTransport();
      const conn = new JsonRpcConnection(peer.transport);
      const pending = conn.request("slow", {}, 100);
      const assertion = expect(pending).rejects.toThrow("timed out after 100ms (slow)");
      await vi.advanceTimersByTimeAsync(101);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("answers a server-initiated request with the handler's result", () => {
    const peer = makeTransport();
    const conn = new JsonRpcConnection(peer.transport);
    conn.onRequest((method) => (method === "workspace/configuration" ? ["cfg"] : null));

    peer.emit({ jsonrpc: "2.0", id: "srv-1", method: "workspace/configuration", params: {} });

    expect(lastWritten(peer.written)).toEqual({ jsonrpc: "2.0", id: "srv-1", result: ["cfg"] });
  });

  it("answers an unhandled server request with -32601", () => {
    const peer = makeTransport();
    const conn = new JsonRpcConnection(peer.transport);
    conn.onRequest(() => {
      throw new Error("method not found: weird/thing");
    });

    peer.emit({ jsonrpc: "2.0", id: 5, method: "weird/thing" });

    const reply = lastWritten(peer.written);
    expect(reply.id).toBe(5);
    expect(reply.error.code).toBe(-32603);
  });

  it("delivers notifications to the notification handler", () => {
    const peer = makeTransport();
    const conn = new JsonRpcConnection(peer.transport);
    const seen: Array<[string, unknown]> = [];
    conn.onNotification((method, params) => seen.push([method, params]));

    peer.emit({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri: "file:///a.dart" } });

    expect(seen).toEqual([["textDocument/publishDiagnostics", { uri: "file:///a.dart" }]]);
  });

  it("rejects every pending request when the server exits", async () => {
    const peer = makeTransport();
    const conn = new JsonRpcConnection(peer.transport);
    const first = conn.request("a", {});
    const second = conn.request("b", {});
    peer.close(1, "boom");

    await expect(first).rejects.toThrow("exited with code 1");
    await expect(second).rejects.toThrow("exited with code 1");
  });

  it("reports the close once and refuses new requests afterwards", async () => {
    const peer = makeTransport();
    const conn = new JsonRpcConnection(peer.transport);
    const onClose = vi.fn();
    conn.onClose(onClose);
    peer.close(2);
    peer.close(3);

    expect(onClose).toHaveBeenCalledTimes(1);
    await expect(conn.request("nope", {})).rejects.toThrow("connection closed");
  });

  it("treats an unframeable chunk as a crash rather than desynchronizing", async () => {
    const peer = makeTransport();
    const conn = new JsonRpcConnection(peer.transport);
    const onClose = vi.fn();
    conn.onClose(onClose);
    const pending = conn.request("a", {});

    peer.emitRaw(Buffer.from("garbage without a length\r\n\r\n{}", "ascii"));

    expect(onClose).toHaveBeenCalledTimes(1);
    await expect(pending).rejects.toThrow(/exited|disposed/);
    expect(peer.killed()).toBe(true);
  });

  it("notifies without allocating a response slot", () => {
    const peer = makeTransport();
    const conn = new JsonRpcConnection(peer.transport);
    conn.notify("initialized", {});
    const sent = lastWritten(peer.written);
    expect(sent).toEqual({ jsonrpc: "2.0", method: "initialized", params: {} });
    expect(sent.id).toBeUndefined();
  });

  it("round-trips against the scripted fake server", async () => {
    const fake = createFakeLspServer();
    const conn = new JsonRpcConnection(fake.client);
    conn.notify("initialized", {});

    await expect(conn.request("initialize", {})).resolves.toMatchObject({
      serverInfo: { name: "fake" },
    });
    expect(fake.received.map((m) => m.method)).toContain("initialize");
  });
});
