import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ToolDef } from "../types.js";
import type { ToolHandler } from "../tools/types.js";
import { checkSkillTrust, trustSkill } from "./trust.js";
import { resolveHome } from "../config/loader.js";
import { projectDirPath } from "../config/paths.js";

export interface SkillDef {
  name: string;
  description: string;
  content: string;
  mode?: string;
  sourcePath: string;
}

function unquote(s: string): string {
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    return s.slice(1, -1);
  }
  return s;
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

async function scanDir(dir: string): Promise<SkillDef[]> {
  const skills: SkillDef[] = [];

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return skills;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const skillPath = join(dir, entry.name, "SKILL.md");
    try {
      const raw = await readFile(skillPath, "utf-8");

      if (raw.trim() === "") {
        console.warn(`[skills] Skipping empty skill file: ${skillPath}`);
        continue;
      }

      const parsed = parseFrontmatter(raw);
      if (!parsed) {
        console.warn(
          `[skills] Invalid SKILL.md (bad frontmatter): ${skillPath}`
        );
        continue;
      }

      const { frontmatter, content } = parsed;

      const name = frontmatter.name as string | undefined;
      if (!name) {
        console.warn(
          `[skills] Invalid SKILL.md (missing name field): ${skillPath}`
        );
        continue;
      }

      const description = (frontmatter.description as string) || "";
      const mode = (frontmatter.mode as string) || undefined;

      skills.push({ name, description, content, mode, sourcePath: skillPath });
    } catch (err) {
      console.warn(
        `[skills] Failed to read ${skillPath}: ${(err as Error).message}`
      );
    }
  }

  return skills;
}

/**
 * A skill is enabled unless the config's `enabledSkills` map explicitly sets it
 * to `false`. Absent (or a missing map) means enabled — the default.
 */
export function isSkillEnabled(
  name: string,
  enabledSkills?: Record<string, boolean>,
): boolean {
  return enabledSkills?.[name] !== false;
}

export class SkillLoader {
  // "[skill] ... trusted" lines, collected instead of console.log'd — load()
  // runs before Ink's render() takes raw-mode control of stdin, so printing
  // here directly would garble whatever the user is typing at startup. The
  // caller shows these in the app's scrollback after mount (see initialNotice
  // in cli.tsx), same as the resumed-session notice.
  notices: string[] = [];

  /**
   * Project skills awaiting the ask-tier TOFU confirmation (security-spec T4).
   * load() defers them instead of asking, because skills load before Ink
   * mounts: the TUI (App.tsx) drives the SkillTrustPrompt modal for each
   * entry at mount and applies the decision via acceptTrust. The skill's
   * index line never enters the system prompt before the user decides.
   */
  pendingTrust: Array<{ skill: SkillDef; status: "new" | "changed" }> = [];

  /** The loaded list — the same array load() returned, so acceptTrust pushes are visible to the caller. */
  private skills: SkillDef[] = [];

  async load(options?: {
    headless?: boolean;
    enabledSkills?: Record<string, boolean>;
  }): Promise<SkillDef[]> {
    const allSkills: SkillDef[] = [];
    const seen = new Set<string>();

    // Project skills first, global user skills second. The trust split (mirror
    // of hooks-spec §6): global dirs are the user's own — trusted implicitly;
    // project-declared skills run content-hashed TOFU.
    const dirs: Array<{ dir: string; global: boolean }> = [
      { dir: join(projectDirPath(process.cwd()), "skills"), global: false },
      { dir: join(process.cwd(), ".agents", "skills"), global: false },
      { dir: join(resolveHome(), "skills"), global: true },
      { dir: join(homedir(), ".agents", "skills"), global: true },
    ];

    for (const { dir, global } of dirs) {
      const skills = await scanDir(dir);
      for (const skill of skills) {
        if (!seen.has(skill.name)) {
          if (!isSkillEnabled(skill.name, options?.enabledSkills)) {
            // Explicitly disabled via config.enabledSkills — never index it.
            seen.add(skill.name);
            continue;
          }

          if (global) {
            seen.add(skill.name);
            allSkills.push(skill);
            continue;
          }

          const trustResult = checkSkillTrust(skill.sourcePath, skill.name);

          if (trustResult.status === "trusted") {
            seen.add(skill.name);
            allSkills.push(skill);
            continue;
          }

          if (options?.headless) {
            process.stderr.write(`[warn] Skipping untrusted skill in headless: ${skill.name} (${trustResult.status})\n`);
            continue;
          }

          // Interactive: hold for the ask-tier confirmation (App.tsx drives
          // the modal after mount). Not marked seen — a later dir with the
          // same name and different content still gets its own classification.
          this.pendingTrust.push({ skill, status: trustResult.status });
        }
      }
    }

    this.skills = allSkills;
    return allSkills;
  }

  /**
   * Apply the user's TOFU decision from the ask modal (y = trust that hash
   * forever, persisted to skill-trust.json; n = skip this session, no
   * persistence). Pushes trusted skills into the shared loaded list so the
   * prompt index and /skills see them from the first turn onward.
   */
  acceptTrust(skill: SkillDef, trusted: boolean): void {
    if (!trusted) return;
    trustSkill(skill.sourcePath, skill.name);
    this.skills.push(skill);
    this.notices.push(`  [skill] ${skill.name} trusted — ${skill.sourcePath}`);
  }
}

export function createLoadSkillTool(skills: SkillDef[]): { def: ToolDef; handler: ToolHandler } {
  const def: ToolDef = {
    name: "load_skill",
    description: "Load the full content of a skill by name. Returns the skill's instructions.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "The name of the skill to load" },
      },
      required: ["name"],
    },
  };

  const handler: ToolHandler = async (args) => {
    const name = args.name as string;
    const skill = skills.find(s => s.name === name);
    if (!skill) {
      const available = skills.map(s => s.name).join(", ");
      return { content: `Unknown skill: ${name}. Available: ${available}`, error: "FILE_NOT_FOUND" };
    }
    return { content: skill.content };
  };

  return { def, handler };
}
