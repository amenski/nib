import { describe, it, expect } from "vitest";
import { VerificationGate, isVerificationCommand, EDIT_TOOLS } from "./verification-gate.js";

const NO_ARGS = {};

describe("isVerificationCommand", () => {
  it("matches test, typecheck, build, and lint invocations", () => {
    for (const command of [
      "npm test",
      "npm run build",
      "npx tsc --noEmit",
      "node --test src/calc.test.js",
      "pytest -q",
      "dart analyze",
      "flutter test",
      "go test ./...",
    ]) {
      expect(isVerificationCommand(command), command).toBe(true);
    }
  });

  it("matches a verify command buried in compound noise", () => {
    expect(isVerificationCommand("echo built && npm test && ls")).toBe(true);
    expect(isVerificationCommand("cd /tmp; npx tsc --noEmit")).toBe(true);
  });

  it("does not match ordinary commands", () => {
    for (const command of ["node src/index.js", "echo done", "rm -rf dist", "git status", "ls -la"]) {
      expect(isVerificationCommand(command), command).toBe(false);
    }
  });

  it("does not match --help/--version riding a verify prefix", () => {
    expect(isVerificationCommand("npm test --help")).toBe(false);
    expect(isVerificationCommand("npx tsc --version")).toBe(false);
  });
});

describe("VerificationGate", () => {
  it("passes through when nothing was edited (turn with no edits)", () => {
    const gate = new VerificationGate();
    gate.observe("run_bash", { command: "cat README.md" });
    expect(gate.check()).toBeNull();
  });

  it("reminds once on edit → attempt_completion, then lets the second through", () => {
    const gate = new VerificationGate();
    gate.observe("edit", { path: "src/auth.ts" });

    const first = gate.check();
    expect(first).not.toBeNull();
    expect(first!.content).toContain("src/auth.ts");

    expect(gate.check()).toBeNull();
  });

  it("completes at once after a verification command ran", () => {
    const gate = new VerificationGate();
    gate.observe("edit", { path: "src/auth.ts" });
    gate.observe("run_bash", { command: "npm test" });
    expect(gate.check()).toBeNull();
  });

  it("re-arms after a NEW edit — once per edit, not once per turn", () => {
    const gate = new VerificationGate();
    gate.observe("edit", { path: "src/a.ts" });
    gate.observe("run_bash", { command: "npm test" });
    gate.observe("edit", { path: "src/a.ts" });

    expect(gate.check()).not.toBeNull();
    expect(gate.check()).toBeNull();
  });

  it("edit after verification un-verifies: reminder fires again", () => {
    const gate = new VerificationGate();
    gate.observe("edit", NO_ARGS);
    gate.observe("run_bash", { command: "npx tsc --noEmit" });
    gate.observe("edit", NO_ARGS);
    expect(gate.check()).not.toBeNull();
  });

  it("a failed edit does not arm the reminder (observe is only called on success)", () => {
    expect(new VerificationGate().check()).toBeNull();
  });

  it("verification via a background bash counts", () => {
    const gate = new VerificationGate();
    gate.observe("edit", NO_ARGS);
    gate.observe("run_bash_background", { command: "npm test --silent" });
    expect(gate.check()).toBeNull();
  });

  it("never intercepts a completion when the tool is off (no observe calls)", () => {
    const gate = new VerificationGate();
    gate.observe("read_file", { path: "src/x.ts" });
    gate.observe("search", {});
    expect(gate.check()).toBeNull();
  });
});

describe("EDIT_TOOLS coverage", () => {
  it("covers every single-file write tool and apply_patch", () => {
    for (const tool of ["edit", "edit_file", "write_to_file", "apply_diff", "apply_patch", "search_replace"]) {
      expect(EDIT_TOOLS.has(tool), tool).toBe(true);
    }
  });
});
