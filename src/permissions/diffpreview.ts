import { readFileSync, existsSync } from "node:fs";
import { ansiBg, ANSI_RESET } from "../ui/theme.js";

/**
 * Columns the diff body is indented by, aligning it with the text of a tool
 * result's own `⎿` preview ("  ⎿  " is five columns before its text).
 */
export const DIFF_INDENT = 5;

/**
 * The theme surface the diff needs. Structural (not ThemeContextValue) so this
 * module stays free of the UI layer's React types.
 */
export interface DiffTheme {
  colorEnabled: boolean;
  theme: { diffAddedBg: number; diffRemovedBg: number };
}

/**
 * Paint a unified diff for the terminal: removed lines carry the theme's
 * `diffRemovedBg`, added lines its `diffAddedBg`, in the terminal's default
 * foreground (Claude Code's diff look). With no theme (or colour off) the diff
 * is plain text — the previous implementation hard-coded SGR 31/32, which
 * ignored the active theme entirely.
 */
function paintDiff(preview: string, theme?: DiffTheme): string {
  const pad = " ".repeat(DIFF_INDENT);
  return preview
    .split("\n")
    .map((line) => {
      const body = pad + line;
      if (!theme?.colorEnabled) return body;
      // "---"/"+++" are the file headers, not removed/added content.
      if (line.startsWith("-") && !line.startsWith("---")) {
        return `${ansiBg(theme.theme.diffRemovedBg)}${body}${ANSI_RESET}`;
      }
      if (line.startsWith("+") && !line.startsWith("+++")) {
        return `${ansiBg(theme.theme.diffAddedBg)}${body}${ANSI_RESET}`;
      }
      return body;
    })
    .join("\n");
}

function computePreviewDiff(toolName: string, args: Record<string, unknown>): string | null {
  const rawPath = args.path ?? args.filePath;
  const path = typeof rawPath === "string" ? rawPath : "";
  if (!path || !existsSync(path)) return null;

  const original = readFileSync(path, "utf-8");
  let preview = "";

  if (toolName === "edit") {
    const oldStr = typeof args.oldString === "string" ? args.oldString : "";
    const newStr = typeof args.newString === "string" ? args.newString : "";
    preview = generateUnifiedDiff(path, original, oldStr, newStr);
  } else if (toolName === "write_to_file" || toolName === "write") {
    const content = typeof args.content === "string" ? args.content : "";
    preview = generateFullDiff(path, original, content);
  } else if (toolName === "search_replace") {
    const search = typeof args.search === "string" ? args.search : "";
    const replace = typeof args.replace === "string" ? args.replace : "";
    preview = generateReplacePreview(path, original, search, replace);
  } else if (toolName === "apply_diff" || toolName === "apply_patch") {
    const rawDiff = args.diff ?? args.patch;
    const diffContent = typeof rawDiff === "string" ? rawDiff : "";
    const lines = diffContent.split("\n");
    preview = lines.slice(0, 10).join("\n");
    if (lines.length > 10) preview += `\n(+${lines.length - 10} more lines)`;
  }

  if (!preview) return null;
  return preview;
}

function generateUnifiedDiff(filePath: string, original: string, oldStr: string, newStr: string): string {
  const startIdx = original.indexOf(oldStr);
  if (startIdx === -1) return `(replacement not found in current file — may have been modified since)`;

  const before = original.slice(0, startIdx);
  const beforeLines = before.split("\n");
  const startLine = beforeLines.length;
  const oldLines = oldStr.split("\n");
  const newLines = newStr.split("\n");

  let diff = `--- ${filePath}\n+++ ${filePath}\n`;
  diff += `@@ -${startLine},${oldLines.length} +${startLine},${newLines.length} @@\n`;

  const contextBefore = beforeLines.slice(-2).filter(l => l !== "" || true);
  for (const line of contextBefore) {
    diff += ` ${line}\n`;
  }

  for (const line of oldLines) {
    diff += `-${line}\n`;
  }
  for (const line of newLines) {
    diff += `+${line}\n`;
  }

  const afterStart = startIdx + oldStr.length;
  const after = original.slice(afterStart);
  const afterLines = after.split("\n").slice(0, 2);
  for (const line of afterLines) {
    if (line !== undefined) diff += ` ${line}\n`;
  }

  return diff;
}

function generateFullDiff(filePath: string, original: string, newContent: string): string {
  const origLines = original.split("\n");
  const newLines = newContent.split("\n");

  let diff = `--- ${filePath}\n+++ ${filePath}\n`;
  diff += `@@ -1,${origLines.length} +1,${newLines.length} @@\n`;

  for (const line of origLines) {
    diff += `-${line}\n`;
  }
  for (const line of newLines) {
    diff += `+${line}\n`;
  }

  return diff;
}

function generateReplacePreview(filePath: string, original: string, search: string, replace: string): string {
  const count = countOccurrences(original, search);
  if (count === 0) return `(replacement not found in current file — may have been modified since)`;

  const firstIdx = original.indexOf(search);
  const before = original.slice(0, firstIdx);
  const beforeLines = before.split("\n");
  const startLine = beforeLines.length;
  const searchLines = search.split("\n");
  const replaceLines = replace.split("\n");

  let diff = `--- ${filePath}\n+++ ${filePath}\n`;
  diff += `@@ -${startLine},${searchLines.length} +${startLine},${replaceLines.length} @@ (${count} occurrence${count > 1 ? "s" : ""})\n`;

  const contextBefore = beforeLines.slice(-2);
  for (const line of contextBefore) {
    diff += ` ${line}\n`;
  }

  for (const line of searchLines) {
    diff += `-${line}\n`;
  }
  for (const line of replaceLines) {
    diff += `+${line}\n`;
  }

  const afterStart = firstIdx + search.length;
  const after = original.slice(afterStart);
  const afterLines = after.split("\n").slice(0, 2);
  for (const line of afterLines) {
    if (line !== undefined) diff += ` ${line}\n`;
  }

  return diff;
}

function countOccurrences(str: string, search: string): number {
  let count = 0;
  let pos = 0;
  while ((pos = str.indexOf(search, pos)) !== -1) {
    count++;
    pos += search.length;
  }
  return count;
}

function formatPreview(preview: string, maxLines: number = 40): string {
  const lines = preview.split("\n");
  if (lines.length <= maxLines) return preview;
  return lines.slice(0, maxLines).join("\n") + `\n(+${lines.length - maxLines} more)`;
}

/**
 * A unified diff for the permission prompt. The body is indented to align with
 * a tool result's own `⎿` preview and, given a theme, painted with the diff
 * background slots.
 */
export function previewEdit(
  toolName: string,
  args: Record<string, unknown>,
  theme?: DiffTheme,
): string | null {
  const raw = computePreviewDiff(toolName, args);
  if (!raw) return null;
  return paintDiff(formatPreview(raw), theme);
}
