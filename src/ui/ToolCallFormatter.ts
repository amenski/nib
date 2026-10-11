import { stripUntrustedMarkers } from "../tools/untrusted-content.js";

/** Escape regex special characters. */
export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Read-only tools that just gather context — hide these from the output to
// keep the chat focused on what the agent actually *changes*.
export const SILENT_TOOLS = new Set(["list_files", "read_file", "glob", "search", "load_skill"]);

/** Human-friendly display names for the ⏺ Tool(args) header. */
const TOOL_DISPLAY_NAMES: Record<string, string> = {
  run_bash: "Bash",
  read_file: "Read",
  list_files: "List",
  glob: "Glob",
  search: "Search",
  write_to_file: "Write",
  edit: "Edit",
  edit_file: "Edit",
  search_replace: "Update",
  apply_diff: "Patch",
  apply_patch: "Patch",
  load_skill: "Skill",
  new_task: "Task",
  ask_user_question: "AskUserQuestion",
};

/** Human-friendly display name for a ⏺ Tool(args) header. */
export function toolDisplayName(name: string): string {
  return TOOL_DISPLAY_NAMES[name] ?? name;
}

/** The three parts of a tool-call header, before any colouring. */
export interface ToolHeaderParts {
  /** Outcome glyph opening the line. */
  dot: string;
  /** Display name, e.g. "Bash". */
  name: string;
  /** Argument text; "" when the tool takes none. */
  args: string;
}

/**
 * Split a call into its header parts. Kept separate from the string-building
 * below so callers with a theme can colour the parts independently.
 */
export function toolHeaderParts(name: string, args: Record<string, unknown>): ToolHeaderParts {
  const desc = describeToolCall(name, args);
  // describeToolCall returns "name arg…" — strip the leading raw name to get just the arg.
  const arg = desc.startsWith(name) ? desc.slice(name.length).trim() : desc;
  return { dot: "⏺", name: toolDisplayName(name), args: arg };
}

/** "⏺ Bash(grep -rn "x" src/…)" — headline for a tool call. */
export function formatToolCallHeader(name: string, args: Record<string, unknown>): string {
  const { dot, name: display, args: arg } = toolHeaderParts(name, args);
  return arg ? `${dot} ${display}(${arg})` : `${dot} ${display}`;
}

/**
 * The minimal theme surface a header needs (mirrors MarkdownText's own theme
 * prop rather than depending on ThemeContextValue).
 */
export interface HeaderTheme {
  colorEnabled: boolean;
  theme: { text: number; textDim: number };
  fg: (color: number, text: string) => string;
  bold: (color: number, text: string) => string;
}

/**
 * A tool-call header as one styled string: a dim glyph, the bold display name,
 * then the arguments plainly. Built from text + escapes rather than JSX so it
 * can ride the transcript's line protocol — the caller prefixes
 * TOOL_HEADER_TAG, which tells OutputArea to render the line as-is instead of
 * through the markdown renderer. An argument such as a glob pattern is shell
 * text, not an emphasis span, and markdown used to eat it.
 *
 * The glyph is dim because the header is emitted when the call STARTS: its
 * outcome is not known yet (agent.ts fires every onToolStart in a batch before
 * any result), so an outcome-coloured dot is not available here. The result
 * preview below the header carries the outcome colour instead.
 */
export function formatStyledToolHeader(
  theme: HeaderTheme,
  name: string,
  args: Record<string, unknown>,
): string {
  const { dot, name: display, args: arg } = toolHeaderParts(name, args);
  const glyph = theme.colorEnabled ? theme.fg(theme.theme.textDim, dot) : dot;
  const label = theme.colorEnabled ? theme.bold(theme.theme.text, display) : display;
  return arg ? `${glyph} ${label}(${arg})` : `${glyph} ${label}`;
}

/** Per-line cap for a result preview (see formatToolResultPreview). */
export const PREVIEW_LINE_MAX = 240;

/**
 * Claude Code-style collapsed result preview:
 *   ⎿  first line
 *      second line
 *      … +N lines
 */
export function formatToolResultPreview(content: string, maxLines = 3): string[] {
  // Model-facing untrusted-content delimiters (security-spec T12) stay in the
  // context; the human preview shows the payload only.
  const allLines = stripUntrustedMarkers(content).replace(/\s+$/, "").split("\n");
  const shown = allLines.slice(0, maxLines);
  const out: string[] = [];
  shown.forEach((line, i) => {
    // Cap each line: a preview is rendered as pre-styled text (TOOL_HEADER_TAG),
    // which skips OutputArea's progressive disclosure — so one minified-JSON
    // line would otherwise print thousands of columns.
    const capped = line.length > PREVIEW_LINE_MAX ? line.slice(0, PREVIEW_LINE_MAX - 1) + "…" : line;
    out.push(i === 0 ? `  ⎿  ${capped}` : `     ${capped}`);
  });
  const hidden = allLines.length - shown.length;
  if (hidden > 0) out.push(`     … +${hidden} line${hidden === 1 ? "" : "s"}`);
  return out;
}

export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * Return a compact human-readable description of a tool call (no ANSI).
 * Paths are relativized to cwd.
 */
export function describeToolCall(name: string, args: Record<string, unknown>): string {
  const cwd = process.cwd();
  const firstStr = (...keys: string[]): string | undefined => {
    for (const k of keys) {
      const v = args[k];
      if (typeof v === "string" && v.length > 0) return v;
    }
    return undefined;
  };
  const short = (p: string): string => {
    const prefix = cwd + "/";
    if (p.startsWith(prefix)) return p.slice(prefix.length);
    if (p === cwd) return ".";
    return p;
  };
  const trunc = (s: string, max: number) => s.length > max ? s.slice(0, max) + "…" : s;

  switch (name) {
    case "list_files": {
      const p = firstStr("path");
      return p ? `list_files ${short(p)}/` : "list_files";
    }
    case "read_file": {
      const p = firstStr("path");
      if (!p) return "read_file";
      const o = typeof args.offset === "number" ? args.offset : null;
      const l = typeof args.limit === "number" ? args.limit : null;
      const range =
        o !== null && l !== null ? `:${o}-${o + l - 1}`
        : o !== null ? `:${o}`
        : "";
      return `read_file ${short(p)}${range}`;
    }
    case "write_to_file": {
      const p = firstStr("path", "filePath");
      return p ? `write_to_file ${short(p)}` : "write_to_file";
    }
    case "edit":
    case "edit_file": {
      const p = firstStr("path", "filePath");
      return p ? `${name} ${short(p)}` : name;
    }
    case "search_replace": {
      const p = firstStr("path", "filePath");
      return p ? `search_replace ${short(p)}` : "search_replace";
    }
    case "apply_diff":
    case "apply_patch": {
      const p = firstStr("path", "filePath");
      return p ? `${name} ${short(p)}` : name;
    }
    case "run_bash": {
      const c = firstStr("command");
      if (!c) return "run_bash";
      // Strip `cd <cwd> && ` prefix — it's implicit context, not the real command
      let t = c.replace(/\n/g, " ").trim();
      t = t.replace(new RegExp(`^cd ${escapeRegex(cwd)}(?:/)?\\s*&&\\s*`), "");
      return `run_bash ${trunc(t, 60)}`;
    }
    case "glob": {
      const p = firstStr("pattern");
      return p ? `glob ${p}` : "glob";
    }
    case "search": {
      const p = firstStr("pattern");
      const d = firstStr("dir");
      let out = p ? `search ${trunc(p, 60)}` : "search";
      if (d && d !== ".") out += `  in ${short(d)}`;
      return out;
    }
    default: {
      // first meaningful string arg
      for (const [k, v] of Object.entries(args)) {
        if (typeof v === "string" && v.length > 0) return `${name} ${trunc(v, 60)}`;
      }
      return name;
    }
  }
}
