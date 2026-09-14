import { describe, it, expect } from "vitest";

// completer is exported from cli.tsx for the same reason handleSlashCore is:
// unit-testing the completion engine behind prompt Tab without running the
// real CLI startup (main() is guarded to only auto-run as the entrypoint).
import { completer } from "./cli.js";

describe("completer (prompt Tab completion)", () => {
  it("completes slash commands on an empty line, stem = whole line", () => {
    const [hits, base] = completer("", ["code"]);
    expect(base).toBe("");
    // The live command set: the autocomplete menu's commands plus the
    // headless-routed extras; removed commands are never offered.
    expect(hits).toContain("/skills");
    expect(hits).toContain("/sessions");
    expect(hits).toContain("/cost");
    expect(hits).not.toContain("/checkpoint");
    expect(hits).not.toContain("/restore");
  });

  it("completes a partial slash command; single-hit completions carry a space", () => {
    const [multi, multiBase] = completer("/mo", ["code"]);
    expect(multiBase).toBe("/mo");
    expect(multi).toContain("/mode");
    expect(multi).toContain("/modes");

    const [one] = completer("/exit", ["code"]);
    expect(one).toEqual(["/exit "]);
  });

  it("completes /mode args against the known slugs", () => {
    const [hits, base] = completer("/mode cod", ["general", "code"]);
    expect(base).toBe("cod");
    expect(hits).toEqual(["code"]);
  });

  it("does not offer retired mode aliases in completion", () => {
    const [hits] = completer("/mode ", ["general", "code"]);
    expect(hits).toEqual(["general", "code"]);
    expect(hits).not.toContain("architect");
    expect(hits).not.toContain("debug");
    expect(hits).not.toContain("orchestrator");
    expect(hits).not.toContain("ask");
  });

  it("completes /model args against the known provider/model list", () => {
    const [hits, base] = completer("/model deep", ["code"]);
    expect(base).toBe("deep");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.startsWith("deep"))).toBe(true);
  });

  it("completes an @-mention path with the @-token as the stem", () => {
    const [hits, base] = completer("@src/ui/App", ["code"]);
    expect(base).toBe("@src/ui/App");
    expect(hits).toContain("@src/ui/App.tsx");
  });

  it("completes a bare mid-line path token containing a slash", () => {
    const [hits, base] = completer("look at docs/feature", ["code"]);
    expect(base).toBe("docs/feature");
    expect(hits).toContain("docs/feature-plans.md");
    // No @ prefix on bare completions — the line already carries the token.
    expect(hits.every((h) => !h.startsWith("@"))).toBe(true);
  });

  it("offers custom slash commands alongside the builtin set", () => {
    const [hits] = completer("", ["code"], ["review", "deploy"]);
    expect(hits).toContain("/review");
    expect(hits).toContain("/deploy");
    // Custom names that collide with builtins are shadowed, not duplicated.
    expect(hits.filter((h) => h === "/skills")).toHaveLength(1);
  });

  it("completes a partial custom slash command", () => {
    const [one] = completer("/rev", ["code"], ["review"]);
    expect(one).toEqual(["/review "]);
  });

  it("offers nothing for tokens without a slash or slash-command shapes", () => {
    expect(completer("check readme", ["code"])).toEqual([[], "check readme"]);
    // An email trailing the line matches the @-branch but no repo file starts
    // with "b.com" — zero hits, so no completion is applied by the consumer.
    expect(completer("mail me at a@b.com", ["code"])).toEqual([[], "@b.com"]);
    expect(completer("/xyz", ["code"])).toEqual([[], "/xyz"]);
  });
});
