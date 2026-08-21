import { streamText, tool, jsonSchema, stepCountIs } from "ai";
import type { JSONSchema7, ModelMessage } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import type { Message, ToolDef } from "../types.js";
import type { Provider, ProviderBalance, StreamEvent } from "./types.js";
import type { ProviderPreset } from "./presets.js";
import { logRequest, logResponse, logTiming } from "../debug/logger.js";

export function mapMessages(messages: Message[]): ModelMessage[] {
  const toolNameByCallId = new Map<string, string>();
  for (const m of messages) {
    if (m.role === "assistant" && m.toolCalls) {
      for (const tc of m.toolCalls) {
        toolNameByCallId.set(tc.id, tc.name);
      }
    }
  }

  return messages.filter((m) => !(m.role === "assistant" && m.meta?.asThinking)).map((m) => {
    switch (m.role) {
      case "system":
        return { role: "system", content: m.content };

      case "user": {
        if (!m.imageUrls || m.imageUrls.length === 0) {
          return { role: "user", content: m.content };
        }
        const parts: Array<
          | { type: "text"; text: string }
          | { type: "file"; mediaType: string; data: string }
        > = [];
        if (m.content) {
          parts.push({ type: "text", text: m.content });
        }
        for (const url of m.imageUrls) {
          parts.push({ type: "file", mediaType: "image", data: url });
        }
        return { role: "user", content: parts };
      }

      case "assistant": {
        const parts: Array<
          | { type: "text"; text: string }
          | { type: "tool-call"; toolCallId: string; toolName: string; input: Record<string, unknown> }
        > = [];
        if (m.content) {
          parts.push({ type: "text", text: m.content });
        }
        if (m.toolCalls) {
          for (const tc of m.toolCalls) {
            parts.push({
              type: "tool-call",
              toolCallId: tc.id,
              toolName: tc.name,
              input: tc.arguments,
            });
          }
        }
        return { role: "assistant", content: parts };
      }

      case "tool":
        return {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: m.toolCallId,
              // New results carry their name directly. The lookup preserves
              // compatibility with old persisted sessions; only a corrupt
              // legacy record can reach this valid-but-obvious fallback.
              toolName: m.toolName ?? toolNameByCallId.get(m.toolCallId) ?? "legacy_unknown_tool",
              output: { type: "text" as const, value: m.content },
            },
          ],
        };
    }
  });
}

function mapTools(tools: ToolDef[]): Record<string, ReturnType<typeof tool>> {
  const result: Record<string, ReturnType<typeof tool>> = {};
  for (const t of tools) {
    result[t.name] = tool({
      description: t.description,
      inputSchema: jsonSchema(t.parameters as unknown as JSONSchema7),
    });
  }
  return result;
}

function createAIInstance(apiType: string, baseUrl: string, apiKey: string, model: string) {
  if (apiType === "anthropic") {
    return createAnthropic({ apiKey })(model);
  }
  let hostname: string | undefined;
  try {
    hostname = new URL(baseUrl).hostname;
  } catch {
    // The SDK will report the malformed URL when the request is attempted.
  }
  const headers = hostname === "openrouter.ai"
    ? {
        "HTTP-Referer": "https://github.com/amenski/heirloom-agent",
        "X-OpenRouter-Title": "Heirloom",
      }
    : undefined;
  return createOpenAI({ baseURL: baseUrl, apiKey, ...(headers ? { headers } : {}) }).chat(model);
}

/**
 * Live prepaid balance for the providers that expose one. Host-based branching
 * lives here, in the ADAPTER — the CLI only ever sees the optional
 * `Provider.getBalance` method and treats null as "not supported here".
 *
 *   deepseek  GET {baseUrl}/user/balance   → balance_infos, USD entry
 *             (total_balance / granted_balance are strings; remaining is
 *             derived as total - granted = the topped-up, unrestricted part)
 *   openrouter GET https://openrouter.ai/api/v1/credits
 *             (remaining_credits is the whole balance — OpenRouter has no
 *             grant concept, so total = remaining and granted = 0)
 *
 * Any failure (unsupported host, non-200, unparseable body, network error)
 * resolves to null — never throws.
 */
async function fetchBalance(baseUrl: string, apiKey: string): Promise<ProviderBalance | null> {
  let host: string;
  try {
    host = new URL(baseUrl).hostname;
  } catch {
    return null;
  }

  try {
    if (host === "api.deepseek.com") {
      const res = await fetch(`${baseUrl}/user/balance`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!res.ok) return null;
      const body = (await res.json()) as {
        balance_infos?: { currency: string; total_balance: string; granted_balance: string }[];
      };
      const usd = body.balance_infos?.find((b) => b.currency === "USD");
      if (!usd) return null;
      return {
        currency: usd.currency,
        total: parseFloat(usd.total_balance),
        granted: parseFloat(usd.granted_balance),
      };
    }

    if (host === "openrouter.ai") {
      const res = await fetch("https://openrouter.ai/api/v1/credits", {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!res.ok) return null;
      const body = (await res.json()) as {
        data?: { total_credits?: number; total_usage?: number; remaining_credits?: number };
      };
      const data = body.data;
      if (!data) return null;
      // Prefer the reported remaining balance; fall back to total − usage.
      const remaining =
        typeof data.remaining_credits === "number"
          ? data.remaining_credits
          : typeof data.total_credits === "number" && typeof data.total_usage === "number"
            ? data.total_credits - data.total_usage
            : null;
      if (remaining === null) return null;
      return { currency: "USD", total: remaining, granted: 0 };
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Reasoning levels the AI SDK's standardized `reasoning` option accepts
 * (LanguageModelV4CallOptions). Note "max" is absent — see toReasoningLevel.
 */
const SDK_REASONING_LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh"] as const;
type SdkReasoningLevel = (typeof SDK_REASONING_LEVELS)[number];

/**
 * Map heirloom's effort value onto the SDK's `reasoning` union.
 *
 * This must go through the top-level `reasoning` option, NOT a top-level
 * `reasoningEffort`: streamText funnels unknown keys into `...settings` and
 * prepareLanguageModelCallOptions keeps only a fixed whitelist, so a stray
 * `reasoningEffort` is dropped silently (it was, for this file's whole life).
 *
 * "max" is a real DeepSeek level but is not in the SDK union, so it degrades to
 * the nearest supported level rather than being dropped. Unknown values return
 * undefined — omit rather than throw, since parseProviderOptions throws on a
 * literal mismatch and a bad config value should not kill every turn.
 */
function toReasoningLevel(effort: string | undefined): SdkReasoningLevel | undefined {
  if (!effort) return undefined;
  if ((SDK_REASONING_LEVELS as readonly string[]).includes(effort)) return effort as SdkReasoningLevel;
  if (effort === "max") return "xhigh";
  return undefined;
}

export function createAISDKProvider(preset: ProviderPreset, model: string, apiKey: string): Provider {
  return {
    name: model,

    getBalance: () => fetchBalance(preset.baseUrl, apiKey),

    async *streamChat(
      messages: Message[],
      tools: ToolDef[],
      options?: { temperature?: number; maxTokens?: number; signal?: AbortSignal; effort?: string; thinkingEnabled?: boolean },
    ): AsyncGenerator<StreamEvent> {
      const baseUrl = preset.baseUrl;
      const modelInstance = createAIInstance(preset.api, baseUrl, apiKey, model);

      const reasoning = toReasoningLevel(options?.effort);
      // Reasoning/thinking mode rejects sampling parameters (DeepSeek documents
      // temperature, top_p, presence_penalty and frequency_penalty as
      // unsupported), so drop temperature whenever a level is in play.
      const temperature = reasoning ? undefined : options?.temperature;

      logRequest({
        model,
        messages,
        tools,
        max_tokens: options?.maxTokens,
        temperature,
        effort: reasoning,
      });

      const requestStart = Date.now();
      let firstEventAt: number | undefined;
      let firstTextAt: number | undefined;
      const promptBytes = messages.reduce((n, m) => n + (m.content?.length ?? 0), 0);

      const result = streamText({
        model: modelInstance,
        messages: mapMessages(messages),
        tools: tools.length > 0 ? mapTools(tools) : undefined,
        temperature,
        maxOutputTokens: options?.maxTokens,
        abortSignal: options?.signal,
        maxRetries: 3,
        ...(reasoning ? { reasoning } : {}),
        stopWhen: stepCountIs(1),
        allowSystemInMessages: true,
      });

      const toolCallAccum = new Map<string, { id: string; name: string; args: string }>();
      const started = new Set<string>();
      let cachedTokens: number | undefined;

      for await (const event of result.fullStream) {
        if (firstEventAt === undefined) firstEventAt = Date.now();
        switch (event.type) {
          case "text-delta":
            if (firstTextAt === undefined) firstTextAt = Date.now();
            yield { type: "text_delta", content: event.text };
            break;

          case "reasoning-delta":
            yield { type: "reasoning_delta", content: event.text };
            break;

          case "tool-input-start": {
            const id = event.id;
            toolCallAccum.set(id, { id, name: event.toolName, args: "" });
            if (!started.has(id)) {
              started.add(id);
              yield { type: "tool_call_start", id, name: event.toolName };
            }
            break;
          }

          case "tool-input-delta": {
            const id = event.id;
            const entry = toolCallAccum.get(id);
            if (entry) {
              entry.args += event.delta;
            }
            if (!started.has(id)) {
              started.add(id);
              yield { type: "tool_call_start", id, name: entry?.name ?? "unknown" };
            }
            yield { type: "tool_call_delta", id, arguments: event.delta };
            break;
          }

          case "tool-input-end":
            break;

          case "tool-call": {
            if (!started.has(event.toolCallId)) {
              yield { type: "tool_call_start", id: event.toolCallId, name: event.toolName };
              yield {
                type: "tool_call_delta",
                id: event.toolCallId,
                arguments: JSON.stringify(event.input),
              };
            }
            break;
          }

          case "finish-step":
            cachedTokens = event.usage.inputTokenDetails?.cacheReadTokens ?? undefined;
            yield {
              type: "usage",
              inputTokens: event.usage.inputTokens ?? 0,
              outputTokens: event.usage.outputTokens ?? 0,
              cachedInputTokens: cachedTokens,
            };
            logResponse(event.usage, Array.from(toolCallAccum.values()));
            break;

          case "finish": {
            const finishedAt = Date.now();
            logTiming({
              phase: "request",
              model,
              effort: reasoning,
              promptBytes,
              toolCount: tools.length,
              cachedTokens,
              durationsMs: {
                total: finishedAt - requestStart,
                toFirstEvent: firstEventAt !== undefined ? firstEventAt - requestStart : undefined,
                toFirstText: firstTextAt !== undefined ? firstTextAt - requestStart : undefined,
              },
            });
            yield { type: "done", finishReason: event.finishReason };
            break;
          }

          case "error":
            throw event.error;
        }
      }
    },
  };
}
