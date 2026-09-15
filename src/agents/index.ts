import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { BUILTIN_PRESETS, getProviderModels } from "../providers/presets.js";
import { resolveHome } from "../config/loader.js";
import { projectDirPath } from "../config/paths.js";

/**
 * A frontmatter agent definition (.heirloom/agents/<name>.md, feature-plans.md
 * §F4, decisions D1–D3). A `new_task` call with `agent: <name>` runs the
 * sub-agent with this def's mode/model/instructions instead of the call's
 * mode and the parent's model. Permission inheritance, depth caps, and audit
 * tagging are unchanged — the def only changes persona/toolset/model.
 */
export interface AgentDef {
  /** Frontmatter `name` — the identity new_task's `agent` parameter resolves. */
  name: string;
  /** Frontmatter `description` — the one-line index entry in the prompt. */
  description: string;
  /** Frontmatter `mode` — the sub-agent's toolset (mode-spec.md). */
  mode: string;
  /** Optional "provider/model" override; absent = inherit the parent's model (D2). */
  model?: string;
  /** Optional instructions prepended to the sub-agent's system prompt. */
  instructions?: string;
  sourcePath: string;
}

const REQUIRED_FIELDS = ["name", "description", "mode"] as const;
const KNOWN_FIELDS = new Set(["name", "description", "mode", "model", "instructions"]);

function unquote(s: string): string {
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    return s.slice(1, -1);
  }
  return s;
}

/** The tiny YAML subset the modes/skills loaders share — top-level scalars,
 *  quoted strings, `|`/`>` blocks, and `[a, b]`/indented lists. */
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
  raw: string
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

/**
 * Whether `modelId` ("provider/model") names a known model in the catalog
 * (bundled presets or config-provided models). Tolerates an unmocked
 * catalog under test mocks via optional chaining — an unknown catalog is
 * treated as "not known", never a crash.
 */
function isKnownModelId(modelId: string): boolean {
  const slash = modelId.indexOf("/");
  if (slash <= 0 || slash === modelId.length - 1) return false;
  const provider = modelId.slice(0, slash);
  const model = modelId.slice(slash + 1);
  const preset = BUILTIN_PRESETS?.[provider];
  if (preset && preset.models[model]) return true;
  return !!getProviderModels?.(provider)?.[model];
}

async function scanDir(dir: string): Promise<AgentDef[]> {
  const defs: AgentDef[] = [];

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return defs;
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;

    const filePath = join(dir, entry.name);
    try {
      const raw = await readFile(filePath, "utf-8");
      const parsed = parseFrontmatter(raw);
      if (!parsed) {
        console.warn(`[agents] Skipping ${filePath}: missing or malformed frontmatter (--- block required)`);
        continue;
      }

      const fm = parsed.frontmatter;

      // Unknown fields never skip the file — warn and continue.
      for (const key of Object.keys(fm)) {
        if (!KNOWN_FIELDS.has(key)) {
          console.warn(`[agents] ${filePath}: unknown frontmatter field "${key}" (ignored)`);
        }
      }

      const name = fm.name as string | undefined;
      const description = fm.description as string | undefined;
      const mode = fm.mode as string | undefined;
      if (!name || !description || !mode) {
        const missing = REQUIRED_FIELDS.filter((f) => !fm[f]);
        console.warn(`[agents] Skipping ${filePath}: missing required field(s): ${missing.join(", ")}`);
        continue;
      }

      const model = fm.model as string | undefined;
      if (model && !isKnownModelId(model)) {
        console.warn(`[agents] ${filePath}: unknown model "${model}" — sub-agent will fall back to the parent's model`);
      }

      defs.push({
        name,
        description,
        mode,
        model: model || undefined,
        instructions: (fm.instructions as string | undefined) || undefined,
        sourcePath: filePath,
      });
    } catch (err) {
      console.warn(`[agents] Failed to read ${filePath}: ${(err as Error).message}`);
    }
  }

  return defs;
}

/**
 * Loads frontmatter agent definitions from `.heirloom/agents/*.md`, resolved
 * project > global exactly like modes (D3): a project def with a given name
 * shadows the global def of the same name; everything else merges.
 */
export class AgentLoader {
  private byName: Map<string, AgentDef> = new Map();

  async load(projectDir?: string): Promise<AgentDef[]> {
    this.byName.clear();

    const projectDefs = projectDir ? await scanDir(join(projectDirPath(projectDir), "agents")) : [];
    for (const def of projectDefs) this.byName.set(def.name, def);

    const home = resolveHome();
    for (const def of await scanDir(join(home, "agents"))) {
      if (!this.byName.has(def.name)) this.byName.set(def.name, def);
    }

    return this.list();
  }

  get(name: string): AgentDef | undefined {
    return this.byName.get(name);
  }

  list(): AgentDef[] {
    return [...this.byName.values()];
  }
}
