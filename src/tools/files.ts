import { readFile, readdir, stat } from "node:fs/promises";
import { resolve, relative, join } from "node:path";
import type { ToolOutput, ToolDef } from "../types.js";
import type { ToolHandler, ToolContext } from "./types.js";
import { ToolRegistry } from "./registry.js";
import { sniffImageMime } from "./image-format.js";
import { wrapUntrusted, sanitizeControlChars } from "./untrusted-content.js";

const MAX_READ_LINES = 2000;

function positiveInt(v: unknown): number | undefined {
  return typeof v === "number" && Number.isInteger(v) && v >= 1 ? v : undefined;
}

const readFileHandler: ToolHandler = async (args, ctx) => {
  const path = args.path as string;
  try {
    const buffer = await readFile(path);
    const s = await stat(path);
    if (ctx.fileMtimes) ctx.fileMtimes.set(path, s.mtimeMs);
    // Binary guard: a NUL byte means this is not UTF-8 text. Without it,
    // decoding a PNG produced ~44k replacement characters and hundreds of
    // numbered garbage rows in the model's context, and the model reported it
    // could not parse the file. Name the format when we recognize it so the
    // model has a real next step instead of a dead end.
    if (buffer.includes(0)) {
      const imageMime = sniffImageMime(buffer);
      const kind = imageMime ? `${imageMime} image` : "binary";
      const hint = imageMime
        ? " Use view_image with its URL for a remote image; for a local one, ask the user to reference it with @path."
        : "";
      return { content: `Error reading file: ${path} is a ${kind} file, not text.${hint}` };
    }
    const content = buffer.toString("utf8");
    // offset/limit (1-based first line, line count, max 2000): read a range
    // instead of the whole file. Without it the model read slices through
    // `sed -n` in run_bash (354 such reads vs 105 read_file in one session).
    const all = sanitizeControlChars(content).split("\n");
    const offset = positiveInt(args.offset) ?? 1;
    const limit = Math.min(positiveInt(args.limit) ?? MAX_READ_LINES, MAX_READ_LINES);
    if (offset > all.length) {
      return { content: `Error reading file: ${path} has ${all.length} lines; offset ${offset} is past the end.` };
    }
    const lines = all.slice(offset - 1, offset - 1 + limit);
    let result = lines.map((l, i) => `${offset + i}: ${l}`).join("\n");
    const last = offset + lines.length - 1;
    if (offset > 1 || last < all.length) {
      result += `\n(lines ${offset}–${last} of ${all.length}. Use offset/limit to read more.)`;
    }
    // Markers around the whole numbered block — the truncation footer is part
    // of the payload (same convention as web_fetch's). Error text below stays
    // unwrapped: it is the tool's own voice. Terminal-control escapes (T14)
    // are stripped before line-numbering so file content (OSC 52, CSI cursor
    // moves, etc.) can never reach the terminal raw.
    return { content: wrapUntrusted(result) };
  } catch (err: unknown) {
    return { content: `Error reading file: ${(err as Error).message}` };
  }
};

const readFileDef: ToolDef = {
  name: "read_file",
  description:
    "Read a file from the filesystem. Returns content with line numbers. For a large file, or when you only need part of one, pass offset and limit to read just that range. Prefer this over cat/sed/head in run_bash.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute file path" },
      offset: { type: "integer", description: "First line to read, 1-based (default 1)" },
      limit: { type: "integer", description: "Number of lines to read (default and maximum 2000)" },
    },
    required: ["path"],
  },
};

const listFilesHandler: ToolHandler = async (args) => {
  const path = (args.path as string) || ".";
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return { content: entries.map((e) => `${e.isDirectory() ? "dir" : "file"}  ${e.name}`).join("\n") };
  } catch (err: unknown) {
    return { content: `Error listing directory: ${(err as Error).message}` };
  }
};

const listFilesDef: ToolDef = {
  name: "list_files",
  description: "List files and directories in a given path.",
  parameters: {
    type: "object",
    properties: { path: { type: "string", description: "Directory path (defaults to cwd)" } },
    required: [],
  },
};

const globHandler: ToolHandler = async (args, ctx) => {
  const pattern = args.pattern as string;
  const cwd = (args.cwd as string) || ctx.workingDir;

  const regex = globToRegex(pattern);

  const results: string[] = [];
  const MAX = 500;

  try {
    await walkDir(cwd, cwd, regex, results, MAX);
  } catch (err: unknown) {
    return { content: `Error during glob: ${(err as Error).message}` };
  }

  if (results.length === 0) {
    return { content: "No files matched." };
  }
  return { content: results.join("\n") };
};

const globDef: ToolDef = {
  name: "glob",
  description: "Find files matching a glob pattern. Returns matching file paths, one per line. Max 500 results.",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Glob pattern to match (e.g. '**/*.js' or '*.ts')" },
      cwd: { type: "string", description: "Working directory for the search (optional)" },
    },
    required: ["pattern"],
  },
};

function globToRegex(glob: string): RegExp {
  let re = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "<<GLOBSTAR>>")
    .replace(/\*/g, "[^/]*")
    .replace(/<<GLOBSTAR>>/g, ".*")
    .replace(/\?/g, "[^/]");
  return new RegExp(`^${re}$`);
}

async function walkDir(
  base: string,
  dir: string,
  regex: RegExp,
  results: string[],
  max: number,
): Promise<void> {
  if (results.length >= max) return;

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (results.length >= max) return;
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;

    const full = join(dir, entry.name);
    const rel = relative(base, full);

    if (entry.isDirectory()) {
      if (entry.name === ".git") continue;
      await walkDir(base, full, regex, results, max);
    } else if (entry.isFile()) {
      if (regex.test(rel)) {
        results.push(rel);
      }
    }
  }
}

export function registerFiles(registry: ToolRegistry): void {
  registry.register({ def: readFileDef, handler: readFileHandler, groups: ["read"] });
  registry.register({ def: listFilesDef, handler: listFilesHandler, groups: ["read"] });
  registry.register({ def: globDef, handler: globHandler, groups: ["read"] });
}
