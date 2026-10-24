/**
 * LSP base protocol framing: `Content-Length`-prefixed JSON-RPC bodies over a
 * byte stream (LSP spec, "Base Protocol").
 *
 * Hand-rolled rather than adding a dependency: the framing is a header block, a
 * blank line, and exactly N bytes of UTF-8 JSON. The length counts BYTES, not
 * characters — a body with any non-ASCII text (a diagnostic message quoting a
 * source line) is longer in bytes than in UTF-16 units, so slicing by string
 * length would truncate it.
 */

const HEADER_TERMINATOR = Buffer.from("\r\n\r\n", "ascii");
// Matched per header line: a server may follow Content-Length with other
// headers (the Dart server always sends Content-Type).
const CONTENT_LENGTH_RE = /^content-length\s*:\s*(\d+)\s*$/i;

/** A stream that cannot be resynchronized — the caller should drop the connection. */
export class FramingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FramingError";
  }
}

export function encodeMessage(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf-8");
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii");
  return Buffer.concat([header, body]);
}

/**
 * Incremental decoder: chunks arrive split at arbitrary byte boundaries, and
 * one chunk may hold several messages. Bodies that are not valid JSON are
 * dropped (a malformed message must not take down a working server), while a
 * missing `Content-Length` throws — without the length there is no way to find
 * where the next message starts.
 */
export class MessageDecoder {
  private buffer: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): unknown[] {
    this.buffer = this.buffer.length > 0 ? Buffer.concat([this.buffer, chunk]) : chunk;
    const messages: unknown[] = [];

    for (;;) {
      const headerEnd = this.buffer.indexOf(HEADER_TERMINATOR);
      if (headerEnd < 0) break;

      const header = this.buffer.subarray(0, headerEnd).toString("ascii");
      let match: RegExpExecArray | null = null;
      for (const line of header.split("\r\n")) {
        match = CONTENT_LENGTH_RE.exec(line.trim());
        if (match) break;
      }
      if (!match) {
        throw new FramingError(`missing Content-Length in LSP header: ${header.slice(0, 120)}`);
      }
      const length = Number(match[1]);
      const bodyStart = headerEnd + HEADER_TERMINATOR.length;
      if (this.buffer.length < bodyStart + length) break;

      const body = this.buffer.subarray(bodyStart, bodyStart + length).toString("utf-8");
      this.buffer = this.buffer.subarray(bodyStart + length);

      try {
        messages.push(JSON.parse(body));
      } catch {
        // Not JSON: skip this body, keep the stream aligned.
      }
    }

    return messages;
  }
}
