import React from "react";
import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import OutputArea from "./OutputArea.js";
import { BULLET_TAG, ANSWER_CONT_TAG } from "./constants.js";
import { stripAnsi } from "./test-helpers.js";

describe("answer block gutter (2026-10-10)", () => {
  it("indents every later line of an answer block under the text after the bullet", () => {
    const lines = [BULLET_TAG + "First paragraph.", "", ANSWER_CONT_TAG + "Second paragraph."];
    const { lastFrame } = render(<OutputArea lines={lines} activeLine="" busy={false} staticEpoch={0} />);
    const rows = stripAnsi(lastFrame() ?? "").split("\n");
    expect(rows.find((r) => r.includes("First"))).toMatch(/^● First paragraph\./);
    expect(rows.find((r) => r.includes("Second"))).toMatch(/^ {2}Second paragraph\./);
  });

  it("keeps wrapped rows of a long answer line inside the gutter", () => {
    const long = "word ".repeat(60).trim();
    const { lastFrame } = render(<OutputArea lines={[ANSWER_CONT_TAG + long]} activeLine="" busy={false} staticEpoch={0} />);
    const rows = stripAnsi(lastFrame() ?? "").split("\n").filter((r) => r.includes("word"));
    expect(rows.length).toBeGreaterThan(1);
    for (const r of rows) expect(r.startsWith("  word") || r.startsWith("   word")).toBe(true);
  });
});
