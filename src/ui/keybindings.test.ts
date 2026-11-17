import { describe, it, expect } from "vitest";
import { lookupAction, resolveKeybindings } from "./keybindings.js";

describe("default keybindings", () => {
  it("binds ctrl+t to cycleEffort", () => {
    expect(lookupAction({ name: "t", ctrl: true }, resolveKeybindings())).toEqual(["cycleEffort"]);
  });

  it("keeps ctrl+shift+t on toggleTheme", () => {
    expect(lookupAction({ name: "t", ctrl: true, shift: true }, resolveKeybindings())).toEqual(["toggleTheme"]);
  });
});
