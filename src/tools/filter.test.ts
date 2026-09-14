import { describe, it, expect } from "vitest";
import type { ToolDef } from "../types.js";
import { filterToolDefs } from "./filter.js";

const def = (name: string): ToolDef => ({
  name,
  description: name,
  parameters: { type: "object", properties: {}, required: [] },
});

const defs = [def("read_file"), def("edit"), def("run_bash")];

describe("filterToolDefs", () => {
  it("passes everything through when both filters are empty/undefined", () => {
    expect(filterToolDefs(defs, undefined, undefined)).toEqual(defs);
    expect(filterToolDefs(defs, [], [])).toEqual(defs);
  });

  it("applies an allowlist, dropping everything not named", () => {
    expect(filterToolDefs(defs, ["read_file", "edit"], undefined).map((d) => d.name)).toEqual([
      "read_file",
      "edit",
    ]);
  });

  it("applies a denylist on top of the full set", () => {
    expect(filterToolDefs(defs, undefined, ["run_bash"]).map((d) => d.name)).toEqual([
      "read_file",
      "edit",
    ]);
  });

  it("applies the denylist after the allowlist", () => {
    expect(
      filterToolDefs(defs, ["read_file", "run_bash"], ["run_bash"]).map((d) => d.name),
    ).toEqual(["read_file"]);
  });
});
