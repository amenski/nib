export type Role = "system" | "user" | "assistant" | "tool";

export interface SystemMessage {
  role: "system";
  content: string;
}

export interface UserMessage {
  role: "user";
  content: string;
  /** Data URLs (e.g. "data:image/png;base64,...") for images attached to this message. */
  imageUrls?: string[];
}

export interface AssistantMessage {
  role: "assistant";
  content: string | null;
  toolCalls?: ToolCall[];
  /** Present only on synthetic messages carrying model "thinking"/reasoning text, rendered collapsed by default. */
  meta?: { asThinking?: boolean };
}

export interface ToolResultMessage {
  role: "tool";
  toolCallId: string;
  content: string;
  /** The tool name is carried on new results; absent only in old persisted sessions. */
  toolName?: string;
}

export type Message = SystemMessage | UserMessage | AssistantMessage | ToolResultMessage;

export interface ToolDef {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
  };
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolOutput {
  content: string;
  error?: string;
  /** True ends the agent's turn after this tool result (attempt_completion). */
  stop?: boolean;
  /**
   * Data URLs (e.g. "data:image/png;base64,…") the model should see as images.
   * Tool results are text-only on the wire, so the agent loop re-emits these as
   * a synthetic user message carrying `imageUrls` — the only message role that
   * delivers image bytes (see providers/aisdk.ts mapMessages). Set by tools
   * like view_image; ignored when `error` is set.
   */
  attachments?: string[];
}
