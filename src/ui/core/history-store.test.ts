import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadPromptHistory, appendPromptHistory, historyFilePath, HISTORY_CAP,
} from "./history-store.js";

const CWD = "/Users/someone/projects/demo-app";
const tmp = () => mkdtempSync(join(tmpdir(), "nib-hist-"));

describe("prompt history store", () => {
  it("returns empty for a missing file instead of throwing", () => {
    expect(loadPromptHistory(CWD, tmp())).toEqual([]);
  });

  it("round-trips entries in order across append and load", async () => {
    const base = tmp();
    await appendPromptHistory(CWD, "first prompt", base);
    await appendPromptHistory(CWD, "/model", base);
    expect(loadPromptHistory(CWD, base)).toEqual(["first prompt", "/model"]);
  });

  it("preserves multiline entries exactly (why the format is JSONL)", async () => {
    const base = tmp();
    const entry = "line one\nline two\n  indented";
    await appendPromptHistory(CWD, entry, base);
    expect(loadPromptHistory(CWD, base)).toEqual([entry]);
  });

  it("skips a corrupt line without losing the rest of the file", async () => {
    const base = tmp();
    await appendPromptHistory(CWD, "good one", base);
    const file = historyFilePath(CWD, base);
    writeFileSync(file, readFileSync(file, "utf-8") + "{not json\n");
    await appendPromptHistory(CWD, "good two", base);
    expect(loadPromptHistory(CWD, base)).toEqual(["good one", "good two"]);
  });

  it("caps the load and compacts an oversized file down to the cap", () => {
    const base = tmp();
    const file = historyFilePath(CWD, base);
    const many = Array.from({ length: 2500 }, (_, i) => JSON.stringify(`entry ${i}`));
    mkdirSync(join(base, "prompt_history"), { recursive: true });
    writeFileSync(file, many.join("\n") + "\n");

    const loaded = loadPromptHistory(CWD, base);
    expect(loaded).toHaveLength(HISTORY_CAP);
    expect(loaded[HISTORY_CAP - 1]).toBe("entry 2499");
    expect(loaded[0]).toBe("entry 1500");
    // The file itself was rewritten, so the append path never pays for it.
    const rawLines = readFileSync(file, "utf-8").split("\n").filter(Boolean);
    expect(rawLines).toHaveLength(HISTORY_CAP);
  });

  it("keys the file per project directory, matching the sessions convention", () => {
    expect(historyFilePath("/a/b c", "/base")).toBe("/base/prompt_history/-a-b-c.jsonl");
  });
});
