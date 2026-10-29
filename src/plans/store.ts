import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { projectDirPath } from "../config/paths.js";
import { slugify } from "../sessions/store.js";

/**
 * The persisted plan artifact (docs/todo.md D6): the plan the model proposes
 * in plan posture is written to .nib/plans/<slug>.md and re-injected into the
 * volatile tail every request — the same mechanism as the todo block — so it
 * survives compaction. The agent amends it by editing the file; the next
 * request picks the amended copy up.
 */

export function plansDir(projectRoot: string): string {
  return join(projectDirPath(projectRoot), "plans");
}

export function formatPlanBlock(plan: string): string {
  const text = plan.trim();
  if (!text) return "";
  return `# Active plan\n${text}`;
}

/** Overwrites `<slug>.md` and returns its path. */
export function savePlan(projectRoot: string, plan: string, slug?: string): string {
  const text = plan.trim();
  if (!text) throw new Error("savePlan: empty plan");
  const title = text.match(/^#{1,3}\s+(.+)$/m)?.[1] ?? text.split("\n")[0] ?? "";
  const name = slugify((slug ?? title).toLowerCase()).slice(0, 60) || `plan-${Date.now()}`;
  const dir = plansDir(projectRoot);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = join(dir, `${name}.md`);
  writeFileSync(path, `${text}\n`);
  return path;
}

/** The most recently written plan for the project, or null when there is none. */
export function loadPlan(projectRoot: string): string | undefined {
  const dir = plansDir(projectRoot);
  if (!existsSync(dir)) return undefined;
  const files = readdirSync(dir).filter((f) => f.endsWith(".md"));
  if (files.length === 0) return undefined;
  const newest = files
    .map((f) => ({ f, mtime: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)[0];
  const text = readFileSync(join(dir, newest.f), "utf-8").trim();
  return text || undefined;
}
