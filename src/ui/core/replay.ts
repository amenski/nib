/**
 * Resume replay — turn a loaded session transcript back into the exact
 * scrollback lines a live turn would have produced.
 *
 * The model already sees the resumed messages via conversationHistory; this is
 * purely visual. It reuses the live formatters (formatToolCallHeader,
 * formatToolResultPreview) and the USER_ECHO_TAG gutter so a resumed transcript
 * is indistinguishable from one that just streamed. Read-only tools that are
 * hidden live (SILENT_TOOLS) stay hidden here too, so replay never shows *more*
 * than the original session did.
 */

import type { Message } from "../../types.js";
import {
  formatToolCallHeader,
  formatToolResultPreview,
  SILENT_TOOLS,
} from "../ToolCallFormatter.js";
import { USER_ECHO_TAG, VERBATIM_TAG, BULLET_TAG, ANSWER_CONT_TAG, TOOL_HEADER_TAG, TOOL_RESULT_TAG } from "../constants.js";
import type { ThemeContextValue } from "../theme.js";

/**
 * Tag an assistant message as one answer block: the opening line carries
 * BULLET_TAG and every later line ANSWER_CONT_TAG — the same tags live output
 * carries. Previously a literal "● " was string-prepended, which registered as
 * no answer block at all (OutputArea never saw a tag), so a resumed transcript
 * lost the two-column gutter — and the "● " prefix additionally defeated
 * block-level markdown anchored at the start of a line, so a replayed heading
 * or list item never matched and rendered as raw text.
 */
const answerBlockLines = (content: string): string[] =>
  content.split("\n").map((line, i) => (i === 0 ? BULLET_TAG : ANSWER_CONT_TAG) + line);

/**
 * Build the scrollback lines for a resumed transcript. Silent (context-only)
 * tool calls and their results are dropped, matching live rendering.
 *
 * Every line pushed here is tagged VERBATIM_TAG so OutputArea never runs it
 * through progressive-disclosure summarization: the user asked to reload
 * their history, and got back an unreadable truncated stub of their own
 * prior messages (a 1421-char message rendered as ~300 chars). Progressive
 * disclosure is right for a huge tool result streaming by mid-turn; it is
 * wrong for restored conversation, since there is no way to ever see the
 * missing text again. VERBATIM_TAG composes with the other sentinel tags
 * (USER_ECHO_TAG, BULLET_TAG) via the `tag` helper below — always placed
 * outermost so OutputArea strips it first and still detects the tag
 * underneath for gutter/bullet rendering.
 */
const tag = (line: string): string => VERBATIM_TAG + line;

export function buildReplayLines(messages: Message[], theme: ThemeContextValue): string[] {
  const out: string[] = [];
  const dim = (s: string): string => theme.fg(theme.theme.textDim, s);
  // Tool-call ids whose call header was suppressed (silent tool) — their result
  // message must be suppressed too, so the replay stays consistent.
  const silentCallIds = new Set<string>();

  for (const msg of messages) {
    if (msg.role === "system") {
      // A compaction summary is the only system message worth surfacing; the
      // per-turn system prompt is noise. Show summaries dimmed.
      if (msg.content.startsWith("[Previous conversation summary]")) {
        out.push("");
        out.push(tag(dim(msg.content)));
        out.push("");
      }
      continue;
    }

    if (msg.role === "user") {
      // A persisted compaction overlay is stored as a user message; render it as
      // a dim summary rather than user input.
      if (msg.content.startsWith("[Previous conversation summary]")) {
        out.push("");
        out.push(tag(dim(msg.content)));
        out.push("");
        continue;
      }
      out.push("");
      out.push(tag(USER_ECHO_TAG + msg.content));
      out.push("");
      continue;
    }

    if (msg.role === "assistant") {
      if (msg.content && msg.content.trim() !== "") {
        out.push(...answerBlockLines(msg.content).map(tag));
      }
      for (const call of msg.toolCalls ?? []) {
        if (SILENT_TOOLS.has(call.name)) {
          silentCallIds.add(call.id);
          continue;
        }
        out.push("");
        // TOOL_HEADER_TAG, exactly as the live path tags it (App.tsx's
        // onToolStart), so a replayed header is not run through the markdown
        // renderer: arguments are shell/path text where a marker is literal.
        out.push(tag(TOOL_HEADER_TAG + formatToolCallHeader(call.name, call.arguments)));
      }
      continue;
    }

    if (msg.role === "tool") {
      if (silentCallIds.has(msg.toolCallId)) continue;
      const content = msg.content ?? "";
      if (content.trim() === "") continue;
      const isError =
        content.startsWith("PERMISSION_DENIED") || content.startsWith("COMMAND_FAILED");
      for (const line of formatToolResultPreview(content)) {
        // TOOL_RESULT_TAG, as the live path tags its preview lines (App.tsx's
        // onToolResult). Without it a replayed preview was markdown-parsed, and
        // the markdown wrapper drops a run of spaces at the start of a row — so
        // the "     " gutter and the payload's own indentation were stripped on
        // every resumed session, while the same output streamed live kept them.
        out.push(
          tag(
            TOOL_RESULT_TAG +
              (isError ? theme.fg(theme.theme.error, line) : theme.fg(theme.theme.toolOutput, line)),
          ),
        );
      }
      continue;
    }
  }

  return out;
}
