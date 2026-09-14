import type { Message } from "../types.js";
import type { Provider } from "../providers/types.js";
import { shouldCompact } from "./budget.js";
import { stripToolCallMarkup } from "../sessions/store.js";

const COMPACTION_PROMPT = `Summarize the following conversation between an AI agent and a user.
Structure the summary under these headings, omitting any heading with nothing to report:

## Task
The user's original request and goals. Quote the most recent user instruction verbatim — the resumed agent acts on it next.

## Decisions
Key decisions made and why.

## Files
Files that were read, modified, or created (with paths).

## Errors
Errors encountered and how they were resolved.

## Pending
Unfinished work, next steps, and anything the user asked for that has not been done yet.

Omit tool output details — just note what was done and the outcome.

Write the summary as plain prose only. Never emit XML or tool-call markup of any
kind — no <invoke>, <parameter>, <tool_calls>, or similar tags, escaped or not.`;

/**
 * How many trailing messages to keep uncompacted: 4, widened so the kept tail
 * never starts with a "tool" message. Splitting a tool result from the
 * assistant "tool_calls" message that produced it is a hard 400 on strict
 * providers ("Messages with role 'tool' must be a response to ... 'tool_calls'").
 * Shared by auto-compaction and the manual /compact path so both agree.
 */
export function keepBoundary(messages: Message[]): number {
  let keepCount = Math.min(4, messages.length);
  while (
    keepCount < messages.length &&
    messages[messages.length - keepCount].role === "tool"
  ) {
    keepCount++;
  }
  return keepCount;
}

export class Compactor {
  private lastChangedFiles: Set<string> = new Set();
  private fidelityRegenerationCount = 0;
  private sessionFiles: Set<string> = new Set();
  private lastSummary: string | null = null;

  constructor(
    private provider: Provider,
    private contextWindow: number = 128000,
    private threshold?: number,
    private auto: boolean = true,
  ) {}

  needsCompaction(messages: Message[], overheadTokens = 0): boolean {
    // `auto: false` (config compaction.auto) disables automatic compaction.
    // Explicit paths (summarizeForResume, manual /compact) bypass this gate.
    if (!this.auto) return false;
    return shouldCompact(messages, this.contextWindow, this.threshold, overheadTokens);
  }

  trackFiles(files: string[]): void {
    for (const f of files) {
      this.lastChangedFiles.add(f);
      this.sessionFiles.add(f);
    }
  }

  async compact(
    messages: Message[],
    extraPrompt?: string,
    overheadTokens = 0,
  ): Promise<Message[]> {
    if (!this.needsCompaction(messages, overheadTokens)) return messages;

    const keepCount = keepBoundary(messages);
    const recent = messages.slice(-keepCount);
    const old = messages.slice(0, messages.length - keepCount);

    if (old.length === 0) return messages;

    let summaryContent = await this.summarize(old, this.lastChangedFiles, extraPrompt);

    const changedFiles = [...this.lastChangedFiles];
    if (changedFiles.length > 0) {
      const fidelityOk = this.fidelityCheck(summaryContent, changedFiles);
      if (!fidelityOk && this.fidelityRegenerationCount < 1) {
        this.fidelityRegenerationCount++;
        summaryContent = await this.summarize(old, this.lastChangedFiles, extraPrompt);
      } else if (!fidelityOk) {
        console.warn("[compaction] Fidelity check failed, deferring compaction");
        return messages;
      }
    }

    this.lastChangedFiles.clear();
    this.lastSummary = summaryContent;
    this.fidelityRegenerationCount = 0;

    const summary: Message = {
      role: "system",
      content: `[Previous conversation summary]\n${summaryContent}`,
    };

    return [summary, ...recent];
  }

  getLastCompaction(): { summary: string | null; files: string[] } {
    return { summary: this.lastSummary, files: [...this.sessionFiles] };
  }

  /**
   * Summarize an explicit span of messages on demand, bypassing the auto
   * threshold. Used by the resume chooser when the user opts to compact — the
   * caller decides what to keep and how to persist the overlay.
   */
  async summarizeForResume(messages: Message[]): Promise<string> {
    return this.summarize(messages, this.lastChangedFiles);
  }

  private async summarize(messages: Message[], changedFiles?: Set<string>, extraPrompt?: string): Promise<string> {
    const conversation = messages.map(m => {
      if (m.role === "tool") {
        return `[tool result: ${m.content.slice(0, 200)}]`;
      }
      if (m.role === "assistant" && m.toolCalls) {
        const calls = m.toolCalls.map(tc => tc.name).join(", ");
        return `[assistant called tools: ${calls}]`;
      }
      return `${m.role}: ${m.content || ""}`;
    }).join("\n");

    let prompt = COMPACTION_PROMPT;
    if (extraPrompt) {
      prompt += `\n${extraPrompt}`;
    }
    if (changedFiles && changedFiles.size > 0) {
      const fileList = [...changedFiles].join(", ");
      prompt += `\nFiles modified in this session: ${fileList}\nMake sure your summary mentions these files.`;
    }

    const summaryMessages: Message[] = [
      { role: "system", content: prompt },
      { role: "user", content: conversation },
    ];

    let result = "";

    for await (const event of this.provider.streamChat(summaryMessages, [])) {
      if (event.type === "text_delta") {
        result += event.content;
      }
    }

    // stripToolCallMarkup is a hard guarantee: even if the model ignores the
    // prompt instruction and leaks markup, nothing raw reaches the live
    // context (compact()), the resume overlay (appendCompaction), or memory.
    return stripToolCallMarkup(result) || "Conversation summarized.";
  }

  private fidelityCheck(summary: string, files: string[]): boolean {
    const missing = files.filter(f => !summary.includes(f));
    return missing.length === 0;
  }
}
