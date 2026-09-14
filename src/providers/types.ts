import type { Message, ToolDef } from "../types.js";

export interface ModelCapabilities {
  supportsTools: boolean;
  contextWindow: number;
  displayName?: string;
  effort?: {
    values: string[];
    default: string;
  };
  /**
   * USD per million tokens. APPROXIMATE — the values in models.json were not
   * verified against live price sheets and vendors change them without notice.
   * Only feeds the status-bar cost estimate, never a billing or routing
   * decision, so drift is cosmetic. (Context limits live in `contextWindow`,
   * which is separate and does drive compaction.)
   */
  pricing?: { inputPerM: number; outputPerM: number };
  /**
   * Whether the model accepts image input. `true` = declared capable,
   * `false` = declared text-only, absent = unknown.
   *
   * The bundled catalog derives this from Models.dev's `modalities.input`
   * array (`true` = includes "image", `false` = declared without it). Absent is
   * still a real case: the hand-maintained `ollama` block and user overrides
   * that omit it carry no modality data, and guessing from a model's name
   * would be inventing a fact. Consumers therefore treat "not declared
   * capable" as the case worth mentioning (see imageSupportWarning) rather than
   * assuming either way. Declare it per model in provider-presets.json (or a
   * user catalog override) to record the truth for models the feed doesn't
   * describe.
   */
  vision?: boolean;
}

export type StreamEvent =
  | { type: "text_delta"; content: string }
  | { type: "reasoning_delta"; content: string }
  | { type: "tool_call_start"; id: string; name: string }
  | { type: "tool_call_delta"; id: string; arguments: string }
  | { type: "usage"; inputTokens: number; outputTokens: number; cachedInputTokens?: number }
  | { type: "done"; finishReason: string };

/**
 * A provider's prepaid account balance, queried live (never cached) for the
 * `/usage` view. `total` is the current balance; `granted` is the portion of it
 * that was granted free by the provider (0 when the provider has no grant
 * concept). `remaining` is derived as `total - granted` by the caller.
 */
export interface ProviderBalance {
  currency: string;
  total: number;
  granted: number;
}

export interface Provider {
  readonly name: string;
  streamChat(
    messages: Message[],
    tools: ToolDef[],
    options?: { temperature?: number; maxTokens?: number; signal?: AbortSignal; effort?: string; thinkingEnabled?: boolean },
  ): AsyncGenerator<StreamEvent>;
  /**
   * Live prepaid balance for providers that expose one, keyed off the base URL
   * host (deepseek, openrouter — see provider-spec.md §2.1). Returns null when
   * the provider has no balance endpoint, the request fails, or the response
   * does not parse — NEVER throws. Absent on providers without an
   * implementation.
   */
  getBalance?(): Promise<ProviderBalance | null>;
}
