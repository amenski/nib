import { describe, it, expect } from "vitest";
import { resolveSlashSubmit } from "./slash-submit.js";
import { getSlashCommands } from "./slash-commands.js";

const items = getSlashCommands();

describe("resolveSlashSubmit", () => {
  it("routes a bare known command through its kind handler", () => {
    expect(resolveSlashSubmit("/model", items, false)).toMatchObject({ action: "routeKind" });
    expect(resolveSlashSubmit("/clear", items, false)).toMatchObject({ action: "routeKind" });
    expect(resolveSlashSubmit("/permissions", items, false)).toMatchObject({ action: "routeKind" });
    expect(resolveSlashSubmit("/plan", items, false)).toMatchObject({ action: "routeKind" });
  });

  it("submits the full text when args are present, preserving them", () => {
    expect(resolveSlashSubmit("/permissions history", items, false)).toEqual({
      action: "submitText",
      text: "/permissions history",
    });
    expect(resolveSlashSubmit("/raw normal", items, false)).toEqual({
      action: "submitText",
      text: "/raw normal",
    });
    expect(resolveSlashSubmit("/clear foo", items, false)).toEqual({
      action: "submitText",
      text: "/clear foo",
    });
  });

  it("submits unknown slash tokens as text", () => {
    expect(resolveSlashSubmit("/cl", items, false)).toEqual({ action: "submitText", text: "/cl" });
  });

  it("returns null for non-slash text", () => {
    expect(resolveSlashSubmit("hello world", items, false)).toBeNull();
  });

  it("returns null while busy (App enqueues it as a plain submission)", () => {
    expect(resolveSlashSubmit("/plan", items, true)).toBeNull();
  });
});
