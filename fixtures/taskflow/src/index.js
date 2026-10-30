import { loadTasks } from "./store.js";
import { byStatus } from "./filter.js";

const args = process.argv.slice(2);

function flagValue(name) {
  const idx = args.indexOf(name);
  return idx === -1 ? undefined : args[idx + 1];
}

/**
 * Prints the open tasks.
 *
 * Usage: node src/index.js [--status <status>]
 *   --status   only list tasks with this status (default: open)
 */
const status = flagValue("--status") ?? "open";

for (const task of byStatus(loadTasks(), status)) {
  console.log(task.title);
}
