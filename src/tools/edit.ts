import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { dirname } from "node:path";
import type { ToolOutput, ToolDef } from "../types.js";
import type { ToolHandler, ToolContext } from "./types.js";
import { ToolRegistry } from "./registry.js";
import { extractApplyPatchPlan, resolveWorkspaceWriteTarget } from "../permissions/capabilities.js";

function countOccurrences(str: string, search: string): number {
  let count = 0;
  let pos = 0;
  while ((pos = str.indexOf(search, pos)) !== -1) {
    count++;
    pos += search.length;
  }
  return count;
}

function replaceAllLiterals(str: string, search: string, replacement: string): string {
  if (search === "") return str;
  const parts = str.split(search);
  return parts.join(replacement);
}

// Write the file, then refresh the recorded mtime from the post-write stat.
// Without this, a tool's own successful write bumps the on-disk mtime while the
// recorded mtime still reflects the last *read*, so the NEXT edit to the same
// file misreads that self-inflicted bump as an external change and falsely
// returns FILE_MODIFIED. Every write path must go through here.
async function writeAndTrack(path: string, content: string, ctx: ToolContext): Promise<void> {
  await writeFile(path, content, "utf-8");
  if (ctx.fileMtimes) {
    try {
      const s = await stat(path);
      ctx.fileMtimes.set(path, s.mtimeMs);
    } catch {
      // stat failed post-write (unlikely) — drop the stale entry so the next
      // edit re-reads rather than comparing against an outdated mtime.
      ctx.fileMtimes.delete(path);
    }
  }
}

async function checkStaleFile(path: string, ctx: ToolContext): Promise<ToolOutput | null> {
  if (!ctx.fileMtimes?.has(path)) return null;
  const recordedMtime = ctx.fileMtimes.get(path)!;
  let currentMtime: number;
  try {
    const s = await stat(path);
    currentMtime = s.mtimeMs;
  } catch {
    return null;
  }
  if (currentMtime > recordedMtime + 1000) {
    return { content: "FILE_MODIFIED: file was changed externally since last read. Re-read before editing.", error: "FILE_MODIFIED" };
  }
  return null;
}

const editHandler: ToolHandler = async (args, ctx) => {
  const target = resolveWorkspaceWriteTarget(args.path as string, ctx.workingDir);
  if ("error" in target) return { content: target.error, error: target.error };
  const path = target.path;
  const oldString = args.oldString as string;
  const newString = args.newString as string;

  if (oldString === "") {
    return { content: "oldString must not be empty", error: "oldString must not be empty" };
  }

  let content: string;
  try {
    content = await readFile(path, "utf-8");
  } catch (err: unknown) {
    const msg = `Error reading file: ${(err as Error).message}`;
    return { content: msg, error: msg };
  }

  const occurrences = countOccurrences(content, oldString);

  if (occurrences === 0) {
    const msg = `String not found in ${path}`;
    return { content: msg, error: msg };
  }

  if (occurrences > 1) {
    const msg = `Found ${occurrences} occurrences, expected 1. Use search_replace for bulk changes.`;
    return { content: msg, error: msg };
  }

  const idx = content.indexOf(oldString);
  const newContent = content.slice(0, idx) + newString + content.slice(idx + oldString.length);

  try {
    const stale = await checkStaleFile(path, ctx);
    if (stale) return stale;
    await ctx.checkpoint?.save();
    await writeAndTrack(path, newContent, ctx);
    return { content: `Replaced 1 occurrence in ${path}` };
  } catch (err: unknown) {
    const msg = `Error writing file: ${(err as Error).message}`;
    return { content: msg, error: msg };
  }
};

const editDef: ToolDef = {
  name: "edit",
  description: "Perform exact string replacement in a file. Fails if oldString is not found or appears multiple times.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute file path" },
      oldString: { type: "string", description: "The exact text to replace" },
      newString: { type: "string", description: "The text to replace it with" },
    },
    required: ["path", "oldString", "newString"],
  },
};

const applyDiffHandler: ToolHandler = async (args, ctx) => {
  const target = resolveWorkspaceWriteTarget(args.path as string, ctx.workingDir);
  if ("error" in target) return { content: target.error, error: target.error };
  const path = target.path;
  const diff = (args.diff as string).trim();

  if (!diff) {
    return { content: "Empty diff, nothing to apply." };
  }

  let content: string;
  try {
    content = await readFile(path, "utf-8");
  } catch (err: unknown) {
    const msg = `Error reading file: ${(err as Error).message}`;
    return { content: msg, error: msg };
  }

  const newContent = applyDiffToContent(content, diff, path);
  if (newContent instanceof Error) {
    return { content: newContent.message, error: newContent.message };
  }

  try {
    const stale = await checkStaleFile(path, ctx);
    if (stale) return stale;
    await ctx.checkpoint?.save();
    await writeAndTrack(path, newContent, ctx);
    return { content: `Diff applied successfully to ${path}` };
  } catch (err: unknown) {
    const msg = `Error writing file: ${(err as Error).message}`;
    return { content: msg, error: msg };
  }
};

interface HunkLine {
  type: "context" | "remove" | "add";
  content: string;
}

interface Hunk {
  lines: HunkLine[];
}

function parseDiffHunks(diffText: string): Hunk[] {
  const lines = diffText.split("\n");
  const hunks: Hunk[] = [];
  let current: Hunk | null = null;

  for (const line of lines) {
    if (/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/.test(line)) {
      if (current) hunks.push(current);
      current = { lines: [] };
    } else if (current) {
      if (line.startsWith(" ")) {
        current.lines.push({ type: "context", content: line.slice(1) });
      } else if (line.startsWith("-")) {
        current.lines.push({ type: "remove", content: line.slice(1) });
      } else if (line.startsWith("+")) {
        current.lines.push({ type: "add", content: line.slice(1) });
      }
    }
  }
  if (current) hunks.push(current);
  return hunks;
}

function applyDiffToContent(content: string, diff: string, path: string): string | Error {
  const hunks = parseDiffHunks(diff);
  if (hunks.length === 0) {
    return new Error(`No hunks found in diff for ${path}`);
  }

  for (const hunk of hunks) {
    const oldLines: string[] = [];
    const newLines: string[] = [];

    for (const line of hunk.lines) {
      if (line.type === "context") {
        oldLines.push(line.content);
        newLines.push(line.content);
      } else if (line.type === "remove") {
        oldLines.push(line.content);
      } else if (line.type === "add") {
        newLines.push(line.content);
      }
    }

    const oldText = oldLines.join("\n");
    const newText = newLines.join("\n");

    const idx = content.indexOf(oldText);
    if (idx === -1) {
      const ctx = oldLines.slice(0, Math.min(3, oldLines.length)).join("\n").slice(0, 200);
      return new Error(`Diff does not match ${path}. Context not found:\n${ctx}`);
    }

    content = content.slice(0, idx) + newText + content.slice(idx + oldText.length);
  }

  return content;
}

const applyDiffDef: ToolDef = {
  name: "apply_diff",
  description: "Apply a unified diff patch to a file. Finds the first occurrence of the hunk context and applies changes.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute file path to patch" },
      diff: { type: "string", description: "Unified diff content" },
    },
    required: ["path", "diff"],
  },
};

const applyPatchHandler: ToolHandler = async (args, ctx) => {
  const patch = args.patch as string;

  if (!patch.trim()) {
    return { content: "Empty patch, nothing to apply." };
  }

  const plan = extractApplyPatchPlan(args, ctx.workingDir);
  if (plan.status !== "known" || plan.tool !== "apply_patch" || !("targets" in plan)) {
    const message = plan.reason ?? "Patch targets could not be parsed";
    return { content: message, error: message };
  }

  const targetByRawPath = new Map(plan.targets.map((target) => [target.rawPath, target.path]));
  const rawSections = splitMultiFileDiff(patch);
  const sections = new Map<string, string>();
  for (const [rawPath, diffText] of rawSections) {
    const filePath = targetByRawPath.get(rawPath);
    if (!filePath) {
      const message = `Patch target was not authorized: ${rawPath}`;
      return { content: message, error: message };
    }
    sections.set(filePath, diffText);
  }
  const results: string[] = [];

  await ctx.checkpoint?.save();

  for (const [filePath, diffText] of sections) {
    const stale = await checkStaleFile(filePath, ctx);
    if (stale) {
      results.push(`${filePath}: FILE_MODIFIED - file was changed externally since last read`);
      continue;
    }

    let content: string;
    try {
      content = await readFile(filePath, "utf-8");
    } catch (err: unknown) {
      results.push(`${filePath}: error - ${(err as Error).message}`);
      continue;
    }

    const newContent = applyDiffToContent(content, diffText, filePath);
    if (newContent instanceof Error) {
      results.push(`${filePath}: error - ${newContent.message}`);
      continue;
    }

    try {
      await writeAndTrack(filePath, newContent, ctx);
      results.push(`${filePath}: ok`);
    } catch (err: unknown) {
      results.push(`${filePath}: error writing - ${(err as Error).message}`);
    }
  }

  return { content: results.join("\n") || "No files found in patch." };
};

function splitMultiFileDiff(patch: string): Map<string, string> {
  const result = new Map<string, string>();
  const sections = patch.split(/(?=^diff --git |^--- a\/)/m);

  for (const section of sections) {
    if (!section.trim()) continue;
    const pathMatch = section.match(/^\+\+\+ b\/(.+)$/m);
    if (!pathMatch) continue;
    const filePath = pathMatch[1].trim();
    const diffContent = section.replace(/^diff --git .*$/m, "").replace(/^--- .*$/m, "").replace(/^\+\+\+ .*$/m, "").trim();
    if (diffContent) {
      result.set(filePath, diffContent);
    }
  }

  return result;
}

const applyPatchDef: ToolDef = {
  name: "apply_patch",
  description: "Apply a multi-file unified diff patch. Parses ---/+++ headers, applies each file's diff.",
  parameters: {
    type: "object",
    properties: {
      patch: { type: "string", description: "Multi-file unified diff patch" },
    },
    required: ["patch"],
  },
};

const searchReplaceHandler: ToolHandler = async (args, ctx) => {
  const target = resolveWorkspaceWriteTarget(args.path as string, ctx.workingDir);
  if ("error" in target) return { content: target.error, error: target.error };
  const path = target.path;
  const search = args.search as string;
  const replace = (args.replace as string) ?? "";

  if (search === "") {
    return { content: "search string must not be empty", error: "search string must not be empty" };
  }

  let content: string;
  try {
    content = await readFile(path, "utf-8");
  } catch (err: unknown) {
    const msg = `Error reading file: ${(err as Error).message}`;
    return { content: msg, error: msg };
  }

  const count = countOccurrences(content, search);

  if (count === 0) {
    const msg = `String not found in ${path}`;
    return { content: msg, error: msg };
  }

  const newContent = replaceAllLiterals(content, search, replace);

  try {
    const stale = await checkStaleFile(path, ctx);
    if (stale) return stale;
    await ctx.checkpoint?.save();
    await writeAndTrack(path, newContent, ctx);
    return { content: `${count} occurrences replaced in ${path}` };
  } catch (err: unknown) {
    const msg = `Error writing file: ${(err as Error).message}`;
    return { content: msg, error: msg };
  }
};

const searchReplaceDef: ToolDef = {
  name: "search_replace",
  description: "Replace ALL occurrences of a search string with a replacement in a file.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute file path" },
      search: { type: "string", description: "String to search for (literal, not regex)" },
      replace: { type: "string", description: "Replacement string" },
    },
    required: ["path", "search", "replace"],
  },
};

const editFileHandler: ToolHandler = async (args, ctx) => {
  const target = resolveWorkspaceWriteTarget(args.path as string, ctx.workingDir);
  if ("error" in target) return { content: target.error, error: target.error };
  const path = target.path;
  const search = args.search as string;
  const replace = (args.replace as string) ?? "";
  const expectedCount = args.expectedCount as number;

  if (search === "") {
    return { content: "search string must not be empty", error: "search string must not be empty" };
  }

  let content: string;
  try {
    content = await readFile(path, "utf-8");
  } catch (err: unknown) {
    const msg = `Error reading file: ${(err as Error).message}`;
    return { content: msg, error: msg };
  }

  const count = countOccurrences(content, search);

  if (count !== expectedCount) {
    const msg = `Expected ${expectedCount} occurrences, found ${count}. No changes made.`;
    return { content: msg, error: msg };
  }

  if (count === 0) {
    const msg = `String not found in ${path}`;
    return { content: msg, error: msg };
  }

  const newContent = replaceAllLiterals(content, search, replace);

  try {
    const stale = await checkStaleFile(path, ctx);
    if (stale) return stale;
    await ctx.checkpoint?.save();
    await writeAndTrack(path, newContent, ctx);
    return { content: `${count} occurrences replaced in ${path}` };
  } catch (err: unknown) {
    const msg = `Error writing file: ${(err as Error).message}`;
    return { content: msg, error: msg };
  }
};

const editFileDef: ToolDef = {
  name: "edit_file",
  description: "Replace all occurrences of search with replace, verifying the expected count matches. No changes if count differs.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute file path" },
      search: { type: "string", description: "String to search for (literal, not regex)" },
      replace: { type: "string", description: "Replacement string" },
      expectedCount: { type: "number", description: "Expected number of occurrences" },
    },
    required: ["path", "search", "replace", "expectedCount"],
  },
};

const writeToFileHandler: ToolHandler = async (args, ctx) => {
  const target = resolveWorkspaceWriteTarget(args.path as string, ctx.workingDir);
  if ("error" in target) return { content: target.error, error: target.error };
  const path = target.path;
  const content = args.content as string;

  try {
    const stale = await checkStaleFile(path, ctx);
    if (stale) return stale;
    await ctx.checkpoint?.save();
    await mkdir(dirname(path), { recursive: true });
    await writeAndTrack(path, content, ctx);
    return { content: `Wrote ${content.split("\n").length} lines to ${path}` };
  } catch (err: unknown) {
    const msg = `Error writing file: ${(err as Error).message}`;
    return { content: msg, error: msg };
  }
};

const writeToFileDef: ToolDef = {
  name: "write_to_file",
  description: "Write content to a file. Creates parent directories if needed. Overwrites if the file exists.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute file path" },
      content: { type: "string", description: "Content to write" },
    },
    required: ["path", "content"],
  },
};

export { editHandler, applyDiffHandler, applyPatchHandler, searchReplaceHandler, editFileHandler, writeToFileHandler };

export function registerEdits(registry: ToolRegistry): void {
  registry.register({ def: editDef, handler: editHandler, groups: ["edit"] });
  registry.register({ def: applyDiffDef, handler: applyDiffHandler, groups: ["edit"] });
  registry.register({ def: applyPatchDef, handler: applyPatchHandler, groups: ["edit"] });
  registry.register({ def: searchReplaceDef, handler: searchReplaceHandler, groups: ["edit"] });
  registry.register({ def: editFileDef, handler: editFileHandler, groups: ["edit"] });
  registry.register({ def: writeToFileDef, handler: writeToFileHandler, groups: ["edit"] });
}
