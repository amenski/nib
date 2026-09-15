import type { ToolOutput, ToolDef } from "../types.js";
import type { ToolHandler, ToolContext } from "./types.js";
import { ToolRegistry } from "./registry.js";
import { assertHostnameAllowed, SsrfError } from "./web-fetch.js";
import { sniffImageMime } from "./image-format.js";
import { classifyImageSource } from "../image-source.js";
import { pkg } from "../version.js";
import * as fs from "node:fs";

const TIMEOUT_MS = 15_000;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 5;

/** Streams the body, aborting once it exceeds MAX_IMAGE_BYTES. */
async function readBodyCapped(res: Response): Promise<Buffer> {
  const reader = res.body?.getReader();
  if (!reader) return Buffer.from(await res.arrayBuffer());

  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > MAX_IMAGE_BYTES) {
        await reader.cancel();
        throw new Error(`image exceeds the ${MAX_IMAGE_BYTES / (1024 * 1024)} MB limit`);
      }
      chunks.push(value);
    }
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c)));
}

/**
 * Fetches `startUrl`, following up to MAX_REDIRECTS manual hops with an SSRF
 * check before each one (same policy as web_fetch — including the per-hop
 * https check, so a redirect cannot downgrade the scheme), and returns the
 * image as a data URL.
 *
 * The image type comes from the bytes, not the Content-Type header: a server
 * can label anything "image/png", and providers reject a part whose declared
 * media type disagrees with its contents.
 */
async function fetchImage(startUrl: string, signal: AbortSignal): Promise<{ dataUrl: string; mime: string; bytes: number }> {
  let currentUrl = startUrl;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const parsed = new URL(currentUrl);
    if (parsed.protocol !== "https:") {
      throw new Error(`refusing redirect to non-https URL "${currentUrl}"`);
    }
    await assertHostnameAllowed(parsed.hostname);

    // The timeout spans the whole hop — headers AND body.
    const timeoutController = new AbortController();
    const timeoutId = setTimeout(() => timeoutController.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(currentUrl, {
        signal: AbortSignal.any([signal, timeoutController.signal]),
        redirect: "manual",
        headers: { "User-Agent": `nib/${pkg.version} (+cli)` },
      });

      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        if (!location) throw new Error(`redirect (status ${res.status}) with no Location header`);
        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }

      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText} for ${currentUrl}`);
      }

      const buffer = await readBodyCapped(res);
      if (buffer.length === 0) throw new Error(`empty response body for ${currentUrl}`);

      const mime = sniffImageMime(buffer);
      if (!mime) {
        const declared = (res.headers.get("content-type") ?? "").split(";")[0].trim() || "unknown";
        throw new Error(`not a recognized image (content-type "${declared}") — use web_fetch for pages and text`);
      }

      return { dataUrl: `data:${mime};base64,${buffer.toString("base64")}`, mime, bytes: buffer.length };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  throw new Error(`too many redirects (> ${MAX_REDIRECTS})`);
}

const viewImageHandler: ToolHandler = async (args, ctx) => {
  const raw = typeof args.url === "string" ? args.url.trim() : "";
  if (!raw) {
    return { content: "", error: "PARSE_ERROR: url is required" };
  }

  const source = classifyImageSource(raw);
  if (source.kind === "http") {
    return {
      content: "",
      error: `view_image: plain http:// is not allowed for "${raw}". Approve an https:// URL, or use https:// if the site supports it.`,
    };
  }
  if (source.kind === "unsupported") {
    return { content: "", error: `view_image: unsupported protocol "${source.scheme}:" — use an https:// URL or a local file path.` };
  }

  try {
    const image = source.kind === "local"
      ? await readLocalImage(source.path)
      : await fetchImage(source.url, ctx.signal);
    const origin = source.kind === "local" ? source.path : source.url;
    // The image travels on `attachments`, not in the text: a tool result is
    // text-only on the wire, so the agent loop replays this as a synthetic
    // user message carrying imageUrls (see types.ts ToolOutput.attachments).
    const output: ToolOutput = {
      content: `Attached image (${image.mime}, ${Math.round(image.bytes / 1024)} KB) from ${origin}. The image is now visible to you.`,
      attachments: [image.dataUrl],
    };
    return output;
  } catch (err) {
    if (err instanceof SsrfError) {
      return { content: "", error: `view_image: ${err.message}` };
    }
    if ((err as { name?: string })?.name === "AbortError" || ctx.signal.aborted) {
      return { content: "", error: "view_image: request timed out or was aborted." };
    }
    return { content: "", error: `view_image: ${err instanceof Error ? err.message : String(err)}` };
  }
};

/** Reads a local image, enforcing the same size cap and byte-based format check as the remote path. */
async function readLocalImage(filePath: string): Promise<{ dataUrl: string; mime: string; bytes: number }> {
  let buffer: Buffer;
  try {
    buffer = await fs.promises.readFile(filePath);
  } catch (err) {
    throw new Error(`cannot read "${filePath}" — ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`);
  }
  if (buffer.length === 0) throw new Error(`"${filePath}" is empty`);
  if (buffer.length > MAX_IMAGE_BYTES) {
    throw new Error(`image exceeds the ${MAX_IMAGE_BYTES / (1024 * 1024)} MB limit`);
  }
  const mime = sniffImageMime(buffer);
  if (!mime) {
    throw new Error(`"${filePath}" is not a recognized image (PNG/JPEG/GIF/WebP)`);
  }
  return { dataUrl: `data:${mime};base64,${buffer.toString("base64")}`, mime, bytes: buffer.length };
}

const viewImageDef: ToolDef = {
  name: "view_image",
  description:
    "Look at an image so you can actually see it. `url` takes an https:// image URL, an absolute local file path, or a file:// URL. Use this whenever you are given an image to inspect — a URL, or a path on disk. Only real image files (PNG/JPEG/GIF/WebP) are accepted; for an HTML page or text file use web_fetch instead. A remote fetch re-asks per domain; a local read is permission-gated like read_file.",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "https:// image URL, absolute local file path, or file:// URL" },
    },
    required: ["url"],
  },
};

export function registerViewImage(registry: ToolRegistry): void {
  registry.register({ def: viewImageDef, handler: viewImageHandler, groups: ["read"] });
}
