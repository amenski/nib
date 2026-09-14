import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const lookupMock = vi.fn();
vi.mock("node:dns/promises", () => ({
  lookup: (...args: unknown[]) => lookupMock(...args),
}));

// Imported after the mock so view-image.ts resolves the mocked module.
const { ToolRegistry } = await import("./registry.js");
const { registerViewImage } = await import("./view-image.js");
import type { ToolContext } from "./types.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02]);
const PNG_DATA_URL = `data:image/png;base64,${PNG.toString("base64")}`;

const PUBLIC_ADDR = [{ address: "93.184.216.34", family: 4 }];

function makeCtx(): ToolContext {
  return { workingDir: "/tmp", sessionId: "test", signal: new AbortController().signal };
}

describe("view_image", () => {
  let registry: InstanceType<typeof ToolRegistry>;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    registry = new ToolRegistry();
    registerViewImage(registry);
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    lookupMock.mockReset();
    lookupMock.mockResolvedValue(PUBLIC_ADDR);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const call = (args: Record<string, unknown>, ctx = makeCtx()) =>
    registry.execute({ id: "1", name: "view_image", arguments: args }, ctx);

  it("registers with the read group", () => {
    expect(registry.getByMode(["read"]).map((d) => d.name)).toContain("view_image");
  });

  it("requires a url", async () => {
    expect((await call({})).error).toContain("PARSE_ERROR");
  });

  it("treats a scheme-less string as a local path rather than a URL parse error", async () => {
    const result = await call({ url: "not a url" });
    expect(result.error).toContain("cannot read");
  });

  it("rejects plain http:// without fetching", async () => {
    const result = await call({ url: "http://example.com/cat.png" });
    expect(result.error).toContain("http://");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an unsupported URL scheme", async () => {
    const result = await call({ url: "ftp://example.com/cat.png" });
    expect(result.error).toContain("unsupported protocol");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a hostname resolving to a blocked address (SSRF guard)", async () => {
    lookupMock.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    const result = await call({ url: "https://internal.example/cat.png" });
    expect(result.error).toContain("blocked");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses the literal hostname 'localhost' without DNS", async () => {
    const result = await call({ url: "https://localhost/cat.png" });
    expect(result.error).toContain("localhost");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("attaches a PNG as a data URL", async () => {
    fetchMock.mockResolvedValue(new Response(PNG, { status: 200, headers: { "Content-Type": "image/png" } }));

    const result = await call({ url: "https://example.com/cat.png" });

    expect(result.error).toBeUndefined();
    expect(result.attachments).toEqual([PNG_DATA_URL]);
    expect(result.content).toContain("image/png");
  });

  it("identifies the format from the bytes, not a lying Content-Type header", async () => {
    // A server may label anything "image/png"; providers reject a part whose
    // declared media type disagrees with its contents.
    fetchMock.mockResolvedValue(new Response(PNG, { status: 200, headers: { "Content-Type": "image/png" } }));

    const result = await call({ url: "https://example.com/mislabelled" });

    expect(result.attachments![0].startsWith("data:image/png;base64,")).toBe(true);
  });

  it("rejects a response whose bytes are not an image, naming the declared type", async () => {
    fetchMock.mockResolvedValue(
      new Response("just text", { status: 200, headers: { "Content-Type": "text/plain" } }),
    );

    const result = await call({ url: "https://example.com/not-an-image.png" });

    expect(result.error).toContain("not a recognized image");
    expect(result.error).toContain("text/plain");
    expect(result.error).toContain("web_fetch");
    expect(result.attachments).toBeUndefined();
  });

  it("rejects an empty body", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 200, headers: { "Content-Type": "image/png" } }));
    expect((await call({ url: "https://example.com/empty.png" })).error).toContain("empty response body");
  });

  it("returns an HTTP error result rather than throwing", async () => {
    fetchMock.mockResolvedValue(new Response("Not Found", { status: 404, statusText: "Not Found" }));
    const result = await call({ url: "https://example.com/missing.png" });
    expect(result.error).toContain("HTTP 404");
  });

  it("follows a manual redirect, re-checking SSRF on the new host", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { Location: "https://cdn.example/cat.png" } }))
      .mockResolvedValueOnce(new Response(PNG, { status: 200, headers: { "Content-Type": "image/png" } }));

    const result = await call({ url: "https://example.com/start" });

    expect(result.attachments).toEqual([PNG_DATA_URL]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(lookupMock).toHaveBeenCalledWith("example.com", expect.anything());
    expect(lookupMock).toHaveBeenCalledWith("cdn.example", expect.anything());
  });

  it("blocks a redirect that points at a blocked address", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { Location: "https://internal.example/cat.png" } }),
    );
    lookupMock.mockImplementation((hostname: string) =>
      Promise.resolve(hostname === "internal.example" ? [{ address: "169.254.169.254", family: 4 }] : PUBLIC_ADDR),
    );

    const result = await call({ url: "https://example.com/start-blocked" });

    expect(result.error).toContain("blocked");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refuses a redirect that downgrades to http", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { Location: "http://example.com/plain.png" } }),
    );
    const result = await call({ url: "https://example.com/start-downgrade" });
    expect(result.error).toContain("non-https");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("gives up after too many redirects", async () => {
    fetchMock.mockImplementation((url: string) => {
      const n = Number(new URL(url).pathname.slice(1)) || 0;
      return Promise.resolve(
        new Response(null, { status: 302, headers: { Location: `https://example.com/${n + 1}` } }),
      );
    });
    expect((await call({ url: "https://example.com/0" })).error).toContain("redirect");
  });

  it("enforces the size cap", async () => {
    const tooBig = Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024)]);
    fetchMock.mockResolvedValue(new Response(tooBig, { status: 200, headers: { "Content-Type": "image/png" } }));

    const result = await call({ url: "https://example.com/huge.png" });

    expect(result.error).toContain("5 MB limit");
    expect(result.attachments).toBeUndefined();
  });

  it("sends redirect: manual and an honest User-Agent", async () => {
    let init: RequestInit | undefined;
    fetchMock.mockImplementation((_url: string, i?: RequestInit) => {
      init = i;
      return Promise.resolve(new Response(PNG, { status: 200, headers: { "Content-Type": "image/png" } }));
    });

    await call({ url: "https://example.com/headers-check.png" });

    expect(init?.redirect).toBe("manual");
    expect((init?.headers as Record<string, string>)["User-Agent"]).toContain("heirloom-agent/");
  });

  it("aborts when the context signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    fetchMock.mockImplementation((_url: string, i?: RequestInit) => {
      if (i?.signal && (i.signal as AbortSignal).aborted) {
        return Promise.reject(new DOMException("aborted", "AbortError"));
      }
      return Promise.resolve(new Response(PNG, { status: 200, headers: { "Content-Type": "image/png" } }));
    });

    const ctx = makeCtx();
    ctx.signal = controller.signal;

    expect((await call({ url: "https://example.com/abort.png" }, ctx)).error).toMatch(/timed out|aborted/);
  });
});

describe("view_image local files", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "heirloom-view-"));
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  let registry: InstanceType<typeof ToolRegistry>;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    registry = new ToolRegistry();
    registerViewImage(registry);
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const call = (args: Record<string, unknown>, ctx = makeCtx()) =>
    registry.execute({ id: "1", name: "view_image", arguments: args }, ctx);

  function writeImage(name: string, bytes: Buffer = PNG): string {
    const file = path.join(root, name);
    fs.writeFileSync(file, bytes);
    return file;
  }

  it("reads a local image path and attaches it, without any network call", async () => {
    const file = writeImage("shot.png");

    const result = await call({ url: file });

    expect(result.error).toBeUndefined();
    expect(result.attachments).toEqual([PNG_DATA_URL]);
    expect(result.content).toContain("image/png");
    expect(result.content).toContain(file);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts a file:// URL for a local image", async () => {
    const file = writeImage("shot2.png");

    const result = await call({ url: `file://${file}` });

    expect(result.attachments).toEqual([PNG_DATA_URL]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("identifies the format from the bytes, not the file extension", async () => {
    const file = writeImage("mislabelled.txt");

    const result = await call({ url: file });

    expect(result.attachments![0].startsWith("data:image/png;base64,")).toBe(true);
  });

  it("attaches a local JPEG (the common case for pasted files)", async () => {
    // Real JPEG magic: FFD8FFE0 + JFIF marker.
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x00]);
    const file = writeImage("photo.jpeg", jpeg);

    const result = await call({ url: file });

    expect(result.attachments).toEqual([`data:image/jpeg;base64,${jpeg.toString("base64")}`]);
    expect(result.content).toContain("image/jpeg");
  });

  it("rejects a local file that is not an image", async () => {
    const file = path.join(root, "notes.txt");
    fs.writeFileSync(file, "just some text");

    const result = await call({ url: file });

    expect(result.error).toContain("not a recognized image");
    expect(result.attachments).toBeUndefined();
  });

  it("reports a missing file rather than throwing", async () => {
    const result = await call({ url: path.join(root, "nope.png") });
    expect(result.error).toContain("cannot read");
    expect(result.error).toContain("ENOENT");
  });

  it("rejects an empty file", async () => {
    const file = path.join(root, "empty.png");
    fs.writeFileSync(file, Buffer.alloc(0));
    expect((await call({ url: file })).error).toContain("empty");
  });

  it("enforces the size cap on a local file", async () => {
    const file = path.join(root, "huge.png");
    fs.writeFileSync(file, Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024)]));

    const result = await call({ url: file });

    expect(result.error).toContain("5 MB limit");
    expect(result.attachments).toBeUndefined();
  });
});
