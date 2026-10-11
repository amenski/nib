import { describe, it, expect } from "vitest";
import {
  getSlashCommands,
  filterSlashCommands,
  findExactSlashCommand,
  type SlashCommandKind,
} from "./slash-commands.js";

// The set of kinds that App.tsx's handleSlashCommand actually routes (either
// directly, or by delegating to handleSlashCore). This list is the contract:
// every registered command must map to a kind in here — a registered command
// with a kind not covered here would fall through to `Unknown:` at runtime.
const ROUTED_KINDS: ReadonlySet<SlashCommandKind> = new Set<SlashCommandKind>([
  "model",
  "mode",
  "effort",
  "new",
  "resume",
  "continue",
  "undo",
  "mcp",
  "tasks",
  "permissions",
  "usage",
  "exit",
  "help",
  "clear",
  "skills",
  "plan",
  "raw",
  "doctor",
  "context",
  "compact",
]);

describe("/theme is hidden while there is a single theme", () => {
  it("is not registered, so the menu, palette and prefix filter never show it", () => {
    const cmds = getSlashCommands();
    expect(cmds.map((c) => c.name)).not.toContain("theme");
    expect(filterSlashCommands(cmds, "/the").map((h) => h.name)).not.toContain("theme");
    expect(findExactSlashCommand(cmds, "/theme")).toBeNull();
  });
});

describe("slash command registry routing", () => {
  it("every registered command maps to a routed kind (no fall-through to Unknown)", () => {
    for (const cmd of getSlashCommands()) {
      expect(
        ROUTED_KINDS.has(cmd.kind),
        `/${cmd.name} has kind "${cmd.kind}" which is not routed`,
      ).toBe(true);
    }
  });

  it("registers /new with a routed 'new' kind", () => {
    const cmd = findExactSlashCommand(getSlashCommands(), "/new");
    expect(cmd?.kind).toBe("new");
    expect(ROUTED_KINDS.has("new")).toBe(true);
  });

  it("registers /plan with a routed 'plan' kind", () => {
    const cmd = findExactSlashCommand(getSlashCommands(), "/plan");
    expect(cmd?.kind).toBe("plan");
    expect(ROUTED_KINDS.has("plan")).toBe(true);
  });

  it("registers /permissions and /raw (present in the /help surface)", () => {
    const names = getSlashCommands().map((c) => c.name);
    expect(names).toContain("permissions");
    expect(names).toContain("raw");
  });

  it("registers /context with a routed 'context' kind", () => {
    const cmd = findExactSlashCommand(getSlashCommands(), "/context");
    expect(cmd?.kind).toBe("context");
    expect(cmd?.description).toMatch(/context/i);
    expect(ROUTED_KINDS.has("context")).toBe(true);
  });

  it("lists /context in the menu's filtered set", () => {
    expect(filterSlashCommands(getSlashCommands(), "/con").map((h) => h.name)).toContain("context");
  });

  it("registers /usage with a routed 'usage' kind", () => {
    const cmd = findExactSlashCommand(getSlashCommands(), "/usage");
    expect(cmd?.kind).toBe("usage");
    expect(ROUTED_KINDS.has("usage")).toBe(true);
  });

  it("does not register the removed dead commands", () => {
    const names = getSlashCommands().map((c) => c.name);
    for (const dead of ["checkpoint", "checkpoints", "restore", "approve"]) {
      expect(names).not.toContain(dead);
    }
  });
});
