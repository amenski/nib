import { MessageDecoder, encodeMessage } from "./framing.js";

/**
 * A bidirectional byte stream to an LSP child process. Abstracted from the
 * spawn so tests can drive a scripted in-memory server (lsp/testing/fake-server)
 * without a real process — the same injectable seam MCPClient gets from
 * `spawnContained`.
 */
export interface Transport {
  write(bytes: Buffer): void;
  onData(cb: (chunk: Buffer) => void): void;
  /** Fires once, when the child closed or is killed. `stderrTail` is diagnostic context for a crash note. */
  onClose(cb: (code: number | null, stderrTail: string) => void): void;
  kill(): void;
}

type JsonRpcId = number | string;

interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
}

/** Default bound for a request/response round trip — the same 10 s MCP uses. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

/**
 * JSON-RPC 2.0 over an LSP transport.
 *
 * Responsibilities deliberately kept here, not in LspServer: id allocation,
 * pending-request bookkeeping, timeouts, answering server→client requests, and
 * rejecting everything in flight when the stream dies. A connection never
 * interprets LSP semantics — it does not know what a diagnostic is.
 */
export class JsonRpcConnection {
  private nextId = 1;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private readonly decoder = new MessageDecoder();
  private requestHandler: ((method: string, params: unknown) => unknown) | undefined;
  private notificationHandler: ((method: string, params: unknown) => void) | undefined;
  private closeHandler: ((code: number | null, stderrTail: string) => void) | undefined;
  private closed = false;

  constructor(private readonly transport: Transport) {
    // The transport pushes raw chunks; the decoder owns message boundaries.
    this.transport.onData((chunk) => this.receive(chunk));
    this.transport.onClose((code, stderrTail) => this.handleClose(code, stderrTail));
  }

  /**
   * Answers server→client requests. Returning `undefined` is sent as an empty
   * result; an unhandled method is answered by `onUnhandledRequest` below with
   * the JSON-RPC "method not found" code.
   */
  onRequest(handler: (method: string, params: unknown) => unknown): void {
    this.requestHandler = handler;
  }

  onNotification(handler: (method: string, params: unknown) => void): void {
    this.notificationHandler = handler;
  }

  onClose(handler: (code: number | null, stderrTail: string) => void): void {
    this.closeHandler = handler;
  }

  request<T>(method: string, params?: unknown, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<T> {
    if (this.closed) {
      return Promise.reject(new Error(`LSP connection closed (${method})`));
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      // A timeout is not an option to retry: the request may still land, and a
      // duplicate `initialize`/`hover` would corrupt the server's state.
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(id);
              reject(new Error(`LSP request timed out after ${timeoutMs}ms (${method})`));
            }, timeoutMs)
          : undefined;
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
      this.transport.write(encodeMessage({ jsonrpc: "2.0", id, method, params }));
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.closed) return;
    this.transport.write(encodeMessage({ jsonrpc: "2.0", method, params }));
  }

  /** Kill the transport and reject everything still waiting on a response. */
  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    this.failPending(new Error("LSP connection disposed"));
    this.transport.kill();
  }

  private receive(chunk: Buffer): void {
    let messages: unknown[];
    try {
      messages = this.decoder.push(chunk);
    } catch (err) {
      // Unrecoverable framing: no way to find the next message boundary, so
      // the connection is dead rather than desynchronized. Treated exactly
      // like a crash so the caller's restart policy applies.
      this.handleClose(null, (err as Error).message);
      this.transport.kill();
      return;
    }
    for (const message of messages) this.dispatch(message);
  }

  private dispatch(message: unknown): void {
    if (typeof message !== "object" || message === null) return;
    const msg = message as Record<string, unknown>;

    // Response to one of ours: has an id and no method.
    if ("id" in msg && !("method" in msg)) {
      const pending = this.pending.get(msg.id as JsonRpcId);
      if (!pending) return;
      this.pending.delete(msg.id as JsonRpcId);
      if (pending.timer !== undefined) clearTimeout(pending.timer);
      const error = msg.error as JsonRpcError | undefined;
      if (error) {
        pending.reject(new Error(`LSP error ${error.code}: ${error.message}`));
      } else {
        pending.resolve(msg.result);
      }
      return;
    }

    const method = typeof msg.method === "string" ? msg.method : undefined;
    if (!method) return;

    // Server→client request: must be answered or the server may block.
    if ("id" in msg) {
      const handler = this.requestHandler;
      let result: unknown;
      let error: JsonRpcError | undefined;
      if (!handler) {
        error = { code: -32601, message: `unhandled request: ${method}` };
      } else {
        try {
          result = handler(method, msg.params);
        } catch (err) {
          error = { code: -32603, message: (err as Error).message };
        }
      }
      if (this.closed) return;
      this.transport.write(
        encodeMessage(
          error
            ? { jsonrpc: "2.0", id: msg.id, error }
            : { jsonrpc: "2.0", id: msg.id, result: result ?? null },
        ),
      );
      return;
    }

    this.notificationHandler?.(method, msg.params);
  }

  private handleClose(code: number | null, stderrTail: string): void {
    const wasOpen = !this.closed;
    this.closed = true;
    this.failPending(new Error(`LSP server exited${code !== null ? ` with code ${code}` : ""}`));
    if (wasOpen) this.closeHandler?.(code, stderrTail);
  }

  private failPending(err: Error): void {
    for (const [, pending] of this.pending) {
      if (pending.timer !== undefined) clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pending.clear();
  }
}
