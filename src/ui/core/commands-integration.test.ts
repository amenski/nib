import { describe, it, expect } from "vitest";
import { getSlashCommands, findExactSlashCommand } from "./slash-commands.js";
import { resolveSlashSubmit } from "./slash-submit.js";
import { opensModal } from "./modal-commands.js";

// End-to-end coverage of the whole slash-command layer: every command is walked
// through the real routing pipeline (resolveSlashSubmit + opensModal), the two
// pure decisions App.tsx relies on. This does not drive the Ink TUI (no TTY),
// but it exercises the classification each command depends on to behave.

const items = getSlashCommands();

// Commands that only open a UI-only overlay — safe to run over an in-flight
// turn (App runs them immediately instead of queueing). "sessions" and "modes"
// are handler aliases not present in the builtin menu list, included here
// because App's handleSlashCommand routes them and opensModal must agree.
const MODAL = [
  "model", "mode", "theme", "effort", "resume", "continue", "sessions",
  "skills", "modes", "undo", "mcp", "tasks", "permissions", "usage", "help", "doctor", "context",
];

// Commands that mutate state / start or end the session — must stay queueable
// behind an active turn.
const STATEFUL = ["new", "clear", "compact", "plan", "exit", "raw"];

describe("slash-command layer (integration)", () => {
  it("every builtin command exists and is discoverable by exact match", () => {
    for (const item of items) {
      expect(findExactSlashCommand(items, `/${item.name}`)).toBe(item);
    }
    // Sanity: the builtin set is the 21 we expect.
    expect(items.map((i) => i.name).sort()).toEqual(
      [
        "clear", "compact", "context", "continue", "doctor", "effort", "exit", "help", "mcp", "mode", "model",
        "new", "permissions", "plan", "raw", "resume", "skills", "tasks", "theme", "undo", "usage",
      ].sort(),
    );
  });

  it("routes every bare builtin command through its kind handler when idle", () => {
    for (const item of items) {
      const decision = resolveSlashSubmit(`/${item.name}`, items, false);
      expect(decision, `/${item.name} should routeKind`).toMatchObject({
        action: "routeKind",
        kind: item,
      });
    }
  });

  it("preserves args by submitting full text (not routeKind)", () => {
    expect(resolveSlashSubmit("/permissions history", items, false)).toEqual({
      action: "submitText",
      text: "/permissions history",
    });
    expect(resolveSlashSubmit("/raw normal", items, false)).toEqual({
      action: "submitText",
      text: "/raw normal",
    });
  });

  it("submits unknown slash tokens as text and passes plain text through", () => {
    expect(resolveSlashSubmit("/nope", items, false)).toEqual({
      action: "submitText",
      text: "/nope",
    });
    expect(resolveSlashSubmit("hello", items, false)).toBeNull();
  });

  it("defers all routing to App while a turn is active (busy)", () => {
    for (const item of items) {
      expect(resolveSlashSubmit(`/${item.name}`, items, true)).toBeNull();
    }
  });

  it("classifies modal commands as bypass-queue (bare and slash forms)", () => {
    for (const name of MODAL) {
      expect(opensModal(name), `${name} should open a modal`).toBe(true);
      expect(opensModal(`/${name}`), `/${name} should open a modal`).toBe(true);
    }
  });

  it("classifies stateful commands as queueable (never bypass)", () => {
    for (const name of STATEFUL) {
      expect(opensModal(`/${name}`), `/${name} must not bypass the queue`).toBe(false);
    }
  });

  it("modal and stateful buckets are disjoint and cover the builtin set", () => {
    const overlap = MODAL.filter((m) => STATEFUL.includes(m));
    expect(overlap).toEqual([]);
    // Every builtin command is classified by exactly one bucket (sessions/modes
    // are extra aliases, so drop them from the coverage check).
    for (const item of items) {
      const inModal = MODAL.includes(item.name);
      const inStateful = STATEFUL.includes(item.name);
      expect(inModal !== inStateful, `${item.name} must be in exactly one bucket`).toBe(true);
    }
  });
});
