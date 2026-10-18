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
    "git --no-pager log --oneline -15",
    "git -P diff --stat",
    "git --no-pager -P show --stat abc123",
    "echo '=== heading?'",
    "echo ---",
    "grep -rn \"a.*b\\|c[0-9]\" src",
    "sort",
    "sort -u -k2,2 names.txt",
    "sed -n '10,20p' src/a.ts",
    "sed -n '/start/,/end/p' notes.md",
    "sed -nE '5,$p' notes.md",
    "rg -n TODO src",
    "uniq",
    "uniq -c",
    "uniq -c in.txt",
    "file README.md",
    "git log --output-indicator-new=+ --oneline",
    "ls *.ts",
    "ls src/*",
    "cat src/*.ts",
    "wc -l docs/*.md",
    "head -5 docs/a?.md",
    "tail -3 logs/[ab].log",
    "grep -rn foo --include=*.java --exclude-dir=node_modules --exclude=*.min.js src/*/main",
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
    "git --no-pager -C ../other log",
    "git -P -c core.pager=less log",
    "git --no-pager commit -m message",
    "git --no-pager",
    "echo hi > f",
    "cd src",
    "sort -o out.txt in.txt",
    "sort -ro out.txt in.txt",
    "sort --output=out.txt in.txt",
    "sort --out out.txt in.txt",
    "sort --compress-program=sh in.txt",
    "sort '*.txt'",
    "sed -i 's/a/b/' f",
    "sed -n -i 1p f",
    "sed 's/a/b/' f",
    "sed -n 'w out.txt' f",
    "sed -n '1p;w out.txt' f",
    "sed -n '1,2p' f -i",
    "sed -e 1p f",
    "sed -f script.sed f",
    "sed -n '1e echo hi' f",
    "find . -name '*.ts'",
    "git log '*.ts'",
    "du *.ts",
    "stat src/*",
    "rg foo *.ts",
    "rg --glob=*.ts foo",
    "rg --pre 'sh x' foo",
    "rg --pre=cat foo",
    "rg --pre-glob '*.pdf' foo",
    "rg --hostname-bin=sh foo",
    "uniq in.txt out.txt",
    "uniq -c in.txt out.txt",
    "file -C -m magic",
    "file --compile",
    "file --co",
    "git diff --output=out.patch",
    "git --no-pager log --output out.txt",
    "git show --output=f HEAD",
    "git diff --out=f",
    "git whatchanged --output=f",
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
