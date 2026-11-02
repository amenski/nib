import { describe, it, expect } from "vitest";
import { expandTabs } from "./expand-tabs.js";

describe("expandTabs", () => {
  it("pads each tab to the next 8-column stop", () => {
    expect(expandTabs("a\tbc\td")).toBe("a       bc      d");
  });
  it("restarts the column count after a newline", () => {
    expect(expandTabs("abc\n\tx")).toBe("abc\n        x");
  });
  it("gives ANSI escapes and transcript tags no width", () => {
    expect(expandTabs("\u0001\u0002\x1b[31ma\x1b[0m\tb")).toBe("\u0001\u0002\x1b[31ma\x1b[0m       b");
  });
  it("returns text without tabs unchanged", () => {
    expect(expandTabs("no tabs")).toBe("no tabs");
  });
});
