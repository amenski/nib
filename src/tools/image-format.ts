/**
 * Magic-byte sniffing for the image formats heirloom can hand to a model.
 *
 * Bytes are authoritative where an extension or a Content-Type header is not:
 * a CDN can serve a JPEG from a URL with no extension, and a server can label
 * anything "image/png". Kept dependency-free (no Buffer beyond the argument)
 * so both the tool layer and read_file's binary guard can share one answer.
 */

const MAX_SIGNATURE_BYTES = 12;

function isPng(b: Buffer): boolean {
  return b.length >= 8 &&
    b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
    b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a;
}

function isJpeg(b: Buffer): boolean {
  // SOI marker (FFD8) followed by any marker's FF.
  return b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
}

function isGif(b: Buffer): boolean {
  if (b.length < 6 || b.toString("latin1", 0, 3) !== "GIF") return false;
  const version = b.toString("latin1", 3, 6);
  return version === "87a" || version === "89a";
}

function isWebp(b: Buffer): boolean {
  return b.length >= 12 &&
    b.toString("latin1", 0, 4) === "RIFF" &&
    b.toString("latin1", 8, 12) === "WEBP";
}

/**
 * The image MIME type `buffer` actually holds, or undefined when it holds
 * something else. Only the formats the model providers accept are recognized.
 */
export function sniffImageMime(buffer: Buffer): string | undefined {
  const b = buffer.subarray(0, MAX_SIGNATURE_BYTES);
  if (isPng(b)) return "image/png";
  if (isJpeg(b)) return "image/jpeg";
  if (isGif(b)) return "image/gif";
  if (isWebp(b)) return "image/webp";
  return undefined;
}
