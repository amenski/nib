import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render } from "ink-testing-library";
import SearchPicker, { filterPickerItems, type SearchPickerItem } from "./SearchPicker.js";
import { __resetInputWireForTests } from "../hooks/useTerminalInput.js";
import { stripAnsi } from "../test-helpers.js";

const ESC = "\x1b";
const ENTER = "\r";
const DOWN = "\x1b[B";

const items: SearchPickerItem[] = [
  { id: "deepseek", label: "DeepSeek", detail: "built-in" },
  { id: "alibaba", label: "Alibaba", detail: "alibaba · dashscope-intl.aliyuncs.com" },
  { id: "alibaba-coding-plan", label: "Alibaba Coding Plan", detail: "alibaba-coding-plan · coding-intl.dashscope.aliyuncs.com" },
  { id: "fireworks", label: "Fireworks AI" },
  { id: ":custom", label: "Custom URL…", pinned: true },
];

const mounted: Array<{ unmount: () => void }> = [];
// Ink batches fast keypresses into a re-render; 60ms settles (see SkillList.test).
const flush = () => new Promise((r) => setTimeout(r, 60));

afterEach(() => {
  while (mounted.length) mounted.pop()!.unmount();
  __resetInputWireForTests();
});

function setup(onSelect = vi.fn(), onCancel = vi.fn()) {
  const inst = render(
    <SearchPicker title="Connect a provider" items={items} onSelect={onSelect} onCancel={onCancel} width={80} height={24} />,
  );
  mounted.push(inst);
  return { ...inst, onSelect, onCancel };
}

describe("filterPickerItems", () => {
  const ids = (q: string) => filterPickerItems(items, q).map((i) => i.id);

  it("matches every term against id or label and keeps pinned rows last", () => {
    expect(ids("alibaba coding")).toEqual(["alibaba-coding-plan", ":custom"]);
    expect(ids("Fireworks ai")).toEqual(["fireworks", ":custom"]);
    expect(ids("zzz")).toEqual([":custom"]);
  });

  it("lists everything, pinned last, with no query", () => {
    expect(ids("")).toEqual(["deepseek", "alibaba", "alibaba-coding-plan", "fireworks", ":custom"]);
  });
});

describe("SearchPicker", () => {
  it("shows the full list before anything is typed", () => {
    const frame = stripAnsi(setup().lastFrame() ?? "");
    for (const i of items) expect(frame).toContain(i.label);
  });

  it("typing filters, Enter picks the top match", async () => {
    const { stdin, lastFrame, onSelect } = setup();
    stdin.write("alibaba coding");
    await flush();
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("Alibaba Coding Plan");
    expect(frame).not.toContain("DeepSeek");
    stdin.write(ENTER);
    await flush();
    expect(onSelect).toHaveBeenCalledWith("alibaba-coding-plan");
  });

  it("arrow keys move the selection", async () => {
    const { stdin, onSelect } = setup();
    stdin.write(DOWN);
    await flush();
    stdin.write(ENTER);
    await flush();
    expect(onSelect).toHaveBeenCalledWith("alibaba");
  });

  it("Esc clears the search first, then cancels", async () => {
    const { stdin, lastFrame, onCancel } = setup();
    stdin.write("fire");
    await flush();
    stdin.write(ESC);
    await flush();
    expect(stripAnsi(lastFrame() ?? "")).toContain("DeepSeek");
    expect(onCancel).not.toHaveBeenCalled();
    stdin.write(ESC);
    await flush();
    expect(onCancel).toHaveBeenCalled();
  });
});
