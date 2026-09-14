import type { Message } from "../types.js";

// Per-message raw char-sum cache. estimateTokens is called repeatedly over the
// same growing message array inside the turn loop (recordTokens + compaction
// check), and re-serializing every tool call's arguments each time is an
// O(conversation-size) synchronous scan that starves the UI event loop. Keying
// by message identity lets us compute each message's contribution once; the
// loop mutates a single stable `messages` array, so references are stable. We
// cache the RAW char sum (not the divided/rounded token count) so the final
// Math.ceil(total / 4) stays byte-identical to computing from scratch.
const rawCharCache = new WeakMap<Message, number>();

export interface TokenBreakdown {
  role: string;
  tokens: number;
  chars: number;
}

/** Exported so `messageRawChars` is visible to tests and the /context command. */
export function messageRawChars(m: Message): number {
  const cached = rawCharCache.get(m);
  if (cached !== undefined) return cached;
  let total = m.content?.length ?? 0;
  if (m.role === "assistant" && m.toolCalls) {
    for (const tc of m.toolCalls) {
      total += JSON.stringify(tc.arguments).length + tc.name.length;
    }
  }
  rawCharCache.set(m, total);
  return total;
}

export function estimateTokens(messages: Message[]): number {
  let chars = 0;
  let imageTotal = 0;
  for (const m of messages) {
    chars += messageRawChars(m);
    imageTotal += imageTokens(m);
  }
  return Math.ceil(chars / 4) + imageTotal;
}

export function estimateTokensDetailed(messages: Message[]): TokenBreakdown[] {
  return messages.map((m) => {
    const chars = messageRawChars(m);
    // Images ride on the row as tokens, not chars — there are no base64
    // characters in `chars`, so this keeps the per-role sums in /context equal
    // to what estimateTokens reports for the same set.
    return { role: m.role, tokens: Math.ceil(chars / 4) + imageTokens(m), chars };
  });
}

/**
 * Nominal token cost of one attached image.
 *
 * Real vision cost depends on the provider, the model, and the image's PIXEL
 * dimensions — none of which this synchronous estimator can see (decoding an
 * image just to size it would stall the turn). Counting the literal base64
 * payload is not the answer either: a 154 KB JPEG is ~205k characters of data
 * URL, which under the chars/4 convention reads as ~51k tokens against a real
 * cost nearer 1–2k — a 20–40x over-report that would trip compaction on a
 * single screenshot.
 *
 * So this is a deliberate flat stand-in, in the same spirit as the catalog's
 * approximate pricing. Its purpose is narrow: make an attached image VISIBLE
 * to the context meter and the compaction trigger instead of counting as zero.
 * It is an approximation, not a measurement.
 */
export const IMAGE_TOKEN_ESTIMATE = 1_100;

function imageTokens(m: Message): number {
  return m.role === "user" && m.imageUrls?.length
    ? m.imageUrls.length * IMAGE_TOKEN_ESTIMATE
    : 0;
}

/**
 * Tokens that ride on every request but never live in `messages`: the tool
 * schemas (passed straight to provider.streamChat) and the volatile-context
 * prefix (attached to the trailing user message at request time only). The
 * single definition every consumer shares — the compaction check, the status
 * bar meter, and /context — so they cannot disagree about context fill.
 *
 * Same chars/4 convention as estimateTokens, which under-reads dense JSON
 * schemas; calibrating against provider-reported inputTokens would fix that.
 */
export function estimateOverheadTokens(
  tools: unknown,
  volatileContext?: string,
): number {
  const toolChars = tools ? JSON.stringify(tools).length : 0;
  return Math.ceil((toolChars + (volatileContext?.length ?? 0)) / 4);
}

export function shouldCompact(
  messages: Message[],
  contextWindow: number,
  threshold?: number,
  overheadTokens = 0,
): boolean {
  const ratio = threshold ?? 0.7;
  const cutoff = contextWindow * ratio;
  const used = estimateTokens(messages) + overheadTokens;
  return used >= cutoff;
}
