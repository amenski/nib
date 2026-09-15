import { describe, it, expect, vi, afterEach } from "vitest";
import { createAISDKProvider, mapMessages } from "./aisdk.js";
import type { ProviderPreset } from "./presets.js";

function preset(baseUrl: string): ProviderPreset {
  return {
    api: "openai-compatible",
    baseUrl,
    keyEnv: "TEST_API_KEY",
    defaultModel: "test-model",
    models: {},
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("Provider.getBalance (openai-compatible adapter)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetch(): void {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  }

  it("deepseek: GET {baseUrl}/user/balance with Bearer auth, parses the USD balance_infos entry", async () => {
    stubFetch();
    fetchMock.mockResolvedValue(
      jsonResponse({
        is_available: true,
        balance_infos: [
          { currency: "CNY", total_balance: "110.00", granted_balance: "10.00", topped_up_balance: "100.00" },
          { currency: "USD", total_balance: "1.25", granted_balance: "0.10", topped_up_balance: "1.15" },
        ],
      }),
    );

    const provider = createAISDKProvider(preset("https://api.deepseek.com"), "deepseek-v4-pro", "sk-test");
    const balance = await provider.getBalance!();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.deepseek.com/user/balance");
    expect(init.headers).toEqual({ Authorization: "Bearer sk-test" });
    expect(balance).toEqual({ currency: "USD", total: 1.25, granted: 0.1 });
  });

  it("deepseek: tolerates a base URL with a path prefix (host is what branches)", async () => {
    stubFetch();
    fetchMock.mockResolvedValue(
      jsonResponse({ balance_infos: [{ currency: "USD", total_balance: "5.00", granted_balance: "0.00", topped_up_balance: "5.00" }] }),
    );

    const provider = createAISDKProvider(preset("https://api.deepseek.com/v1"), "deepseek-v4-pro", "sk-test");
    await provider.getBalance!();
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.deepseek.com/v1/user/balance");
  });

  it("deepseek: returns null when balance_infos has no USD entry", async () => {
    stubFetch();
    fetchMock.mockResolvedValue(
      jsonResponse({ is_available: true, balance_infos: [{ currency: "CNY", total_balance: "110.00", granted_balance: "10.00", topped_up_balance: "100.00" }] }),
    );

    const provider = createAISDKProvider(preset("https://api.deepseek.com"), "deepseek-v4-pro", "sk-test");
    expect(await provider.getBalance!()).toBeNull();
  });

  it("openrouter: GET https://openrouter.ai/api/v1/credits with Bearer auth, reports remaining credits", async () => {
    stubFetch();
    fetchMock.mockResolvedValue(
      jsonResponse({ data: { total_credits: 20, total_usage: 2.75, remaining_credits: 17.25 } }),
    );

    const provider = createAISDKProvider(preset("https://openrouter.ai/api/v1"), "anthropic/claude-sonnet-4.6", "sk-or");
    const balance = await provider.getBalance!();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://openrouter.ai/api/v1/credits");
    expect(init.headers).toEqual({ Authorization: "Bearer sk-or" });
    // OpenRouter has no grant concept: the whole remaining balance is total.
    expect(balance).toEqual({ currency: "USD", total: 17.25, granted: 0 });
  });

  it("openrouter: falls back to total − usage when remaining_credits is absent", async () => {
    stubFetch();
    fetchMock.mockResolvedValue(jsonResponse({ data: { total_credits: 100.5, total_usage: 25.75 } }));

    const provider = createAISDKProvider(preset("https://openrouter.ai/api/v1"), "m", "sk-or");
    expect(await provider.getBalance!()).toEqual({ currency: "USD", total: 74.75, granted: 0 });
  });

  it("returns null for hosts without a balance endpoint (no fetch)", async () => {
    stubFetch();

    const provider = createAISDKProvider(preset("https://api.openai.com/v1"), "gpt-5.6-sol", "sk-oa");
    expect(await provider.getBalance!()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();

    const ollama = createAISDKProvider(preset("http://localhost:11434/v1"), "llama3.2", "");
    expect(await ollama.getBalance!()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns null on a non-200 response", async () => {
    stubFetch();
    fetchMock.mockResolvedValue(jsonResponse({ error: { message: "invalid api key" } }, 401));

    const provider = createAISDKProvider(preset("https://api.deepseek.com"), "m", "bad-key");
    expect(await provider.getBalance!()).toBeNull();
  });

  it("returns null on a network error instead of throwing", async () => {
    stubFetch();
    fetchMock.mockRejectedValue(new Error("ECONNRESET"));

    const provider = createAISDKProvider(preset("https://api.deepseek.com"), "m", "sk-test");
    await expect(provider.getBalance!()).resolves.toBeNull();
  });

  it("returns null on an unparseable response body", async () => {
    stubFetch();
    fetchMock.mockResolvedValue(new Response("not json", { status: 200 }));

    const provider = createAISDKProvider(preset("https://api.deepseek.com"), "m", "sk-test");
    await expect(provider.getBalance!()).resolves.toBeNull();
  });
});

describe("OpenRouter request mapping", () => {
  it("uses the tool name carried by a new result", () => {
    const mapped = mapMessages([
      { role: "assistant", content: null, toolCalls: [{ id: "call_1", name: "search", arguments: {} }] },
      { role: "tool", toolCallId: "call_1", toolName: "search", content: "result" },
    ]);

    expect(mapped).toEqual([
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "call_1", toolName: "search", input: {} }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "call_1", toolName: "search", output: { type: "text", value: "result" } }] },
    ]);
  });

  it("infers the tool name for legacy results without toolName", () => {
    const mapped = mapMessages([
      { role: "assistant", content: null, toolCalls: [{ id: "call_1", name: "search", arguments: {} }] },
      { role: "tool", toolCallId: "call_1", content: "result" },
    ]);

    expect(mapped[1]).toMatchObject({
      role: "tool",
      content: [{ type: "tool-result", toolCallId: "call_1", toolName: "search" }],
    });
  });

  it("uses a clear fallback only for an unresolvable legacy result", () => {
    const mapped = mapMessages([{ role: "tool", toolCallId: "missing", content: "result" }]);
    expect(mapped[0]).toMatchObject({
      role: "tool",
      content: [{ type: "tool-result", toolCallId: "missing", toolName: "legacy_unknown_tool" }],
    });
  });

  it("adds GitHub attribution only to OpenRouter requests", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        [
          'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}',
          "data: [DONE]",
          "",
        ].join("\n\n"),
        { status: 200, headers: { "Content-Type": "text/event-stream" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = createAISDKProvider(preset("https://openrouter.ai/api/v1"), "qwen/qwen3.7-flash", "sk-or");
    for await (const _event of provider.streamChat([{ role: "user", content: "hello" }], [])) {
      // consume the stream so the SDK performs the request
    }

    const requestInit = fetchMock.mock.calls[0][1] as RequestInit;
    expect(new Headers(requestInit.headers).get("HTTP-Referer")).toBe("https://github.com/amenski/nib");
    expect(new Headers(requestInit.headers).get("X-OpenRouter-Title")).toBe("Nib");

    vi.unstubAllGlobals();
    const otherFetch = vi.fn().mockResolvedValue(
      new Response("data: [DONE]\n\n", { status: 200, headers: { "Content-Type": "text/event-stream" } }),
    );
    vi.stubGlobal("fetch", otherFetch);
    const other = createAISDKProvider(preset("https://api.example.test/v1"), "m", "sk");
    for await (const _event of other.streamChat([{ role: "user", content: "hello" }], [])) {
      // consume the stream
    }
    const otherRequestInit = otherFetch.mock.calls[0][1] as RequestInit;
    expect(new Headers(otherRequestInit.headers).get("HTTP-Referer")).toBeNull();
    expect(new Headers(otherRequestInit.headers).get("X-OpenRouter-Title")).toBeNull();
    vi.unstubAllGlobals();
  });
});

describe("image attachments", () => {
  function stubStreamingFetch(): ReturnType<typeof vi.fn> {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("data: [DONE]\n\n", { status: 200, headers: { "Content-Type": "text/event-stream" } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  async function capturedBody(fetchMock: ReturnType<typeof vi.fn>): Promise<any> {
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    return JSON.parse(init.body as string);
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("maps an attached image to a file part alongside the text", () => {
    const mapped = mapMessages([
      { role: "user", content: "what is this?", imageUrls: ["data:image/png;base64,AAAB"] },
    ]);

    expect(mapped).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "what is this?" },
          { type: "file", mediaType: "image", data: "data:image/png;base64,AAAB" },
        ],
      },
    ]);
  });

  it("emits an image_url data URL in the request body", async () => {
    const fetchMock = stubStreamingFetch();
    const provider = createAISDKProvider(preset("https://api.example.test/v1"), "m", "sk-test");

    for await (const _ of provider.streamChat(
      [{ role: "user", content: "what is this?", imageUrls: ["data:image/png;base64,AAAB"] }],
      [],
    )) {
      // consume so the SDK performs the request
    }

    const body = await capturedBody(fetchMock);
    expect(body.messages.at(-1).content).toEqual([
      { type: "text", text: "what is this?" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAAB" } },
    ]);
  });

  it("resolves the media type from the data URL, not the literal 'image' from mapMessages", async () => {
    const fetchMock = stubStreamingFetch();
    const provider = createAISDKProvider(preset("https://api.example.test/v1"), "m", "sk-test");

    for await (const _ of provider.streamChat(
      [{ role: "user", content: "x", imageUrls: ["data:image/jpeg;base64,/9j/4AAQ"] }],
      [],
    )) {
      // consume
    }

    const body = await capturedBody(fetchMock);
    expect(body.messages.at(-1).content[1].image_url.url).toBe("data:image/jpeg;base64,/9j/4AAQ");
  });

  it("sends an image regardless of model — no client-side vision gating", async () => {
    const fetchMock = stubStreamingFetch();
    // A text-only model: the client still ships the image.
    const provider = createAISDKProvider(preset("https://api.example.test/v1"), "deepseek-v4-pro", "sk-test");

    for await (const _ of provider.streamChat(
      [{ role: "user", content: "x", imageUrls: ["data:image/png;base64,AAAB"] }],
      [],
    )) {
      // consume
    }

    const body = await capturedBody(fetchMock);
    expect(body.messages.at(-1).content.some((p: any) => p.type === "image_url")).toBe(true);
  });
});
