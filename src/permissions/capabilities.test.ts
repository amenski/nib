import { describe, expect, it } from "vitest";
import { TOOL_DEFS } from "../tools/index.js";
import { extractApplyPatchPlan, extractCapabilityPlan, unknownCapabilityPlan } from "./capabilities.js";

const SAMPLE_ARGS: Record<string, Record<string, unknown>> = {
  read_file: { path: "src/example.ts" },
  list_files: { path: "src" },
  glob: { cwd: "src", pattern: "**/*.ts" },
  run_bash: { command: "git status" },
  search: { dir: "src", pattern: "TODO" },
  edit: { path: "src/example.ts", oldString: "old", newString: "new" },
  apply_diff: { path: "src/example.ts", diff: "@@ -1 +1 @@\n-old\n+new" },
  apply_patch: { patch: "+++ b/src/example.ts\n@@ -1 +1 @@\n-old\n+new" },
  search_replace: { path: "src/example.ts", search: "old", replace: "new" },
  edit_file: { path: "src/example.ts", search: "old", replace: "new", expectedCount: 1 },
  write_to_file: { path: "src/example.ts", content: "new" },
  ask_user_question: { questions: [{ question: "Continue?", options: [{ label: "Yes" }] }] },
  web_search: { query: "nib security" },
  web_fetch: { url: "https://example.com" },
  view_image: { url: "src/example.png" },
  run_bash_background: { command: "git status" },
  check_job: { job_id: "job-1" },
  kill_job: { job_id: "job-1" },
  update_todo_list: { todos: [{ content: "Plan", status: "pending" }] },
  attempt_completion: { summary: "Done" },
  switch_mode: { slug: "code" },
};

describe("unknownCapabilityPlan", () => {
  it("cannot create a persistent approval scope", () => {
    expect(unknownCapabilityPlan("apply_patch", "patch targets were not parsed")).toEqual({
      tool: "apply_patch",
      capabilities: [],
      status: "unknown",
      reason: "patch targets were not parsed",
      allowPersistentApproval: false,
    });
  });
});

describe("extractApplyPatchPlan", () => {
  it("extracts immutable read/write capabilities for every patch target", () => {
    const plan = extractApplyPatchPlan({
      patch: "+++ b/src/a.ts\n@@ -1 +1 @@\n-x\n+y\n+++ b/src/b.ts\n@@ -1 +1 @@\n-x\n+y",
    }, "/workspace");

    expect(plan).toMatchObject({
      tool: "apply_patch",
      status: "known",
      allowPersistentApproval: false,
      targets: [
        { rawPath: "src/a.ts", path: "/workspace/src/a.ts" },
        { rawPath: "src/b.ts", path: "/workspace/src/b.ts" },
      ],
    });
    expect(plan.capabilities).toContainEqual({ type: "fs.read", path: "/workspace/src/a.ts" });
    expect(plan.capabilities).toContainEqual({ type: "fs.write", path: "/workspace/src/b.ts" });
  });

  it("fails closed when a target escapes the workspace", () => {
    expect(extractApplyPatchPlan({ patch: "+++ b/../outside.txt\n@@ -1 +1 @@\n-x\n+y" }, "/workspace"))
      .toMatchObject({ status: "unknown", allowPersistentApproval: false });
  });

  it("uses the same configured write roots as the policy layer", () => {
    const plan = extractApplyPatchPlan(
      { patch: "+++ b//configured-root/example.ts\n@@ -1 +1 @@\n-x\n+y" },
      "/workspace",
      { roots: ["/workspace", "/configured-root"] },
    );

    expect(plan).toMatchObject({
      status: "known",
      targets: [{ rawPath: "/configured-root/example.ts", path: "/configured-root/example.ts" }],
    });
  });
});

describe("built-in capability plans", () => {
  it("covers every registered tool with a non-empty known plan", () => {
    const registeredNames = TOOL_DEFS.map(({ name }) => name).sort();
    expect(Object.keys(SAMPLE_ARGS).sort()).toEqual(registeredNames);

    for (const tool of registeredNames) {
      const plan = extractCapabilityPlan(tool, SAMPLE_ARGS[tool], "/workspace");
      expect(plan.status, tool).toBe("known");
      expect(plan.capabilities.length, tool).toBeGreaterThan(0);
    }
  });

  it("gives foreground and background Bash the same process capability", () => {
    const foreground = extractCapabilityPlan("run_bash", { command: "git status" }, "/workspace");
    const background = extractCapabilityPlan("run_bash_background", { command: "git status" }, "/workspace");

    expect(background.capabilities).toEqual(foreground.capabilities);
  });
});
