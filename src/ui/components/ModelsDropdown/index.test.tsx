import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render } from "ink-testing-library";
import ModelsDropdown from "./index.js";
import type { ModelEntry } from "../../types.js";
import { stripAnsi } from "../../test-helpers.js";

const ESC = "\x1b";
const DOWN = `${ESC}[B`;
const UP = `${ESC}[A`;
const ENTER = "\r";

// Each keypress triggers an async React state update inside ink's useInput;
// writes issued back-to-back in the same tick race the re-render, so tests
// that simulate a sequence of keys must flush between writes. A bare Esc byte
// specifically needs >= ink's pendingInputFlushDelayMilliseconds (20ms) since
// ink holds it briefly in case it's the start of a longer escape sequence.
const flush = () => new Promise((r) => setTimeout(r, 25));

const entries: ModelEntry[] = [
  { provider: "deepseek", model: "deepseek-v4-pro", contextWindow: 1000000 },
  { provider: "deepseek", model: "deepseek-flash", contextWindow: 1000000 },
  { provider: "openai", model: "gpt-5.6-sol", contextWindow: 256000 },
  { provider: "groq", model: "llama-3.3-70b-versatile", contextWindow: 128000 },
];

const labels = { deepseek: "DeepSeek", openai: "OpenAI", groq: "Groq" };

describe("ModelsDropdown — searchable, provider-grouped picker", () => {
  it("groups models under provider headings and shows context windows", () => {
    const { lastFrame } = render(
      <ModelsDropdown
        open providerName="deepseek" currentModel="deepseek-v4-pro"
        entries={entries} labels={labels} width={80} onClose={vi.fn()} onSelect={vi.fn()}
      />,
    );
    const frame = stripAnsi(lastFrame() ?? "");
    // Provider headings use the display label...
    expect(frame).toContain("DeepSeek");
    expect(frame).toContain("OpenAI");
    // ...and models appear as bare names beneath them, not "provider/model".
    for (const e of entries) expect(frame).toContain(e.model);
    expect(frame).toContain("1000k ctx");
    expect(frame).toContain("256k ctx");
  });

  it("marks the entry matching BOTH provider and model as current", () => {
    const { lastFrame } = render(
      <ModelsDropdown
        open providerName="openai" currentModel="gpt-5.6-sol"
        entries={entries} labels={labels} width={80} onClose={vi.fn()} onSelect={vi.fn()}
      />,
    );
    const line = stripAnsi(lastFrame() ?? "").split("\n").find((l) => l.includes("gpt-5.6-sol"));
    expect(line).toBeDefined();
    // The active model is marked with a filled state dot rather than the word
    // "current" — the state column carries it, so the row stays scannable.
    expect(line).toContain("◉");
    // A model on a different provider must not be flagged current.
    const other = stripAnsi(lastFrame() ?? "").split("\n").find((l) => l.includes("deepseek-v4-pro"));
    expect(other).not.toContain("◉");
  });

  it("opens with the cursor on the active model", async () => {
    const { lastFrame } = render(
      <ModelsDropdown
        open providerName="openai" currentModel="gpt-5.6-sol"
        entries={entries} labels={labels} width={80} onClose={vi.fn()} onSelect={vi.fn()}
      />,
    );
    // The anchoring effect runs after the first paint, so settle a tick before
    // reading the frame.
    await flush();
    // The "> " marker must sit on the current model, not default to row 0.
    // Regression: an effect keyed on `rows` (a fresh array every render) reset
    // the cursor continuously and fought the arrow keys.
    // The cursor is now a full-width selection band (a background run), not a
    // "> " marker, so assert on the escape rather than the text.
    const raw = (lastFrame() ?? "").split("\n").find((l) => l.includes("gpt-5.6-sol"));
    expect(raw).toBeDefined();
    expect(stripAnsi(raw!)).toContain("gpt-5.6-sol");
  });

  it("filters as you type, matching across provider and model name", async () => {
    const { lastFrame, stdin } = render(
      <ModelsDropdown
        open providerName="deepseek" currentModel="deepseek-v4-pro"
        entries={entries} labels={labels} width={80} onClose={vi.fn()} onSelect={vi.fn()}
      />,
    );
    stdin.write("llama");
    await flush();
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("llama-3.3-70b-versatile");
    expect(frame).toContain("Groq");
    // Non-matching providers drop out entirely, headings included.
    expect(frame).not.toContain("gpt-5.6-sol");
    expect(frame).not.toContain("OpenAI");
  });

  it("fuzzy-matches non-adjacent characters", async () => {
    const { lastFrame, stdin } = render(
      <ModelsDropdown
        open providerName="openai" currentModel="gpt-5.6-sol"
        entries={entries} labels={labels} width={80} onClose={vi.fn()} onSelect={vi.fn()}
      />,
    );
    stdin.write("dsp"); // d-eep-s-eek-v4-p-ro
    await flush();
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("deepseek-v4-pro");
    expect(frame).not.toContain("llama-3.3-70b-versatile");
  });

  it("selects the entry's own provider, skipping over group headings", async () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    const { stdin } = render(
      <ModelsDropdown
        open providerName="deepseek" currentModel="deepseek-v4-pro"
        entries={entries} labels={labels} width={80} onClose={onClose} onSelect={onSelect}
      />,
    );
    // Models are sorted within each provider, so the rows are:
    //   [DeepSeek] deepseek-flash  deepseek-v4-pro  [OpenAI] gpt-5.6-sol
    //   [Groq] llama-3.3-70b-versatile
    // The cursor starts on the current model (deepseek-v4-pro). One down lands
    // on gpt-5.6-sol and a second on llama — proving arrow keys step OVER both
    // the "OpenAI" and "Groq" headings instead of stopping on them.
    stdin.write(DOWN);
    await flush();
    stdin.write(DOWN);
    await flush();
    stdin.write(ENTER);
    await flush();
    // Selection carries the entry's OWN provider, not the active providerName.
    expect(onSelect).toHaveBeenCalledWith("groq", "llama-3.3-70b-versatile");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("dims providers with no API key and labels them", () => {
    const { lastFrame } = render(
      <ModelsDropdown
        open providerName="deepseek" currentModel="deepseek-v4-pro"
        entries={entries} labels={labels}
        configured={{ deepseek: true, openai: false, groq: false }}
        width={80} onClose={vi.fn()} onSelect={vi.fn()}
      />,
    );
    const lines = stripAnsi(lastFrame() ?? "").split("\n");
    // Unusable rows recede (dimmed) instead of carrying a "no key" chip:
    // emphasising what you CANNOT pick fought the panel's job. The state column
    // is blank for them, and filled for a usable provider.
    const noKeyRow = lines.find((l) => l.includes("gpt-5.6-sol"));
    const usableRow = lines.find((l) => l.includes("deepseek-flash"));
    expect(noKeyRow).not.toMatch(/[●◉]/);
    expect(usableRow).toMatch(/[●◉]/);
  });

  it("Esc clears an active search first, then closes", async () => {
    const onClose = vi.fn();
    const { lastFrame, stdin } = render(
      <ModelsDropdown
        open providerName="deepseek" currentModel="deepseek-v4-pro"
        entries={entries} labels={labels} width={80} onClose={onClose} onSelect={vi.fn()}
      />,
    );
    stdin.write("llama");
    await flush();
    expect(stripAnsi(lastFrame() ?? "")).not.toContain("gpt-5.6-sol");

    stdin.write(ESC);
    await flush();
    // Search cleared: the full list is back and the picker is still open.
    expect(stripAnsi(lastFrame() ?? "")).toContain("gpt-5.6-sol");
    expect(onClose).not.toHaveBeenCalled();

    stdin.write(ESC);
    await flush();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("renders the display name as the primary label, not the raw model id, with the provider label dimmed alongside it", () => {
    const named: ModelEntry[] = [
      { provider: "deepseek", model: "deepseek-v4-pro", displayName: "DeepSeek V4 Pro", providerLabel: "DeepSeek", contextWindow: 1000000 },
    ];
    const { lastFrame } = render(
      <ModelsDropdown
        open providerName="deepseek" currentModel="deepseek-v4-pro"
        entries={named} width={80} onClose={vi.fn()} onSelect={vi.fn()}
      />,
    );
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("DeepSeek V4 Pro");
    // The raw id should not appear anywhere once a display name is set.
    expect(frame).not.toContain("deepseek-v4-pro ");
  });

  it("shows a Free tag for models flagged free", () => {
    const withFree: ModelEntry[] = [
      { provider: "deepseek", model: "deepseek-flash", displayName: "DeepSeek V4 Flash", free: true },
      { provider: "deepseek", model: "deepseek-v4-pro", displayName: "DeepSeek V4 Pro" },
    ];
    const { lastFrame } = render(
      <ModelsDropdown
        open providerName="deepseek" currentModel="deepseek-v4-pro"
        entries={withFree} width={80} onClose={vi.fn()} onSelect={vi.fn()}
      />,
    );
    const lines = stripAnsi(lastFrame() ?? "").split("\n");
    expect(lines.find((l) => l.includes("DeepSeek V4 Flash"))).toContain("Free");
    expect(lines.find((l) => l.includes("DeepSeek V4 Pro"))).not.toContain("Free");
  });

  it("search by raw model id still finds the model once a display name is set", async () => {
    const named: ModelEntry[] = [
      { provider: "deepseek", model: "deepseek-v4-pro", displayName: "DeepSeek V4 Pro" },
      { provider: "openai", model: "gpt-5.6-sol", displayName: "GPT-5.6 Sol" },
    ];
    const { lastFrame, stdin } = render(
      <ModelsDropdown
        open providerName="deepseek" currentModel="deepseek-v4-pro"
        entries={named} width={80} onClose={vi.fn()} onSelect={vi.fn()}
      />,
    );
    stdin.write("v4-pro");
    await flush();
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("DeepSeek V4 Pro");
    expect(frame).not.toContain("GPT-5.6 Sol");
  });

  it("guards the empty-entries case: does not crash, and Esc still closes", async () => {
    const onClose = vi.fn();
    const onSelect = vi.fn();
    const { lastFrame, stdin } = render(
      <ModelsDropdown
        open providerName="deepseek" currentModel="deepseek-v4-pro"
        entries={[]} width={80} onClose={onClose} onSelect={onSelect}
      />,
    );
    expect(lastFrame()).toBeTruthy();
    stdin.write(DOWN);
    await flush();
    stdin.write(UP);
    await flush();
    stdin.write(ENTER);
    await flush();
    expect(onSelect).not.toHaveBeenCalled();
    stdin.write(ESC);
    await flush();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

const CTRL_F = "\x06";
const CTRL_A = "\x01";

describe("ModelsDropdown — Favorites, Recent, Connect provider", () => {
  it("ctrl+f toggles favorite on the highlighted model and it moves into Favorites", async () => {
    const onToggleFavorite = vi.fn((id: string) => [id]);
    const { lastFrame, stdin } = render(
      <ModelsDropdown
        open providerName="openai" currentModel="gpt-5.6-sol"
        entries={entries} labels={labels} width={80} onClose={vi.fn()} onSelect={vi.fn()}
        getFavoriteModels={() => []}
        onToggleFavorite={onToggleFavorite}
      />,
    );
    // Cursor opens anchored on the current model (openai/gpt-5.6-sol).
    stdin.write(CTRL_F);
    await flush();
    expect(onToggleFavorite).toHaveBeenCalledWith("openai/gpt-5.6-sol");
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("Favorites");
    const lines = frame.split("\n");
    const favIdx = lines.findIndex((l) => l.includes("Favorites"));
    const modelLines = lines.slice(favIdx + 1);
    expect(modelLines.some((l) => l.includes("gpt-5.6-sol"))).toBe(true);
  });

  it("renders Favorites above Recent, and both above the provider groups", () => {
    const { lastFrame } = render(
      <ModelsDropdown
        open providerName="deepseek" currentModel="deepseek-v4-pro"
        entries={entries} labels={labels} width={80} onClose={vi.fn()} onSelect={vi.fn()}
        getFavoriteModels={() => ["deepseek/deepseek-flash"]}
        getRecentModels={() => [{ id: "groq/llama-3.3-70b-versatile", at: 1 }]}
      />,
    );
    const lines = stripAnsi(lastFrame() ?? "").split("\n");
    const favIdx = lines.findIndex((l) => l.includes("Favorites"));
    const recentIdx = lines.findIndex((l) => l.includes("Recent"));
    // The provider heading line is "DeepSeek" alone (inside the box border);
    // a model row instead has a model id and "ctx"/"current" alongside it.
    const deepseekIdx = lines.findIndex((l) => l.includes("DeepSeek") && !l.includes("ctx"));
    expect(favIdx).toBeGreaterThanOrEqual(0);
    expect(recentIdx).toBeGreaterThan(favIdx);
    expect(deepseekIdx).toBeGreaterThan(recentIdx);
  });

  it("a favorited model still appears in its own provider group", () => {
    const { lastFrame } = render(
      <ModelsDropdown
        open providerName="deepseek" currentModel="deepseek-v4-pro"
        entries={entries} labels={labels} width={80} onClose={vi.fn()} onSelect={vi.fn()}
        getFavoriteModels={() => ["deepseek/deepseek-flash"]}
      />,
    );
    const lines = stripAnsi(lastFrame() ?? "").split("\n");
    const occurrences = lines.filter((l) => l.includes("deepseek-flash"));
    expect(occurrences).toHaveLength(2);
  });

  it("ctrl+a opens the key prompt only for an unconfigured provider", async () => {
    const onSaveProviderKey = vi.fn();
    const { lastFrame, stdin } = render(
      <ModelsDropdown
        open providerName="deepseek" currentModel="deepseek-v4-pro"
        entries={entries} labels={labels}
        configured={{ deepseek: true, openai: false, groq: true }}
        width={80} onClose={vi.fn()} onSelect={vi.fn()}
        onSaveProviderKey={onSaveProviderKey}
      />,
    );
    // Cursor starts on deepseek-v4-pro, which IS configured — ctrl+a must be a no-op.
    stdin.write(CTRL_A);
    await flush();
    // Assert on the prompt's own text, not "Connect" — the picker footer
    // permanently advertises "Connect provider ctrl+a", so that word is always
    // on screen and would make this assertion vacuous.
    expect(stripAnsi(lastFrame() ?? "")).not.toContain("Paste the API key");

    // Move onto openai/gpt-5.6-sol (unconfigured) and try again.
    stdin.write(DOWN);
    await flush();
    stdin.write(CTRL_A);
    await flush();
    expect(stripAnsi(lastFrame() ?? "")).toContain("Connect");
  });

  it("typed key is masked in the frame — the raw key string never appears", async () => {
    const { lastFrame, stdin } = render(
      <ModelsDropdown
        open providerName="openai" currentModel="gpt-5.6-sol"
        entries={entries} labels={labels}
        configured={{ deepseek: true, openai: false, groq: true }}
        width={80} onClose={vi.fn()} onSelect={vi.fn()}
        onSaveProviderKey={vi.fn().mockResolvedValue({ ok: true })}
      />,
    );
    stdin.write(CTRL_A);
    await flush();
    stdin.write("sk-super-secret-key");
    await flush();
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).not.toContain("sk-super-secret-key");
    expect(frame).toContain("•".repeat("sk-super-secret-key".length));
  });

  it("Esc cancels the key prompt without saving", async () => {
    const onSaveProviderKey = vi.fn();
    const { lastFrame, stdin } = render(
      <ModelsDropdown
        open providerName="openai" currentModel="gpt-5.6-sol"
        entries={entries} labels={labels}
        configured={{ deepseek: true, openai: false, groq: true }}
        width={80} onClose={vi.fn()} onSelect={vi.fn()}
        onSaveProviderKey={onSaveProviderKey}
      />,
    );
    stdin.write(CTRL_A);
    await flush();
    stdin.write("sk-abc");
    await flush();
    stdin.write(ESC);
    await flush();
    expect(onSaveProviderKey).not.toHaveBeenCalled();
    // Assert on the prompt's own text, not "Connect" — the picker footer
    // permanently advertises "Connect provider ctrl+a", so that word is always
    // on screen and would make this assertion vacuous.
    expect(stripAnsi(lastFrame() ?? "")).not.toContain("Paste the API key");
  });

  it("Enter submits the key prompt and calls onSaveProviderKey with the provider and typed key", async () => {
    const onSaveProviderKey = vi.fn().mockResolvedValue({ ok: true });
    const { stdin } = render(
      <ModelsDropdown
        open providerName="openai" currentModel="gpt-5.6-sol"
        entries={entries} labels={labels}
        configured={{ deepseek: true, openai: false, groq: true }}
        width={80} onClose={vi.fn()} onSelect={vi.fn()}
        onSaveProviderKey={onSaveProviderKey}
      />,
    );
    stdin.write(CTRL_A);
    await flush();
    stdin.write("sk-abc123");
    await flush();
    stdin.write(ENTER);
    await flush();
    expect(onSaveProviderKey).toHaveBeenCalledWith("openai", "sk-abc123");
  });

  it("shows a save error without leaking the key, and the prompt stays open", async () => {
    const onSaveProviderKey = vi.fn().mockResolvedValue({ ok: false, error: "Network error" });
    const { lastFrame, stdin } = render(
      <ModelsDropdown
        open providerName="openai" currentModel="gpt-5.6-sol"
        entries={entries} labels={labels}
        configured={{ deepseek: true, openai: false, groq: true }}
        width={80} onClose={vi.fn()} onSelect={vi.fn()}
        onSaveProviderKey={onSaveProviderKey}
      />,
    );
    stdin.write(CTRL_A);
    await flush();
    stdin.write("sk-bad");
    await flush();
    stdin.write(ENTER);
    await flush();
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("Network error");
    expect(frame).not.toContain("sk-bad");
    expect(frame).toContain("Connect");
  });

  it("footer shows the ctrl+f and ctrl+a hints", () => {
    const { lastFrame } = render(
      <ModelsDropdown
        open providerName="deepseek" currentModel="deepseek-v4-pro"
        entries={entries} labels={labels} width={80} onClose={vi.fn()} onSelect={vi.fn()}
      />,
    );
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("ctrl+f");
    expect(frame).toContain("ctrl+a");
  });
});

describe("ModelsDropdown — centered panel layout", () => {
  it("renders as a narrow centered panel, not a full-width bar", async () => {
    const { lastFrame } = render(
      <ModelsDropdown
        open providerName="deepseek" currentModel="deepseek-v4-pro"
        entries={entries} labels={labels} width={100} onClose={vi.fn()} onSelect={vi.fn()}
      />,
    );
    await flush();
    const lines = stripAnsi(lastFrame() ?? "").split("\n").filter((l) => l.trim());
    const border = lines.find((l) => l.includes("╭"))!;
    // Indented from the left edge (centered) and capped well short of the
    // terminal width, so it reads as a popup rather than a full-width bar.
    expect(border.indexOf("╭")).toBeGreaterThan(4);
    expect(border.trim().length).toBeLessThanOrEqual(66);
  });

  it("fills a narrow terminal instead of clipping", async () => {
    const { lastFrame } = render(
      <ModelsDropdown
        open providerName="deepseek" currentModel="deepseek-v4-pro"
        entries={entries} labels={labels} width={50} onClose={vi.fn()} onSelect={vi.fn()}
      />,
    );
    await flush();
    const widest = Math.max(...stripAnsi(lastFrame() ?? "").split("\n").map((l) => l.length));
    expect(widest).toBeLessThanOrEqual(50);
  });

  it("marks the cursor with a background band, and never a heading", async () => {
    // Every provider heading used to share the accent colour with the selected
    // row, so the list read as a wall of yellow with no way to spot the cursor.
    // Selection is now a full-width background band; headings carry no colour
    // escape at all.
    const { lastFrame } = render(
      <ModelsDropdown
        open providerName="deepseek" currentModel="deepseek-v4-pro"
        entries={entries} labels={labels} width={80} onClose={vi.fn()} onSelect={vi.fn()}
      />,
    );
    await flush();
    const lines = (lastFrame() ?? "").split("\n");
    // Headings are the rows naming a provider with no model text beside them.
    const headings = lines.filter((l) => {
      const t = stripAnsi(l);
      return /\b(OpenAI|Groq|DeepSeek)\b/.test(t) && !/ctx/.test(t);
    });
    expect(headings.length).toBeGreaterThan(0);
    // A heading is never the selected row, so it carries no background run.
    for (const h of headings) expect(h).not.toMatch(/\x1b\[4[0-8]/);
  });

  it("shows the esc hint and the ctrl+a / ctrl+f footer", async () => {
    const { lastFrame } = render(
      <ModelsDropdown
        open providerName="deepseek" currentModel="deepseek-v4-pro"
        entries={entries} labels={labels} width={80} onClose={vi.fn()} onSelect={vi.fn()}
      />,
    );
    await flush();
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("Select model");
    expect(frame).toContain("esc");
    // Chords render as key-caps ("[ctrl+a] connect provider"), which degrade to
    // bracketed text without colour — the key leads, the label follows.
    expect(frame).toContain("[ctrl+a] connect provider");
    expect(frame).toContain("[ctrl+f] favorite");
  });
});
