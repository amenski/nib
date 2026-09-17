import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const lookupMock = vi.fn();
vi.mock("node:dns/promises", () => ({
  lookup: (...args: unknown[]) => lookupMock(...args),
}));

// Imported after the mock so the mocked module is what web-fetch.ts resolves.
const { ToolRegistry } = await import("./registry.js");
const { registerWebFetch } = await import("./web-fetch.js");
const { parseUntrustedMarker } = await import("./untrusted-content.js");
import type { ToolContext } from "./types.js";

function makeCtx(): ToolContext {
  return {
    workingDir: "/tmp",
    sessionId: "test",
    signal: new AbortController().signal,
  };
}

function textResponse(body: string, status = 200, headers: Record<string, string> = { "Content-Type": "text/plain" }): Response {
  return new Response(body, { status, headers });
}

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

const PUBLIC_ADDR = [{ address: "93.184.216.34", family: 4 }];

describe("web_fetch", () => {
  let registry: InstanceType<typeof ToolRegistry>;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    registry = new ToolRegistry();
    registerWebFetch(registry);
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    lookupMock.mockReset();
    lookupMock.mockResolvedValue(PUBLIC_ADDR);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("registers with the read group", () => {
    const defs = registry.getByMode(["read"]);
    expect(defs.map((d) => d.name)).toContain("web_fetch");
  });

  it("requires a url", async () => {
    const result = await registry.execute({ id: "1", name: "web_fetch", arguments: {} }, makeCtx());
    expect(result.error).toContain("PARSE_ERROR");
  });

  it("rejects an invalid url", async () => {
    const result = await registry.execute({ id: "1", name: "web_fetch", arguments: { url: "not a url" } }, makeCtx());
    expect(result.error).toContain("PARSE_ERROR");
  });

  it("rejects plain http:// without falling back silently", async () => {
    const result = await registry.execute(
      { id: "1", name: "web_fetch", arguments: { url: "http://example.com" } },
      makeCtx(),
    );
    expect(result.error).toContain("http://");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a non-http(s) protocol", async () => {
    const result = await registry.execute(
      { id: "1", name: "web_fetch", arguments: { url: "ftp://example.com/file" } },
      makeCtx(),
    );
    expect(result.error).toContain("protocol");
  });

  it("refuses a hostname that resolves to a blocked address (SSRF guard)", async () => {
    lookupMock.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    const result = await registry.execute(
      { id: "1", name: "web_fetch", arguments: { url: "https://internal.example/" } },
      makeCtx(),
    );
    expect(result.error).toContain("blocked");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses the literal hostname 'localhost' without needing DNS", async () => {
    const result = await registry.execute(
      { id: "1", name: "web_fetch", arguments: { url: "https://localhost/" } },
      makeCtx(),
    );
    expect(result.error).toContain("localhost");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fetches text/plain content raw", async () => {
    fetchMock.mockResolvedValue(textResponse("hello world"));
    const result = await registry.execute(
      { id: "1", name: "web_fetch", arguments: { url: "https://example.com/file.txt" } },
      makeCtx(),
    );
    expect(result.error).toBeUndefined();
    expect(result.content).toContain("hello world");
    expect(result.content).toContain("BEGIN WEB CONTENT");
    expect(result.content).toContain("END WEB CONTENT");
  });

  it("converts text/html to readable markdown via Readability", async () => {
    const html = `<html><body><article><h1>Title</h1><p>${"Real article content sentence. ".repeat(20)}</p></article></body></html>`;
    fetchMock.mockResolvedValue(htmlResponse(html));
    const result = await registry.execute(
      { id: "1", name: "web_fetch", arguments: { url: "https://example.com/article" } },
      makeCtx(),
    );
    expect(result.error).toBeUndefined();
    expect(result.content).toContain("Title");
    expect(result.content).toContain("Real article content sentence.");
  });

  it("falls back to full-body conversion and notes it when Readability finds no substantial content", async () => {
    const html = "<html><body><div>short</div></body></html>";
    fetchMock.mockResolvedValue(htmlResponse(html));
    const result = await registry.execute(
      { id: "1", name: "web_fetch", arguments: { url: "https://example.com/thin" } },
      makeCtx(),
    );
    expect(result.error).toBeUndefined();
    expect(result.content).toContain("short");
    expect(result.content).toContain("no substantial content");
  });

  it("returns a tool error naming the content type for unsupported types", async () => {
    fetchMock.mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "Content-Type": "image/png" } }),
    );
    const result = await registry.execute(
      { id: "1", name: "web_fetch", arguments: { url: "https://example.com/image.png" } },
      makeCtx(),
    );
    expect(result.error).toContain("image/png");
  });

  it("returns an HTTP error result rather than throwing", async () => {
    fetchMock.mockResolvedValue(new Response("Not Found", { status: 404, statusText: "Not Found" }));
    const result = await registry.execute(
      { id: "1", name: "web_fetch", arguments: { url: "https://example.com/missing" } },
      makeCtx(),
    );
    expect(result.error).toContain("HTTP 404");
    expect(result.error).toContain("https://example.com/missing");
  });

  it("follows a manual redirect, re-checking SSRF on the new host", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { Location: "https://redirected.example/dest" } }))
      .mockResolvedValueOnce(textResponse("final content"));
    const result = await registry.execute(
      { id: "1", name: "web_fetch", arguments: { url: "https://example.com/start" } },
      makeCtx(),
    );
    expect(result.error).toBeUndefined();
    expect(result.content).toContain("final content");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(lookupMock).toHaveBeenCalledWith("example.com", expect.anything());
    expect(lookupMock).toHaveBeenCalledWith("redirected.example", expect.anything());
  });

  it("blocks a redirect that points at a blocked address", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 302, headers: { Location: "https://internal.example/dest" } }));
    lookupMock.mockImplementation((hostname: string) =>
      Promise.resolve(hostname === "internal.example" ? [{ address: "169.254.169.254", family: 4 }] : PUBLIC_ADDR),
    );
    const result = await registry.execute(
      { id: "1", name: "web_fetch", arguments: { url: "https://example.com/start-blocked" } },
      makeCtx(),
    );
    expect(result.error).toContain("blocked");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refuses a redirect that downgrades to http", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 302, headers: { Location: "http://example.com/plain" } }));
    const result = await registry.execute(
      { id: "1", name: "web_fetch", arguments: { url: "https://example.com/start-downgrade" } },
      makeCtx(),
    );
    expect(result.error).toContain("non-https");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("gives up after too many redirects", async () => {
    fetchMock.mockImplementation((url: string) => {
      const n = Number(new URL(url).pathname.slice(1)) || 0;
      return Promise.resolve(new Response(null, { status: 302, headers: { Location: `https://example.com/${n + 1}` } }));
    });
    const result = await registry.execute(
      { id: "1", name: "web_fetch", arguments: { url: "https://example.com/0" } },
      makeCtx(),
    );
    expect(result.error).toContain("redirect");
  });

  it("sends an honest User-Agent header naming nib", async () => {
    let sentUA: string | undefined;
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
      sentUA = (init?.headers as Record<string, string>)?.["User-Agent"];
      return Promise.resolve(textResponse("ok"));
    });
    await registry.execute({ id: "1", name: "web_fetch", arguments: { url: "https://example.com/ua-check" } }, makeCtx());
    expect(sentUA).toContain("nib/");
  });

  it("uses redirect: manual", async () => {
    let sentRedirect: string | undefined;
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
      sentRedirect = init?.redirect;
      return Promise.resolve(textResponse("ok"));
    });
    await registry.execute({ id: "1", name: "web_fetch", arguments: { url: "https://example.com/redirect-check" } }, makeCtx());
    expect(sentRedirect).toBe("manual");
  });

  it("wraps content in the untrusted-content delimiters", async () => {
    fetchMock.mockResolvedValue(textResponse("some content"));
    const result = await registry.execute(
      { id: "1", name: "web_fetch", arguments: { url: "https://example.com/wrap-check" } },
      makeCtx(),
    );
    const lines = result.content.trim().split("\n");
    expect(parseUntrustedMarker(lines[0]!)?.role).toBe("begin");
    expect(parseUntrustedMarker(lines[lines.length - 1]!)?.role).toBe("end");
  });

  it("strips control characters from fetched text", async () => {
    fetchMock.mockResolvedValue(textResponse("before\x1b[31mafter"));
    const result = await registry.execute(
      { id: "1", name: "web_fetch", arguments: { url: "https://example.com/control-check" } },
      makeCtx(),
    );
    expect(result.content).not.toContain("\x1b");
  });

  it("truncates long output at 40000 chars and reports the next offset", async () => {
    fetchMock.mockResolvedValue(textResponse("x".repeat(50_000)));
    const result = await registry.execute(
      { id: "1", name: "web_fetch", arguments: { url: "https://example.com/big" } },
      makeCtx(),
    );
    expect(result.content).toContain("offset: 40000");
  });

  it("honors the offset parameter to paginate through cached processed text", async () => {
    fetchMock.mockResolvedValue(textResponse("0123456789"));
    const first = await registry.execute(
      { id: "1", name: "web_fetch", arguments: { url: "https://example.com/paged" } },
      makeCtx(),
    );
    expect(first.content).toContain("0123456789");

    const second = await registry.execute(
      { id: "2", name: "web_fetch", arguments: { url: "https://example.com/paged", offset: 5 } },
      makeCtx(),
    );
    expect(second.error).toBeUndefined();
    expect(second.content).toContain("56789");
    expect(second.content).not.toContain("01234");
    // Cache hit — fetch not called again for the same URL.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("aborts when the context signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
      if (init?.signal && (init.signal as AbortSignal).aborted) {
        return Promise.reject(new DOMException("aborted", "AbortError"));
      }
      return Promise.resolve(textResponse("ok"));
    });
    const ctx = makeCtx();
    ctx.signal = controller.signal;
    const result = await registry.execute({ id: "1", name: "web_fetch", arguments: { url: "https://example.com/abort-check" } }, ctx);
    expect(result.error).toMatch(/timed out|aborted/);
  });
});
