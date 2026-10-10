import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolRegistry } from "./registry.js";
import { SessionStore, subagentAuditStore } from "../sessions/store.js";
import type { ToolContext } from "./types.js";
import {
  todoStore,
  TodoStore,
  formatTodoBlock,
  registerTodo,
  MAX_TODO_ITEMS,
  MAX_TODO_CONTENT,
  type TodoItem,
} from "./todo.js";

function makeCtx(): ToolContext {
  return {
    workingDir: "/tmp",
    sessionId: "test",
    signal: new AbortController().signal,
  };
}

function makeRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registerTodo(registry);
  return registry;
}

function execUpdate(registry: ToolRegistry, todos: unknown): Promise<{ content: string; error?: string }> {
  return registry.execute(
    { id: "t1", name: "update_todo_list", arguments: { todos } },
    makeCtx(),
  );
}

function todo(content: string, status: TodoItem["status"]): TodoItem {
  return { content, status };
}

beforeEach(() => todoStore.reset());

describe("update_todo_list handler", () => {
  it("replaces the whole list and returns it in the output", async () => {
    const registry = makeRegistry();
    const out = await execUpdate(registry, [
      todo("Add F feedrate capture", "pending"),
      todo("Per-segment time math", "in_progress"),
      todo("UI row in the pro gate", "completed"),
    ]);
    expect(todoStore.getTodos()).toEqual([
      todo("Add F feedrate capture", "pending"),
      todo("Per-segment time math", "in_progress"),
      todo("UI row in the pro gate", "completed"),
    ]);
    expect(out.error).toBeUndefined();
    expect(out.content).toContain("Todo list updated (3 items)");
    expect(out.content).toContain("- [pending] Add F feedrate capture");
    expect(out.content).toContain("- [in_progress] Per-segment time math");
    expect(out.content).toContain("- [completed] UI row in the pro gate");
  });

  it("replaces a previous list entirely (no merge)", async () => {
    const registry = makeRegistry();
    await execUpdate(registry, [todo("First plan", "pending")]);
    await execUpdate(registry, [todo("Second plan", "in_progress"), todo("Third", "pending")]);
    expect(todoStore.getTodos()).toEqual([todo("Second plan", "in_progress"), todo("Third", "pending")]);
  });

  it("coerces invalid or missing status to pending", async () => {
    const registry = makeRegistry();
    const out = await execUpdate(registry, [
      { content: "bad status", status: "urgent" },
      { content: "no status" },
      todo("valid", "completed"),
    ]);
    expect(todoStore.getTodos()).toEqual([
      todo("bad status", "pending"),
      todo("no status", "pending"),
      todo("valid", "completed"),
    ]);
    expect(out.error).toBeUndefined();
  });

  it("drops entries with empty content", async () => {
    const registry = makeRegistry();
    await execUpdate(registry, [
      { content: "   ", status: "pending" },
      todo("kept", "pending"),
      { content: "", status: "in_progress" },
    ]);
    expect(todoStore.getTodos()).toEqual([todo("kept", "pending")]);
  });

  it("applies multiple in_progress but warns in the output (spec: warn, don't reject)", async () => {
    const registry = makeRegistry();
    const out = await execUpdate(registry, [
      todo("a", "in_progress"),
      todo("b", "in_progress"),
    ]);
    expect(todoStore.getTodos()).toEqual([todo("a", "in_progress"), todo("b", "in_progress")]);
    expect(out.content).toContain("warning: 2 items are in_progress");
  });

  it("clears the plan with an empty list", async () => {
    const registry = makeRegistry();
    await execUpdate(registry, [todo("a", "pending")]);
    const out = await execUpdate(registry, []);
    expect(todoStore.getTodos()).toEqual([]);
    expect(out.content).toContain("cleared");
  });

  it("truncates to MAX_TODO_ITEMS with a note", async () => {
    const registry = makeRegistry();
    const many = Array.from({ length: MAX_TODO_ITEMS + 3 }, (_, i) => todo(`step ${i}`, "pending"));
    const out = await execUpdate(registry, many);
    expect(todoStore.getTodos()).toHaveLength(MAX_TODO_ITEMS);
    expect(todoStore.getTodos()[0].content).toBe("step 0");
    expect(out.content).toContain(`Note: truncated to ${MAX_TODO_ITEMS} items`);
  });

  it("slices overlong content to MAX_TODO_CONTENT", async () => {
    const registry = makeRegistry();
    const long = "x".repeat(MAX_TODO_CONTENT + 50);
    await execUpdate(registry, [todo(long, "pending")]);
    expect(todoStore.getTodos()[0].content).toHaveLength(MAX_TODO_CONTENT);
  });

  it("warns and leaves the list unchanged when todos is not an array", async () => {
    const registry = makeRegistry();
    await execUpdate(registry, [todo("kept", "pending")]);
    const out = await execUpdate(registry, "not-an-array");
    expect(out.content).toContain("todos must be an array; list unchanged");
    expect(todoStore.getTodos()).toEqual([todo("kept", "pending")]);
  });

  it("ignores non-object entries in the array", async () => {
    const registry = makeRegistry();
    await execUpdate(registry, ["string", 42, null, todo("kept", "pending")]);
    expect(todoStore.getTodos()).toEqual([todo("kept", "pending")]);
  });

  it("writes to ctx.todoStore when provided (per-run isolation)", async () => {
    const registry = makeRegistry();
    const isolated = new TodoStore();
    const out = await registry.execute(
      { id: "t1", name: "update_todo_list", arguments: { todos: [todo("sub step", "in_progress")] } },
      { ...makeCtx(), todoStore: isolated },
    );
    expect(out.error).toBeUndefined();
    expect(isolated.getTodos()).toEqual([todo("sub step", "in_progress")]);
    // The module singleton (the parent panel's store) was never touched.
    expect(todoStore.getTodos()).toEqual([]);
  });

  it("persists the snapshot via ctx.sessionStore when provided", async () => {
    const registry = makeRegistry();
    const appendTodo = vi.fn(async () => {});
    const out = await registry.execute(
      { id: "t1", name: "update_todo_list", arguments: { todos: [todo("step", "in_progress")] } },
      { ...makeCtx(), sessionStore: { appendTodo } as never },
    );
    expect(out.error).toBeUndefined();
    expect(appendTodo).toHaveBeenCalledWith("test", [todo("step", "in_progress")]);
  });

  it("no-ops without ctx.sessionStore (headless)", async () => {
    const registry = makeRegistry();
    const out = await execUpdate(registry, [todo("step", "pending")]);
    expect(out.error).toBeUndefined();
  });

  it("succeeds with a sub-agent's audit-only store, writing no snapshot (2026-10-10)", async () => {
    // A sub-agent's store is a Proxy exposing permission/token writes only, so
    // `appendTodo` is *present as undefined* on a store that exists — `?.` on
    // the store alone left the call throwing `appendTodo is not a function`,
    // which is what the onramp log showed a planning sub-agent hitting.
    const registry = makeRegistry();
    const home = mkdtempSync(join(tmpdir(), "nib-todo-audit-"));
    try {
      const parent = new SessionStore(home);
      const out = await registry.execute(
        { id: "t1", name: "update_todo_list", arguments: { todos: [todo("sub step", "in_progress")] } },
        { ...makeCtx(), sessionStore: subagentAuditStore(parent) },
      );

      expect(out.error).toBeUndefined();
      expect(out.content).toContain("Todo list updated (1 item)");
      // The handler still did its job — the plan reaches the sub-agent's own
      // panel — while nothing is written into the parent session.
      expect(todoStore.getTodos()).toEqual([todo("sub step", "in_progress")]);
      expect(await parent.queryTodos("test")).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("todoStore", () => {
  it("notifies subscribers on setTodos and reset", () => {
    const listener = vi.fn();
    todoStore.subscribe(listener);
    todoStore.setTodos([todo("a", "pending")]);
    expect(listener).toHaveBeenCalledWith([todo("a", "pending")]);
    todoStore.reset();
    expect(listener).toHaveBeenLastCalledWith([]);
  });

  it("unsubscribe stops delivery", () => {
    const listener = vi.fn();
    const unsub = todoStore.subscribe(listener);
    unsub();
    todoStore.setTodos([todo("a", "pending")]);
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("formatTodoBlock", () => {
  it("renders - [status] lines", () => {
    expect(formatTodoBlock([todo("a", "in_progress"), todo("b", "completed")])).toBe(
      "# Current todo list\n- [in_progress] a\n- [completed] b",
    );
  });

  it("returns empty string for an empty list", () => {
    expect(formatTodoBlock([])).toBe("");
  });
});

describe("registration", () => {
  it("is available in every mode group (always available)", () => {
    const registry = makeRegistry();
    for (const group of ["read", "edit", "command", "mcp", "workflow"] as const) {
      const defs = registry.getByMode([group]);
      expect(defs.some((d) => d.name === "update_todo_list")).toBe(true);
    }
  });

  it("ships the spec'd schema (todos: [{content, status}])", () => {
    const registry = makeRegistry();
    const def = registry.getByMode(["read"]).find((d) => d.name === "update_todo_list")!;
    expect(def.parameters.required).toContain("todos");
    const itemSchema = (def.parameters.properties.todos as { items: { properties: Record<string, unknown> } }).items;
    expect((itemSchema.properties.status as { enum?: string[] }).enum).toEqual([
      "pending", "in_progress", "completed",
    ]);
  });
});
