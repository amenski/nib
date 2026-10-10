import type { ToolDef } from "../types.js";
import type { ToolHandler } from "./types.js";
import type { ToolRegistry } from "./registry.js";

export type TodoStatus = "pending" | "in_progress" | "completed";
export interface TodoItem {
  content: string;
  status: TodoStatus;
}

/** Hard caps for the handler (defense against a degenerate model call). */
export const MAX_TODO_ITEMS = 12;
export const MAX_TODO_CONTENT = 120;

/** Valid statuses (spec: pending | in_progress | completed). */
const STATUSES: readonly TodoStatus[] = ["pending", "in_progress", "completed"];

/**
 * Tiny event-emitter store. Module-level singleton shared by the tool handler
 * (writer), the agent loop (reader via getTodos), and the TUI panel (listener).
 * Single-listener onUpdate style, modelled on StatusLineManager.onUpdate
 * (src/ui/statusline/manager.ts).
 */
export class TodoStore {
  private todos: TodoItem[] = [];
  private listener: ((todos: TodoItem[]) => void) | null = null;
  getTodos(): TodoItem[] {
    return this.todos;
  }
  setTodos(todos: TodoItem[]): void {
    this.todos = todos;
    this.listener?.(todos);
  }
  subscribe(listener: (todos: TodoItem[]) => void): () => void {
    this.listener = listener;
    return () => {
      if (this.listener === listener) this.listener = null;
    };
  }
  /** Clears the list and notifies. Called at each turn start by App.tsx. */
  reset(): void {
    this.setTodos([]);
  }
}

export const todoStore = new TodoStore();

/**
 * "Current todo list" block for volatile context / handler output. Injected
 * only when non-empty.
 */
export function formatTodoBlock(todos: TodoItem[]): string {
  if (todos.length === 0) return "";
  const lines = todos.map((t) => `- [${t.status}] ${t.content}`);
  return `# Current todo list\n${lines.join("\n")}`;
}

function normalizeTodos(raw: unknown): { items: TodoItem[]; warnings: string[]; shapeValid: boolean } {
  if (!Array.isArray(raw)) {
    return { items: [], warnings: ["todos must be an array; list unchanged"], shapeValid: false };
  }
  const warnings: string[] = [];
  const items: TodoItem[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const content = typeof (entry as { content?: unknown }).content === "string"
      ? (entry as { content: string }).content.trim() : "";
    if (!content) continue; // drop empty entries silently
    const statusRaw = (entry as { status?: unknown }).status;
    // Forgiving: a typo/invalid status degrades to pending rather than
    // rejecting the call and stalling the ReAct loop.
    const status = STATUSES.includes(statusRaw as TodoStatus)
      ? (statusRaw as TodoStatus)
      : "pending";
    items.push({ content: content.slice(0, MAX_TODO_CONTENT), status });
  }
  if (items.length > MAX_TODO_ITEMS) {
    warnings.push(`truncated to ${MAX_TODO_ITEMS} items`);
  }
  return { items: items.slice(0, MAX_TODO_ITEMS), warnings, shapeValid: true };
}

const todoHandler: ToolHandler = async (args, ctx) => {
  const { items, warnings, shapeValid } = normalizeTodos(args.todos);
  if (!shapeValid) {
    // Malformed call: leave the current plan untouched, surface the warning.
    return { content: warnings.join("\n") };
  }
  // Per-run store when one is wired (sub-agents get their own via the
  // orchestrator's per-call context); fall back to the module singleton.
  const store = ctx.todoStore ?? todoStore;
  store.setTodos(items);

  // Persist the snapshot so a resumed session restores the plan. No-op
  // without a session store (headless), or without this member — a sub-agent's
  // audit-only view exposes just appendPermission/appendToken/getMessageCount,
  // so the store is present while appendTodo is absent, and `?.` on the store
  // alone is not enough (store.ts subagentAuditStore).
  await ctx.sessionStore?.appendTodo?.(ctx.sessionId, items);

  // Spec: exactly one in_progress at a time; warn in output when violated,
  // do not reject (tool-spec.md).
  const inProgress = items.filter((t) => t.status === "in_progress").length;
  if (inProgress > 1) warnings.push(`warning: ${inProgress} items are in_progress — exactly one expected`);

  const out: string[] = [];
  if (items.length === 0) {
    out.push("Todo list cleared (empty).");
  } else {
    out.push(`Todo list updated (${items.length} item${items.length === 1 ? "" : "s"}):`);
    out.push(formatTodoBlock(items));
  }
  if (warnings.length > 0) out.push(...warnings.map((w) => `Note: ${w}`));
  return { content: out.join("\n") };
};

const todoDef: ToolDef = {
  name: "update_todo_list",
  description:
    "Replace the whole task plan with this todo list. Use for multi-step tasks: first create the plan, then keep it current while working — mark the step you are about to do in_progress and flip it to completed when done. " +
    "The list replaces the previous one entirely (no add/remove/reorder). Exactly one item should be in_progress at a time. Pass an empty list to clear the plan.",
  parameters: {
    type: "object",
    properties: {
      todos: {
        type: "array",
        description: "The complete new plan, in execution order. Max 12 items.",
        items: {
          type: "object",
          properties: {
            content: { type: "string", description: "One concrete step." },
            status: { type: "string", enum: ["pending", "in_progress", "completed"] },
          },
          required: ["content", "status"],
        },
      },
    },
    required: ["todos"],
  },
};

// "Always available regardless of mode" (tool-spec.md; mode-spec.md). All five
// groups include "read", so the plan-mode read-only filter (cli.tsx
// registry.getByMode(["read"])) also keeps it — plan mode needs it: the model
// writes the plan into the checklist while planning.
export function registerTodo(registry: ToolRegistry): void {
  registry.register({ def: todoDef, handler: todoHandler, groups: ["read", "edit", "command", "mcp", "workflow"] });
}
