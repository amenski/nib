import { describe, it, expect } from "vitest";
import { sniffImageMime } from "./image-format.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const GIF87 = Buffer.from("GIF87a\x01\x00", "latin1");
const GIF89 = Buffer.from("GIF89a\x01\x00", "latin1");
const WEBP = Buffer.concat([
  Buffer.from("RIFF", "latin1"),
  Buffer.from([0x00, 0x00, 0x00, 0x00]),
  Buffer.from("WEBP", "latin1"),
]);

describe("sniffImageMime", () => {
  it("recognizes the four supported formats by magic bytes", () => {
    expect(sniffImageMime(PNG)).toBe("image/png");
    expect(sniffImageMime(JPEG)).toBe("image/jpeg");
    expect(sniffImageMime(GIF87)).toBe("image/gif");
    expect(sniffImageMime(GIF89)).toBe("image/gif");
    expect(sniffImageMime(WEBP)).toBe("image/webp");
  });

  it("returns undefined for text, unknown bytes, and an empty buffer", () => {
    expect(sniffImageMime(Buffer.from("plain text content"))).toBeUndefined();
    expect(sniffImageMime(Buffer.from([0x00, 0x01, 0x02]))).toBeUndefined();
    expect(sniffImageMime(Buffer.alloc(0))).toBeUndefined();
  });

  it("does not mistake a non-WEBP RIFF container for an image", () => {
    const wav = Buffer.concat([
      Buffer.from("RIFF", "latin1"),
      Buffer.from([0x00, 0x00, 0x00, 0x00]),
      Buffer.from("WAVE", "latin1"),
    ]);
    expect(sniffImageMime(wav)).toBeUndefined();
  });

  it("does not mistake a bare GIF prefix for a GIF image", () => {
    expect(sniffImageMime(Buffer.from("GIF", "latin1"))).toBeUndefined();
  });

  it("identifies a format from its leading bytes alone", () => {
    // A real PNG is far longer than the signature window; only the first
    // bytes may be inspected.
    const huge = Buffer.concat([PNG, Buffer.alloc(100_000)]);
    expect(sniffImageMime(huge)).toBe("image/png");
  });
});
