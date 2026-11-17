/**
 * How to switch thinking off on an OpenAI-compatible chat endpoint. The SDK
 * turns `reasoning: "none"` into `reasoning_effort: "none"`, which only OpenAI
 * understands; each other host has its own switch, keyed on hostname like
 * hostHeaders.
 */
export interface ThinkingOffPatch {
  /** Fields merged into the request body. */
  set: Record<string, unknown>;
  /** Remove the SDK's `reasoning_effort` (hosts that would reject or ignore it). */
  dropEffort: boolean;
}

export function thinkingOffPatch(baseUrl: string): ThinkingOffPatch | undefined {
  let host: string;
  try {
    host = new URL(baseUrl).hostname;
  } catch {
    return undefined;
  }
  if (host === "openrouter.ai") return { set: { reasoning: { enabled: false } }, dropEffort: true };
  if (host.endsWith(".aliyuncs.com")) return { set: { enable_thinking: false }, dropEffort: true };
  if (host === "api.deepseek.com" || host === "api.z.ai" || host === "open.bigmodel.cn"
    || host === "api.moonshot.ai" || host === "api.moonshot.cn") {
    return { set: { thinking: { type: "disabled" } }, dropEffort: true };
  }
  // Ollama also reads reasoning_effort, so it stays alongside the template switch.
  if (host === "localhost" || host === "127.0.0.1") {
    return { set: { chat_template_kwargs: { enable_thinking: false } }, dropEffort: false };
  }
  return undefined;
}

/** A fetch that applies `patch` to JSON request bodies; other requests pass through. */
export function patchingFetch(patch: ThinkingOffPatch): typeof fetch {
  return (input, init) => {
    if (typeof init?.body === "string") {
      try {
        const body = JSON.parse(init.body) as Record<string, unknown>;
        if (patch.dropEffort) delete body.reasoning_effort;
        return globalThis.fetch(input, { ...init, body: JSON.stringify({ ...body, ...patch.set }) });
      } catch {
        // Not JSON: send as-is.
      }
    }
    return globalThis.fetch(input, init);
  };
}
