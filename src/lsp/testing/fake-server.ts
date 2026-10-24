import type { Transport } from "../client.js";
import { MessageDecoder, encodeMessage } from "../framing.js";

/**
 * A scripted in-memory language server for tests.
 *
 * Two paired transports (`client` / `server`) stand in for the child's
 * stdin/stdout pipes, so the whole client/server stack — framing, JSON-RPC,
 * lifecycle, diagnostic waiting — runs against a deterministic peer with no
 * process and no timing flakiness.
 *
 * Behaviours covered, one option each:
 *  - records `didOpen`/`didChange` per URI (so version++ is assertable),
 *  - emits a scheduled sequence of `publishDiagnostics` per path,
 *  - emits `$/progress` begin/end,
 *  - sends a server→client request and records the answer,
 *  - simulates a crash (`close()`), which the client sees as an exit.
 */
export interface PublishedSequence {
  /** Diagnostics published by this step, as [line, character, severity, message, code?] tuples. 0-based, like the wire. */
  diagnostics: Array<[number, number, number, string, (string | number)?]>;
  /** Delay before this publish, in ms. Default 0. */
  delayMs?: number;
}

export interface FakeServerScript {
  /**
   * Per-file publish groups, keyed by absolute path. The Nth entry is what the
   * Nth sync (`didOpen`, then each `didChange`) publishes; each group may hold
   * several publishes so the empty-then-real sequence a real server emits on
   * one sync is expressible.
   */
  publishes?: Record<string, PublishedSequence[][]>;
  /** Emit `$/progress` begin before the first publish and end after the last. */
  progress?: boolean;
  /** A server→client request to send after `initialize` (e.g. workspace/configuration). */
  serverRequest?: { method: string; params?: unknown };
  /** Reply with an error to `initialize` instead of a result. */
  failInitialize?: string;
}

export interface FakeServerHandles {
  /** Transport to hand to JsonRpcConnection (the "child side"). */
  client: Transport;
  /** Any message the client wrote. */
  received: Array<Record<string, unknown>>;
  /** Server→client requests answered by the client, method + result. */
  answered: Array<{ method: string; result: unknown }>;
  /** Current on-disk content per absolute path, keyed by URI. */
  opened: Map<string, { version: number; text: string }>;
  /** Simulate the process dying. */
  crash(): void;
  /** Resolves once the given URI reached `didOpen`/`didChange` at least `times` times. */
  waitForSync(uri: string, times?: number): Promise<void>;
}

export function createFakeLspServer(script: FakeServerScript = {}): FakeServerHandles {
  const toClient: Array<(chunk: Buffer) => void> = [];
  const toServer: Array<(chunk: Buffer) => void> = [];
  const closeHandlers: Array<(code: number | null, stderrTail: string) => void> = [];

  const received: Array<Record<string, unknown>> = [];
  const answered: Array<{ method: string; result: unknown }> = [];
  /** id → method for the server→client requests still awaiting an answer. */
  const pendingServerRequests = new Map<unknown, string>();
  let serverRequestId = 1;
  const opened = new Map<string, { version: number; text: string }>();
  const syncCounts = new Map<string, number>();
  const syncWaiters: Array<{ uri: string; times: number; resolve: () => void }> = [];
  const timers: Array<ReturnType<typeof setTimeout>> = [];
  let closed = false;

  const decoder = new MessageDecoder();

  const send = (message: unknown): void => {
    if (closed) return;
    const bytes = encodeMessage(message);
    for (const handler of toClient) handler(bytes);
  };

  const notify = (method: string, params?: unknown): void => {
    send({ jsonrpc: "2.0", method, params });
  };

  const publish = (uri: string, sequence: PublishedSequence): void => {
    notify("textDocument/publishDiagnostics", {
      uri,
      diagnostics: sequence.diagnostics.map(([line, character, severity, message, code]) => ({
        range: {
          start: { line, character },
          end: { line, character: character + 1 },
        },
        severity,
        message,
        ...(code !== undefined ? { code } : {}),
      })),
    });
  };

  const schedule = (sequence: PublishedSequence, fn: () => void): void => {
    const delay = sequence.delayMs ?? 0;
    if (delay === 0) {
      fn();
      return;
    }
    timers.push(setTimeout(fn, delay));
  };

  const handleSync = (method: string, params: any): void => {
    const uri: string | undefined = params?.textDocument?.uri;
    if (!uri) return;
    if (method === "textDocument/didOpen") {
      opened.set(uri, { version: params.textDocument.version, text: params.textDocument.text });
    } else if (method === "textDocument/didChange") {
      const change = params.contentChanges?.[0]?.text ?? "";
      opened.set(uri, { version: params.textDocument.version, text: change });
    } else {
      return;
    }

    const count = (syncCounts.get(uri) ?? 0) + 1;
    syncCounts.set(uri, count);
    for (const waiter of [...syncWaiters]) {
      if (waiter.uri === uri && count >= waiter.times) {
        syncWaiters.splice(syncWaiters.indexOf(waiter), 1);
        waiter.resolve();
      }
    }

    // The script is keyed by absolute path; the client only knows the URI.
    const path = uri.replace(/^file:\/\//, "");
    const groups = script.publishes?.[path] ?? script.publishes?.[decodeURIComponent(path)];
    if (!groups || groups.length === 0) return;
    if (count > groups.length) return;
    const group = groups[count - 1]!;

    if (script.progress && count === 1) notify("$/progress", { token: "fake-progress", value: { kind: "begin", title: "analysis" } });
    for (const sequence of group) schedule(sequence, () => publish(uri, sequence));
    if (script.progress && count === groups.length) {
      const last = group[group.length - 1];
      // Scheduled after the group's own publishes, in the same ordering.
      schedule({ diagnostics: [], delayMs: last?.delayMs ?? 0 }, () =>
        notify("$/progress", { token: "fake-progress", value: { kind: "end" } }),
      );
    }
  };

  const handleMessage = (message: Record<string, unknown>): void => {
    received.push(message);
    const method = message.method as string | undefined;

    // A response to a server→client request we sent.
    if (method === undefined && "id" in message) return;

    if (method === "initialize") {
      if (script.failInitialize) {
        send({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: script.failInitialize } });
        return;
      }
      send({ jsonrpc: "2.0", id: message.id, result: { capabilities: {}, serverInfo: { name: "fake" } } });
      return;
    }
    if (method === "initialized") {
      if (script.serverRequest) {
        const id = `srv-${serverRequestId++}`;
        pendingServerRequests.set(id, script.serverRequest.method);
        send({ jsonrpc: "2.0", id, method: script.serverRequest.method, params: script.serverRequest.params });
      }
      return;
    }
    if (method === "shutdown") {
      send({ jsonrpc: "2.0", id: message.id, result: null });
      return;
    }
    if (method === "exit") {
      crash(0);
      return;
    }
    if (method === "textDocument/didOpen" || method === "textDocument/didChange") {
      handleSync(method, message.params);
    }
  };

  const crash = (code: number | null = 1): void => {
    if (closed) return;
    closed = true;
    for (const timer of timers) clearTimeout(timer);
    for (const handler of closeHandlers) handler(code, "fake server crashed");
  };

  const client: Transport = {
    write(bytes: Buffer): void {
      for (const handler of toServer) handler(bytes);
    },
    onData(cb): void {
      toClient.push(cb);
    },
    onClose(cb): void {
      closeHandlers.push(cb);
    },
    kill(): void {
      crash(0);
    },
  };

  // The "child" reads what the client writes.
  toServer.push((chunk: Buffer) => {
    let messages: unknown[];
    try {
      messages = decoder.push(chunk);
    } catch {
      return;
    }
    for (const message of messages) {
      if (typeof message === "object" && message !== null) {
        const msg = message as Record<string, unknown>;
        // Answering a server→client request is recorded for assertions.
        if (msg.method === undefined && "id" in msg) {
          const pendingMethod = pendingServerRequests.get(msg.id);
          if (pendingMethod !== undefined) {
            pendingServerRequests.delete(msg.id);
            answered.push({ method: pendingMethod, result: msg.result ?? msg.error });
          }
          continue;
        }
        handleMessage(msg);
      }
    }
  });

  return {
    client,
    received,
    answered,
    opened,
    crash,
    waitForSync(uri: string, times = 1): Promise<void> {
      if ((syncCounts.get(uri) ?? 0) >= times) return Promise.resolve();
      return new Promise<void>((resolve) => syncWaiters.push({ uri, times, resolve }));
    },
  };
}
