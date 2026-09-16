import { describe, it, expect } from "vitest";
import {
  patternMatches,
  specificity,
  globSpecificity,
  matchesTool,
  buildSubject,
  extractToolSubject,
  extractHostname,
  parseRulePattern,
  serializeRulePattern,
  type PermissionRule,
} from "./rules.js";

function rule(partial: Partial<PermissionRule>): PermissionRule {
  return { tool: "read_file", kind: "any", pattern: "", action: "allow", origin: "config", ...partial };
}

describe("extractToolSubject", () => {
  it("lists every apply_patch header target for the approval prompt", () => {
    expect(extractToolSubject("apply_patch", {
      patch: "+++ b/src/a.ts\n@@ -1 +1 @@\n-x\n+y\n+++ b/src/b.ts\n@@ -1 +1 @@\n-x\n+y",
    })).toBe("src/a.ts, src/b.ts");
  });
});

describe("matchesTool", () => {
  it("matches exact tool names", () => {
    expect(matchesTool("read_file", "read_file")).toBe(true);
    expect(matchesTool("read_file", "write_to_file")).toBe(false);
  });

  it("matches * wildcard against any tool", () => {
    expect(matchesTool("*", "run_bash")).toBe(true);
  });

  it("matches mcp__* against mcp tool names only", () => {
    expect(matchesTool("mcp__*", "mcp__github__list_issues")).toBe(true);
    expect(matchesTool("mcp__*", "read_file")).toBe(false);
  });
});

describe("patternMatches: exact", () => {
  it("matches identical text only", () => {
    const r = rule({ tool: "run_bash", kind: "exact", pattern: "git status" });
    expect(patternMatches(r, { tool: "run_bash", text: "git status" })).toBe(true);
    expect(patternMatches(r, { tool: "run_bash", text: "git status -s" })).toBe(false);
  });
});

describe("patternMatches: prefix", () => {
  it("matches whole-token prefixes", () => {
    const r = rule({ tool: "run_bash", kind: "prefix", pattern: "git commit" });
    expect(patternMatches(r, { tool: "run_bash", text: "git commit -m x" })).toBe(true);
  });

  it("does not match a token that merely starts with the same characters", () => {
    const r = rule({ tool: "run_bash", kind: "prefix", pattern: "git commit" });
    expect(patternMatches(r, { tool: "run_bash", text: "git commitment-plan.sh" })).toBe(false);
  });

  it("does not match when text has fewer tokens than pattern", () => {
    const r = rule({ tool: "run_bash", kind: "prefix", pattern: "git commit -m" });
    expect(patternMatches(r, { tool: "run_bash", text: "git commit" })).toBe(false);
  });

  it("matches the last token at a word boundary (path separator)", () => {
    const r = rule({ tool: "run_bash", kind: "prefix", pattern: "rm -rf ~" });
    expect(patternMatches(r, { tool: "run_bash", text: "rm -rf ~/Documents" })).toBe(true);
  });

  it("matches the last token at a word boundary (dot)", () => {
    const r = rule({ tool: "run_bash", kind: "prefix", pattern: "mkfs" });
    expect(patternMatches(r, { tool: "run_bash", text: "mkfs.ext4 /dev/sda1" })).toBe(true);
  });

  it("does not match the last token when it continues mid-word with no boundary", () => {
    const r = rule({ tool: "run_bash", kind: "prefix", pattern: "git commit" });
    expect(patternMatches(r, { tool: "run_bash", text: "git commitment-plan.sh" })).toBe(false);
  });
});

describe("patternMatches: glob", () => {
  it("matches nested paths under **", () => {
    const r = rule({ tool: "read_file", kind: "glob", pattern: "./src/**" });
    expect(patternMatches(r, { tool: "read_file", text: "./src/a/b.ts", resolvedPath: "./src/a/b.ts" })).toBe(true);
  });

  it("does not match outside the glob root", () => {
    const r = rule({ tool: "read_file", kind: "glob", pattern: "./src/**" });
    expect(patternMatches(r, { tool: "read_file", text: "./etc/passwd", resolvedPath: "./etc/passwd" })).toBe(false);
  });

  it("single * does not cross path separators", () => {
    const r = rule({ tool: "read_file", kind: "glob", pattern: "./src/*.ts" });
    expect(patternMatches(r, { tool: "read_file", text: "./src/a.ts", resolvedPath: "./src/a.ts" })).toBe(true);
    expect(patternMatches(r, { tool: "read_file", text: "./src/a/b.ts", resolvedPath: "./src/a/b.ts" })).toBe(false);
  });
});

describe("patternMatches: any", () => {
  it("matches every subject for the tool regardless of text", () => {
    const r = rule({ tool: "run_bash", kind: "any", pattern: "" });
    expect(patternMatches(r, { tool: "run_bash", text: "anything at all" })).toBe(true);
  });
});

describe("specificity: cross-kind ordering invariant", () => {
  it("glob ceiling stays below prefix floor, which stays below exact floor", () => {
    const maxGlob = globSpecificity("a/a/a/a/a/a/a/a/a/a/a/a/a/a/a/a/a/a/a/a");
    const minPrefix = specificity(rule({ kind: "prefix", pattern: "x" }));
    const minExact = specificity(rule({ kind: "exact", pattern: "" }));
    expect(maxGlob).toBeLessThan(minPrefix);
    expect(minPrefix).toBeLessThan(minExact);
  });

  it("blanket glob ** scores far below a narrow prefix deny (the first-draft inversion case)", () => {
    const blanketAllow = specificity(rule({ kind: "glob", pattern: "**", action: "allow" }));
    const narrowDeny = specificity(rule({ kind: "prefix", pattern: "/etc", action: "deny", tool: "run_bash" }));
    expect(blanketAllow).toBeLessThan(narrowDeny);
  });

  it("any-kind scores the absolute floor", () => {
    expect(specificity(rule({ kind: "any" }))).toBe(0);
  });

  it("longer prefix patterns score higher (real narrowing, not flag-padding-proof by itself)", () => {
    const short = specificity(rule({ kind: "prefix", pattern: "git push --force" }));
    const long = specificity(rule({ kind: "prefix", pattern: "git push --force --quiet" }));
    expect(long).toBeGreaterThan(short);
  });
});

describe("buildSubject", () => {
  it("builds a bash subject from command text", () => {
    const s = buildSubject("run_bash", { command: "git status" });
    expect(s).toEqual({ tool: "run_bash", text: "git status" });
  });

  it("builds a file subject from path", () => {
    const s = buildSubject("read_file", { path: "/tmp/x.txt" });
    expect(s.tool).toBe("read_file");
    expect(s.text).toBe("/tmp/x.txt");
    expect(s.resolvedPath).toBe("/tmp/x.txt");
  });

  it("builds a web_fetch subject with resolvedPath set to the hostname, not the full URL", () => {
    const s = buildSubject("web_fetch", { url: "https://example.com/some/path?x=1" });
    expect(s.tool).toBe("web_fetch");
    expect(s.text).toBe("https://example.com/some/path?x=1");
    expect(s.resolvedPath).toBe("example.com");
  });
});

describe("extractHostname", () => {
  it("extracts a lowercased hostname from a URL", () => {
    expect(extractHostname("https://Example.COM/path")).toBe("example.com");
  });

  it("returns undefined for an unparsable URL", () => {
    expect(extractHostname("not a url")).toBeUndefined();
  });
});

describe("rule pattern serialization", () => {
  it("round-trips a prefix pattern through the :* on-disk suffix", () => {
    const onDisk = serializeRulePattern("prefix", "git commit");
    expect(onDisk).toBe("git commit:*");
    expect(parseRulePattern("prefix", onDisk)).toBe("git commit");
  });

  it("leaves exact/glob patterns untouched", () => {
    expect(serializeRulePattern("exact", "git status")).toBe("git status");
    expect(parseRulePattern("glob", "./src/**")).toBe("./src/**");
  });
});
