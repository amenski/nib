import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { ToolGroup } from "../tools/types.js";
import { resolveHome } from "../config/loader.js";
import { projectDirPath } from "../config/paths.js";

export interface ModeConfig {
  slug: string;
  name: string;
  roleDefinition: string;
  description?: string;
  groups?: ToolGroup[];
  fileRegex?: string;
  customInstructions?: string;
  model?: string;
  reasoningEffort?: string;
  /** Excluded from listAll() (the /modes picker and /modes text listing) but
   *  still reachable by slug via load() — a compatibility alias for a
   *  retired mode name, not a mode users are meant to discover. */
  hidden?: boolean;
}

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
        if (matchArr) arr.push(matchArr[1]);
        i++;
      }
      if (arr.length > 0) {
        result[key] = arr;
      } else {
        result[key] = "";
      }
    } else if (rest.startsWith("[") && rest.endsWith("]")) {
      result[key] = rest.slice(1, -1).split(",").map(s => s.trim()).filter(Boolean);
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

export class ModeLoader {
  private builtinDir: string;
  private cache: Map<string, ModeConfig> = new Map();

  constructor(builtinDir?: string) {
    this.builtinDir = builtinDir ?? new URL("./builtin/", import.meta.url).pathname;
  }

  async load(slug: string, projectDir?: string): Promise<ModeConfig | null> {
    if (this.cache.has(slug)) return this.cache.get(slug)!;

    const paths: string[] = [];
    if (projectDir) {
      paths.push(join(projectDirPath(projectDir), "modes", `${slug}.yaml`));
    }
    const home = resolveHome();
    paths.push(join(home, "modes", `${slug}.yaml`));
    paths.push(join(this.builtinDir, `${slug}.yaml`));

    for (const p of paths) {
      try {
        const raw = await readFile(p, "utf-8");
        const parsed = parseYaml(raw);
        const mode: ModeConfig = {
          slug: (parsed.slug as string) || slug,
          name: (parsed.name as string) || slug,
          roleDefinition: (parsed.roleDefinition as string) || "",
          description: parsed.description as string | undefined,
          groups: parsed.groups as ToolGroup[] | undefined,
          fileRegex: parsed.fileRegex as string | undefined,
          customInstructions: parsed.customInstructions as string | undefined,
          model: parsed.model as string | undefined,
          reasoningEffort: parsed.reasoningEffort as string | undefined,
          hidden: parsed.hidden === "true" || parsed.hidden === true,
        };
        this.cache.set(slug, mode);
        return mode;
      } catch {
        continue;
      }
    }
    return null;
  }

  async listAll(projectDir?: string): Promise<ModeConfig[]> {
    const slugs = new Set<string>();
    const home = resolveHome();

    try {
      for (const entry of await readdir(this.builtinDir)) {
        if (entry.endsWith(".yaml")) slugs.add(entry.replace(".yaml", ""));
      }
    } catch {}

    const modes: ModeConfig[] = [];
    for (const slug of slugs) {
      const mode = await this.load(slug, projectDir);
      if (mode && !mode.hidden) modes.push(mode);
    }
    return modes;
  }
}
