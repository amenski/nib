import { describe, it, expect, vi } from "vitest";
import { TaskRegistry, formatResultMessage, isSubagentResultMessage, type TaskOutcome } from "./runner.js";

/** A run that never settles — the task stays "running" until aborted. */
const pendingRun = () => () => new Promise<TaskOutcome>(() => {});

const taskIdOf = (spawned: { taskId: string } | { error: string }): string =>
  "taskId" in spawned ? spawned.taskId : "";

describe("TaskRegistry.abortTask (async-subagents.md §3, Q4 — the /tasks stop action)", () => {
  it("marks one running task aborted and leaves siblings running", () => {
    const r = new TaskRegistry();
    const a = r.spawn({ description: "a", depth: 0, run: pendingRun(), deliver: () => {} });
    const b = r.spawn({ description: "b", depth: 0, run: pendingRun(), deliver: () => {} });
    const idA = taskIdOf(a);
    const idB = taskIdOf(b);
    expect(idA).not.toBe("");

    r.abortTask(idA);

    expect(r.get(idA)?.status).toBe("aborted");
    expect(r.get(idB)?.status).toBe("running");
    expect(r.runningCount()).toBe(1);
  });

  it("suppresses the late delivery of the aborted run (the wake must not fire)", async () => {
    const r = new TaskRegistry();
    let release!: (v: TaskOutcome) => void;
    const deliver = vi.fn();
    const spawned = r.spawn({
      description: "a",
      depth: 0,
      run: () => new Promise<TaskOutcome>((res) => { release = res; }),
      deliver,
    });
    const id = taskIdOf(spawned);

    r.abortTask(id);
    // The sub-run finishes anyway (the signal is the orchestrator's job; the
    // registry must not deliver a result for a task the user stopped).
    release({ status: "done", summary: "finished anyway" });
    await new Promise((res) => setTimeout(res, 0));

    expect(r.get(id)?.status).toBe("aborted");
    expect(deliver).not.toHaveBeenCalled();
  });

  it("is a no-op on a terminal task and on an unknown id", () => {
    const r = new TaskRegistry();
    const spawned = r.spawn({ description: "a", depth: 0, run: pendingRun(), deliver: () => {} });
    const id = taskIdOf(spawned);

    r.abortTask(id);
    r.abortTask(id); // already aborted — unchanged, no throw
    r.abortTask("task-999"); // never existed

    expect(r.get(id)?.status).toBe("aborted");
  });
});

describe("isSubagentResultMessage", () => {
  it("recognises exactly what formatResultMessage produces", () => {
    expect(isSubagentResultMessage(formatResultMessage("task-3", "done — all green"))).toBe(true);
    expect(isSubagentResultMessage(formatResultMessage("task-12", ""))).toBe(true);
  });

  it("does not match a human message that merely mentions it", () => {
    expect(isSubagentResultMessage("please read the Sub-agent result (task task-1): above")).toBe(false);
    expect(isSubagentResultMessage("fix the tests")).toBe(false);
    expect(isSubagentResultMessage("Sub-agent result without a task id")).toBe(false);
  });
});
