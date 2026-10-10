import { describe, it, expect } from "vitest";
import { groupTableLines, splitCommittable } from "./table-group.js";

const TABLE = ["| a | b |", "| - | - |", "| 1 | 2 |"];

describe("groupTableLines", () => {
  it("merges a run of consecutive table lines into one entry", () => {
    const out = groupTableLines(TABLE);
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(TABLE.join("\n"));
  });

  it("leaves non-table pipe lines separate", () => {
    // A single "|"-prefixed line, or a run that never forms a valid
    // separator row, is not a table — isTableBlock rejects it.
    const lines = ["| just some | piped text |", "not a table at all"];
    expect(groupTableLines(lines)).toEqual(lines);
  });

  it("handles mixed content: prose, a table, then more prose", () => {
    const lines = ["intro line", ...TABLE, "outro line"];
    const out = groupTableLines(lines);
    expect(out).toEqual(["intro line", TABLE.join("\n"), "outro line"]);
  });

  it("returns an empty array for empty input", () => {
    expect(groupTableLines([])).toEqual([]);
  });
});

/**
 * Guards the flush-time holdback in App.tsx's flushOutputQueue: a non-final
 * flush must never commit an open (possibly still-streaming) table run, or a
 * table whose rows arrive across multiple timer flushes would be split into
 * several committed entries instead of merging into one.
 */
describe("splitCommittable", () => {
  it("commits everything on a final flush, regardless of trailing pipes", () => {
    const queue = ["prose", ...TABLE];
    expect(splitCommittable(queue, true)).toEqual({ commit: queue, hold: [] });
  });

  it("holds back a trailing run of pipe-prefixed lines on a non-final flush", () => {
    const queue = ["prose", "| a | b |", "| - | - |"];
    expect(splitCommittable(queue, false)).toEqual({
      commit: ["prose"],
      hold: ["| a | b |", "| - | - |"],
    });
  });

  it("commits everything when nothing trails with a pipe", () => {
    const queue = ["one", "two", "three"];
    expect(splitCommittable(queue, false)).toEqual({ commit: queue, hold: [] });
  });

  it("holds back the whole queue when every line is pipe-prefixed", () => {
    expect(splitCommittable(TABLE, false)).toEqual({ commit: [], hold: TABLE });
  });

  it("simulates streaming a table across multiple timer flushes, committing one merged entry", () => {
    // Row 1 arrives, flush: held back entirely (single pipe line).
    let queue: string[] = ["| a | b |"];
    let { commit, hold } = splitCommittable(queue, false);
    expect(groupTableLines(commit)).toEqual([]);

    // Row 2 (separator) arrives and appends to the held-back tail, flush again.
    queue = [...hold, "| - | - |"];
    ({ commit, hold } = splitCommittable(queue, false));
    expect(groupTableLines(commit)).toEqual([]);

    // Row 3 arrives, then the turn ends (final flush) — everything commits as
    // exactly one grouped table entry.
    queue = [...hold, "| 1 | 2 |"];
    ({ commit, hold } = splitCommittable(queue, true));
    expect(hold).toEqual([]);
    expect(groupTableLines(commit)).toEqual([TABLE.join("\n")]);
  });

  it("commits an open table run on a final flush even mid-stream", () => {
    const queue = ["| a | b |", "| - | - |"];
    const { commit, hold } = splitCommittable(queue, true);
    expect(hold).toEqual([]);
    // Only one row plus a separator — not enough to pass isTableBlock's
    // 2-line-minimum-with-separator check on its own merge path, but still
    // committed verbatim since nothing is held back on a final flush.
    expect(commit).toEqual(queue);
  });
});

describe("answer-block tags (2026-10-10)", () => {
  it("groups table rows behind BULLET_TAG / ANSWER_CONT_TAG and keeps the first row's tag", async () => {
    const { BULLET_TAG, ANSWER_CONT_TAG } = await import("../constants.js");
    const tagged = [BULLET_TAG + TABLE[0], ANSWER_CONT_TAG + TABLE[1], ANSWER_CONT_TAG + TABLE[2]];
    expect(groupTableLines(tagged)).toEqual([BULLET_TAG + TABLE.join("\n")]);
    expect(splitCommittable(tagged, false)).toEqual({ commit: [], hold: tagged });
  });
});
