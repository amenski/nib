import { describe, it, expect } from "vitest";
import { opensModal } from "./modal-commands.js";

describe("opensModal", () => {
  it("recognizes UI-only modal commands (bare name)", () => {
    for (const c of ["model", "effort", "resume", "continue", "sessions", "skills", "modes", "undo", "mcp", "tasks", "jobs", "permissions", "usage", "help", "doctor", "context"]) {
      expect(opensModal(c)).toBe(true);
    }
  });

  it("recognizes the same commands as slash text", () => {
    expect(opensModal("/resume")).toBe(true);
    expect(opensModal("/model")).toBe(true);
  });

  it("treats /context as a modal command (read-only diagnostics, like /doctor)", () => {
    // It only reads state (the token breakdown and the compaction trigger), so
    // it must run over an in-flight turn instead of queueing behind it.
    expect(opensModal("/context")).toBe(true);
  });

  it("matches on the first token so args don't defeat it", () => {
    expect(opensModal("/permissions history")).toBe(true);
    expect(opensModal("permissions history")).toBe(true);
  });

  it("does not treat turn-affecting commands as modals", () => {
    // These mutate history / start a turn / quit — they must stay queueable.
    expect(opensModal("/new")).toBe(false);
    expect(opensModal("/clear")).toBe(false);
    expect(opensModal("/plan")).toBe(false);
    expect(opensModal("/exit")).toBe(false);
    expect(opensModal("/raw")).toBe(false);
  });

  it("returns false for plain text and unknown commands", () => {
    expect(opensModal("hello world")).toBe(false);
    expect(opensModal("/bogus")).toBe(false);
  });
});
