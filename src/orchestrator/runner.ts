/**
 * In-memory task registry for async sub-agent execution (docs/async-subagents.md).
 *
 * `new_task` spawns detached sub-runs through this registry: the tool returns
 * immediately with a task id, the sub-run executes in the background, and on
 * completion the registry records the outcome and hands the formatted result
 * message to the delivery callback the App / exec-runner wired in.
 *
 * Lifetime is deliberately in-memory only (design §3, Q3): /exit kills pending
 * sub-runs and resume never restores tasks. `abortAll()` marks running tasks
 * aborted and suppresses their late delivery — the process exit itself is the
 * actual kill, this just keeps the registry honest on the way out.
 */

export type TaskStatus = "running" | "done" | "failed" | "aborted";

export interface TaskRecord {
  id: string;
  description: string;
  status: TaskStatus;
  spawnedAt: number;
  depth: number;
  agentName?: string;
  /** The summary text, for done/aborted tasks. */
  result?: string;
  /** The failure message, for failed tasks. */
  error?: string;
}

/** What a detached sub-run reports when it finishes (runAgent's stopReason
 *  maps to done/aborted; max_turns still counts as done — the summary says so). */
export type TaskOutcome =
  | { status: "done"; summary: string }
  | { status: "aborted"; summary: string };

export interface SpawnOptions {
  description: string;
  depth: number;
  agentName?: string;
  /** Runs the detached sub-run. Resolves when it finishes; a rejected promise
   *  is recorded as `failed` (design §2 delivers failed results too). */
  run: () => Promise<TaskOutcome>;
  /** Called with the formatted result message when the run completes
   *  (done/failed/aborted) — the App/exec-runner wake path (design §2). */
  deliver: (taskId: string, message: string) => void;
}

/** Concurrency cap (design §3, Q2 — owner decision: 3). */
export const MAX_CONCURRENT_TASKS = 3;

export function formatResultMessage(taskId: string, summary: string): string {
  return `Sub-agent result (task ${taskId}): ${summary}`;
}

/**
 * Whether `text` is a message {@link formatResultMessage} produced. The wake
 * path delivers it as a user-role message, but no human typed it, so auto
 * mode must not count it as the user's words.
 */
export function isSubagentResultMessage(text: string): boolean {
  return /^Sub-agent result \(task [^)\s]+\): /.test(text);
}

export class TaskRegistry {
  private tasks = new Map<string, TaskRecord>();
  private nextId = 1;
  /** Waiters from waitForNextCompletion, released when any task completes. */
  private completionWaiters: Array<() => void> = [];
  readonly maxConcurrent: number;

  constructor(maxConcurrent: number = MAX_CONCURRENT_TASKS) {
    this.maxConcurrent = maxConcurrent;
  }

  runningCount(): number {
    let n = 0;
    for (const t of this.tasks.values()) if (t.status === "running") n++;
    return n;
  }

  list(): TaskRecord[] {
    return [...this.tasks.values()];
  }

  get(taskId: string): TaskRecord | undefined {
    return this.tasks.get(taskId);
  }

  /**
   * Register + launch a detached sub-run. Returns the new task id, or an error
   * string when the concurrency cap is reached — the caller surfaces it as a
   * "queue full" tool error; nothing is spawned and no hooks fire.
   */
  spawn(opts: SpawnOptions): { taskId: string } | { error: string } {
    if (this.runningCount() >= this.maxConcurrent) {
      return { error: `queue full (${this.maxConcurrent} running)` };
    }
    const taskId = `task-${this.nextId++}`;
    const record: TaskRecord = {
      id: taskId,
      description: opts.description,
      status: "running",
      spawnedAt: Date.now(),
      depth: opts.depth,
      agentName: opts.agentName,
    };
    this.tasks.set(taskId, record);

    void (async () => {
      let outcome: TaskOutcome | { status: "failed"; summary: string };
      try {
        outcome = await opts.run();
      } catch (err) {
        outcome = {
          status: "failed",
          summary: `failed — ${(err as Error).message}`,
        };
      }
      const t = this.tasks.get(taskId);
      // abortAll() (die on exit) marks the task aborted and suppresses delivery:
      // nothing may flip a terminated task's status or wake a dying app.
      if (t && t.status === "running") {
        if (outcome.status === "failed") {
          t.status = "failed";
          t.error = outcome.summary;
        } else {
          t.status = outcome.status;
          t.result = outcome.summary;
        }
        opts.deliver(taskId, formatResultMessage(taskId, outcome.summary));
      }
      this.notifyCompletion();
    })();

    return { taskId };
  }

  /**
   * Resolves when the next running task completes (immediately when nothing is
   * running). The headless loop waits on this between turns, so a run whose
   * parent ended its turn still drains to completion.
   */
  waitForNextCompletion(): Promise<void> {
    if (this.runningCount() === 0) return Promise.resolve();
    return new Promise((resolve) => this.completionWaiters.push(resolve));
  }

  /**
   * Mark ONE running task aborted and release waiters — the /tasks stop action
   * (async-subagents.md §3, Q4). Targeted unlike abortAll: only this task's
   * record flips, so the /tasks view shows the stop while siblings keep
   * running. The orchestrator additionally fires that task's own abort signal;
   * the record flip alone suppresses the late delivery (same rule as
   * abortAll). A terminal or unknown task is a no-op.
   */
  abortTask(taskId: string): void {
    const t = this.tasks.get(taskId);
    if (t && t.status === "running") {
      t.status = "aborted";
      this.notifyCompletion();
    }
  }

  /** Mark every running task aborted and release waiters — the exit path
   *  (App /exit, headless teardown). See the file header for the kill story. */
  abortAll(): void {
    for (const t of this.tasks.values()) {
      if (t.status === "running") t.status = "aborted";
    }
    this.notifyCompletion();
  }

  private notifyCompletion(): void {
    const waiters = this.completionWaiters;
    this.completionWaiters = [];
    for (const w of waiters) w();
  }
}
