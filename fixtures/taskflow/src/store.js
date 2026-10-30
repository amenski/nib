import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Loads the task list from `data/tasks.json` under the given project root. */
export function loadTasks(root = process.cwd()) {
  return JSON.parse(readFileSync(join(root, "data", "tasks.json"), "utf-8"));
}
