import { describe, it, expect } from "vitest";
import { MessageDecoder, encodeMessage, FramingError } from "./framing.js";

const bytes = (message: unknown): Buffer => encodeMessage(message);

describe("encodeMessage", () => {
  it("writes Content-Length as BYTES, not characters", () => {
    // "é" is 1 UTF-16 unit but 2 UTF-8 bytes; a character-counted length would
    // truncate the body on the far side.
    const encoded = bytes({ jsonrpc: "2.0", id: 1, result: "héllo" });
    const header = encoded.subarray(0, encoded.indexOf("\r\n\r\n")).toString();
    const body = encoded.subarray(encoded.indexOf("\r\n\r\n") + 4);
    expect(header).toBe(`Content-Length: ${body.length}`);
    expect(body.toString("utf-8")).toBe('{"jsonrpc":"2.0","id":1,"result":"héllo"}');
  });
});

describe("MessageDecoder", () => {
  it("decodes a message split across chunks", () => {
    const decoder = new MessageDecoder();
    const encoded = bytes({ jsonrpc: "2.0", id: 1, method: "a" });
    const middle = Math.floor(encoded.length / 2);

    expect(decoder.push(encoded.subarray(0, middle))).toEqual([]);
    expect(decoder.push(encoded.subarray(middle))).toEqual([{ jsonrpc: "2.0", id: 1, method: "a" }]);
  });

  it("decodes two messages that arrived in one chunk", () => {
    const decoder = new MessageDecoder();
    const both = Buffer.concat([
      bytes({ jsonrpc: "2.0", id: 1, method: "a" }),
      bytes({ jsonrpc: "2.0", id: 2, method: "b" }),
    ]);
    expect(decoder.push(both)).toEqual([
      { jsonrpc: "2.0", id: 1, method: "a" },
      { jsonrpc: "2.0", id: 2, method: "b" },
    ]);
  });

  it("accepts a lowercase header name", () => {
    const decoder = new MessageDecoder();
    const body = Buffer.from('{"id":7}', "utf-8");
    const chunk = Buffer.concat([
      Buffer.from(`content-length: ${body.length}\r\n\r\n`, "ascii"),
      body,
    ]);
    expect(decoder.push(chunk)).toEqual([{ id: 7 }]);
  });

  it("accepts extra headers before or after Content-Length (the Dart server sends Content-Type)", () => {
    const body = '{"jsonrpc":"2.0","id":1,"result":null}';
    const withTypeAfter = `Content-Length: ${body.length}\r\nContent-Type: application/vscode-jsonrpc; charset=utf-8\r\n\r\n${body}`;
    const withTypeBefore = `Content-Type: application/vscode-jsonrpc; charset=utf-8\r\nContent-Length: ${body.length}\r\n\r\n${body}`;

    expect(new MessageDecoder().push(Buffer.from(withTypeAfter))).toEqual([{ jsonrpc: "2.0", id: 1, result: null }]);
    expect(new MessageDecoder().push(Buffer.from(withTypeBefore))).toEqual([{ jsonrpc: "2.0", id: 1, result: null }]);
  });

  it("drops a body that is not JSON but stays aligned for the next message", () => {
    const decoder = new MessageDecoder();
    const bad = Buffer.from("not json", "utf-8");
    const chunk = Buffer.concat([
      Buffer.from(`Content-Length: ${bad.length}\r\n\r\n`, "ascii"),
      bad,
      bytes({ jsonrpc: "2.0", id: 3, method: "after" }),
    ]);
    expect(decoder.push(chunk)).toEqual([{ jsonrpc: "2.0", id: 3, method: "after" }]);
  });

  it("throws when a header has no Content-Length (no way to resynchronize)", () => {
    const decoder = new MessageDecoder();
    expect(() => decoder.push(Buffer.from("X-Other: 1\r\n\r\n{}", "ascii"))).toThrow(FramingError);
  });
});
