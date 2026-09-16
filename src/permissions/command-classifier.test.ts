import { describe, expect, it } from "vitest";
import { classifyCommand, classifyCommandSegment } from "./command-classifier.js";
import { extractCapabilityPlan } from "./capabilities.js";

describe("deterministic command classifier", () => {
  it.each([
    "cat README.md",
    "rg -n TODO src",
    "find src -type f",
    "git status --short",
    "git log --oneline -5",
    "pwd && git diff --stat",
    "printf '%s' hello",
  ])("classifies proven read-only command: %s", (command) => {
    expect(classifyCommand(command).classification).toBe("proven-read-only");
  });

  it.each([
    "bash -c 'cat README.md'",
    "timeout 60 python3 mcp_probe.py",
    "python3 -c 'print(1)'",
    "cat README.md > copy.md",
    "echo $(whoami)",
    "cat `whoami`",
    "rg TODO src | xargs rm",
    "alias ll='ls -la'",
    "ll",
    "./scripts/inspect.sh",
    "find . -exec cat {} \\;",
    "git commit -am message",
    "git branch -d old-feature",
    "git tag -d old-release",
    "date --set yesterday",
    "hostname changed-host",
    "sort -o output.txt input.txt",
    "npm test",
    "cat ~/secret.txt",
  ])("leaves unknown command unclassified: %s", (command) => {
    expect(classifyCommand(command)).toMatchObject({ classification: "unknown" });
  });

  it("does not treat a compound command as safe when one segment is unknown", () => {
    expect(classifyCommand("git status && npm test").classification).toBe("unknown");
  });

  it("does not classify an incomplete quoted segment", () => {
    expect(classifyCommandSegment("cat 'README.md").classification).toBe("unknown");
  });

  it("is advisory metadata and does not alter the process capability", () => {
    const safe = extractCapabilityPlan("run_bash", { command: "cat README.md" }, "/workspace");
    const unknown = extractCapabilityPlan("run_bash", { command: "python3 -c 'print(1)'" }, "/workspace");

    expect(safe).toMatchObject({
      status: "known",
      capabilities: [{ type: "process.execute", command: "cat README.md" }],
      commandClassification: { classification: "proven-read-only" },
    });
    expect(unknown).toMatchObject({
      status: "known",
      capabilities: [{ type: "process.execute", command: "python3 -c 'print(1)'" }],
      commandClassification: { classification: "unknown" },
    });
  });
});
