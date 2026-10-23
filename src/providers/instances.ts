import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { randomUUID } from "node:crypto";
import { pkg } from "../version.js";

// A stable id for processes without a conversation session (a headless -p run,
// the risk judge): one process is one conversation, so one id per process.
const PROCESS_SESSION_ID = randomUUID();

/**
 * Host-specific request headers, decided once per provider instance.
 * OpenRouter gets its attribution pair; OpenCode Go's inference endpoints
 * require a per-conversation `x-opencode-session` header and a nib user agent
 * (https://opencode.ai/docs/go/) or the request is refused without routing.
 * Every other host sends nothing.
 */
export function hostHeaders(baseUrl: string, sessionId?: string): Record<string, string> | undefined {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    // The SDK will report the malformed URL when the request is attempted.
    return undefined;
  }
  if (parsed.hostname === "openrouter.ai") {
    return {
      "HTTP-Referer": "https://github.com/amenski/nib",
      "X-OpenRouter-Title": "Nib",
    };
  }
  if (parsed.pathname.includes("/inference/go/")) {
    return {
      "x-opencode-session": sessionId ?? PROCESS_SESSION_ID,
      "user-agent": `${pkg.name}/${pkg.version}`,
    };
  }
  return undefined;
}

/**
 * The provider instance behind an `api` setting. Anthropic requests go through
 * its own SDK; everything else is an OpenAI-compatible chat endpoint, whose
 * only per-host variation is the headers hostHeaders supplies.
 */
export function createAIInstance(apiType: string, baseUrl: string, apiKey: string, model: string,
                                 sessionId?: string) {
  if (apiType === "anthropic") {
    return createAnthropic({ apiKey })(model);
  }
  const headers = hostHeaders(baseUrl, sessionId);
  return createOpenAI({ baseURL: baseUrl, apiKey, ...(headers ? { headers } : {}) }).chat(model);
}
