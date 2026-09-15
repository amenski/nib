import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { resolveHome } from "../config/loader.js";

/**
 * A user-defined slash command from `.heirloom/commands/<name>.md`. Typing
 * `/<name> [args]` submits the file body as a user prompt, with `$ARGUMENTS`
 * replaced by the trailing args. This is the same shape Claude Code's custom
 * slash commands use, scoped to Heirloom's own `.heirloom` directory.
 */
export interface CommandDef {
  /** The command name — the file's basename without `.md`. */
  name: string;
  /** Frontmatter `description`, shown in completion/help. May be empty. */
  description: string;
  /** Frontmatter `argument-hint`, the placeholder shown after the name. */
  argumentHint?: string;
  /** The prompt template; `$ARGUMENTS` is substituted with the trailing args. */
  content: string;
  sourcePath: string;
}

const KNOWN_FIELDS = new Set(["description", "argument-hint"]);

function unquote(s: string): string {
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    return s.slice(1, -1);
  }
  return s;
}

/** The tiny YAML subset the modes/skills/agents loaders share — top-level
 *  scalars, quoted strings, `|`/`>` blocks, and `[a, b]`/indented lists. */
function parseYaml(content: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = content.split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    i++;

    if (line.trim() === "" || line.trim().startsWith("#")) continue;

    const topMatch = line.match(/^(\w[\w-]*):\s*(.*)$/);
    if (!topMatch) continue;

    const key = topMatch[1];
    const rest = topMatch[2];

    if (rest === ">" || rest === "|") {
      let value = "";
      while (i < lines.length && /^\s{2,}/.test(lines[i])) {
        value += (value ? " " : "") + lines[i].trim();
        i++;
      }
      result[key] = value;
    } else if (rest === "") {
      const arr: string[] = [];
      while (i < lines.length && /^\s{2}-\s+(.+)$/.test(lines[i])) {
        const matchArr = lines[i].match(/^\s{2}-\s+(.+)$/);
        if (matchArr) arr.push(unquote(matchArr[1].trim()));
        i++;
      }
      if (arr.length > 0) {
        result[key] = arr;
      } else {
        result[key] = "";
      }
    } else if (rest.startsWith("[") && rest.endsWith("]")) {
      result[key] = rest
        .slice(1, -1)
        .split(",")
        .map((s) => unquote(s.trim()))
        .filter(Boolean);
    } else if (rest.startsWith('"') && rest.endsWith('"')) {
      result[key] = rest.slice(1, -1);
    } else if (rest.startsWith("'") && rest.endsWith("'")) {
      result[key] = rest.slice(1, -1);
    } else {
      result[key] = rest;
    }
  }

  return result;
}

function parseFrontmatter(
  raw: string,
): { frontmatter: Record<string, unknown>; content: string } | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("---")) return null;

  const rest = trimmed.slice(3);
  const endIdx = rest.indexOf("\n---");
  if (endIdx === -1) return null;

  const fmBlock = rest.slice(0, endIdx).trim();
  const body = rest.slice(endIdx + 4).trim();
  const frontmatter = parseYaml(fmBlock);

  return { frontmatter, content: body };
}

async function scanDir(dir: string): Promise<CommandDef[]> {
  const commands: CommandDef[] = [];

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return commands;
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;

    const filePath = join(dir, entry.name);
    try {
      const raw = await readFile(filePath, "utf-8");
      const parsed = parseFrontmatter(raw);
      if (!parsed) {
        console.warn(`[commands] Skipping ${filePath}: missing or malformed frontmatter (--- block required)`);
        continue;
      }
      if (parsed.content.trim() === "") {
        console.warn(`[commands] Skipping ${filePath}: empty body`);
        continue;
      }

      const fm = parsed.frontmatter;
      for (const key of Object.keys(fm)) {
        if (!KNOWN_FIELDS.has(key)) {
          console.warn(`[commands] ${filePath}: unknown frontmatter field "${key}" (ignored)`);
        }
      }

      commands.push({
        name: entry.name.slice(0, -".md".length),
        description: (fm.description as string | undefined) ?? "",
        argumentHint: (fm["argument-hint"] as string | undefined) || undefined,
        content: parsed.content,
        sourcePath: filePath,
      });
    } catch (err) {
      console.warn(`[commands] Failed to read ${filePath}: ${(err as Error).message}`);
    }
  }

  return commands;
}

/**
 * Loads custom slash commands from `.heirloom/commands/*.md`, resolved project
 * > global exactly like agents/modes: a project command with a given name
 * shadows the global command of the same name; everything else merges.
 */
export class CommandLoader {
  private byName: Map<string, CommandDef> = new Map();

  async load(projectDir?: string): Promise<CommandDef[]> {
    this.byName.clear();

    const projectCommands = projectDir
      ? await scanDir(join(projectDir, ".heirloom", "commands"))
      : [];
    for (const command of projectCommands) this.byName.set(command.name, command);

    const home = resolveHome();
    for (const command of await scanDir(join(home, "commands"))) {
      if (!this.byName.has(command.name)) this.byName.set(command.name, command);
    }

    return this.list();
  }

  get(name: string): CommandDef | undefined {
    return this.byName.get(name);
  }

  list(): CommandDef[] {
    return [...this.byName.values()];
  }
}

/**
 * Substitute the command's `$ARGUMENTS` placeholder with the trailing args the
 * user typed after `/name`. A missing `$ARGUMENTS` leaves the template
 * unchanged; args passed to a command with no placeholder are ignored. Uses
 * split/join rather than String.replace so a `$` in the args is never
 * interpreted as a replacement-group reference.
 */
export function expandCommand(command: CommandDef, args: string): string {
  return command.content.split("$ARGUMENTS").join(args);
}

/** Resolve a command name (no leading slash) to its definition. */
export function findCommand(commands: CommandDef[], name: string): CommandDef | undefined {
  return commands.find((c) => c.name === name);
}
