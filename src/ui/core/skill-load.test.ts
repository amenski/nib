import { describe, it, expect } from "vitest";
import type { Message } from "../../types.js";
import { skillLoadMarker, isSkillAlreadyLoaded, buildSkillLoadMessage, parseSkillLoadCommand } from "./skill-load.js";

// These mirror the decisions cli.tsx's `/skill` case makes: find the skill,
// dedupe against conversationHistory, then push exactly one message.
function loadSkill(history: Message[], name: string, content: string | undefined): Message[] {
  if (content === undefined) return history; // unknown skill: nothing pushed
  if (isSkillAlreadyLoaded(history, name)) return history; // already loaded: nothing pushed
  return [...history, buildSkillLoadMessage(name, content)];
}

describe("buildSkillLoadMessage", () => {
  it("builds a user-role message starting with the marker and containing the skill content", () => {
    const msg = buildSkillLoadMessage("commit", "Do the commit thing.");
    expect(msg.role).toBe("user");
    expect(msg.content).toContain(skillLoadMarker("commit"));
    expect(msg.content).toContain("Do the commit thing.");
    expect((msg.content as string).startsWith(skillLoadMarker("commit"))).toBe(true);
  });
});

describe("isSkillAlreadyLoaded", () => {
  it("is false for an empty history", () => {
    expect(isSkillAlreadyLoaded([], "commit")).toBe(false);
  });

  it("is true once a matching marker message is present", () => {
    const history: Message[] = [buildSkillLoadMessage("commit", "body")];
    expect(isSkillAlreadyLoaded(history, "commit")).toBe(true);
  });

  it("does not false-positive on a different skill's marker", () => {
    const history: Message[] = [buildSkillLoadMessage("commit", "body")];
    expect(isSkillAlreadyLoaded(history, "review")).toBe(false);
  });
});

describe("parseSkillLoadCommand", () => {
  it("extracts the name from `/skill <name>`", () => {
    expect(parseSkillLoadCommand("/skill update-docs")).toBe("update-docs");
    expect(parseSkillLoadCommand("  /skill   spaced-name  ")).toBe("spaced-name");
  });

  it("does not match the /skills list command", () => {
    expect(parseSkillLoadCommand("/skills")).toBeNull();
  });

  it("does not match a bare /skill with no argument", () => {
    expect(parseSkillLoadCommand("/skill")).toBeNull();
    expect(parseSkillLoadCommand("/skill   ")).toBeNull();
  });

  it("does not match extra arguments or unrelated text", () => {
    expect(parseSkillLoadCommand("/skill a b")).toBeNull();
    expect(parseSkillLoadCommand("not a command")).toBeNull();
  });
});

describe("/skill loading (cli.tsx case logic)", () => {
  it("loading a skill pushes exactly one user message containing the skill content", () => {
    const history = loadSkill([], "commit", "Commit changes in this agent context");
    expect(history).toHaveLength(1);
    expect(history[0].role).toBe("user");
    expect(history[0].content).toContain("Commit changes in this agent context");
  });

  it("loading the same skill twice does not push a second message", () => {
    const once = loadSkill([], "commit", "Commit changes in this agent context");
    const twice = loadSkill(once, "commit", "Commit changes in this agent context");
    expect(twice).toHaveLength(1);
    expect(twice).toBe(once);
  });

  it("an unknown skill name pushes nothing", () => {
    const history = loadSkill([], "does-not-exist", undefined);
    expect(history).toHaveLength(0);
  });
});
