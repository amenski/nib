import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import type { ModelEntry } from "../../types.js";
import { useTheme } from "../../contexts.js";
import { ansi256, type ThemeContextValue } from "../../theme.js";
import { keyCap } from "../../core/chips.js";
import { computeColumns, fit, fitRight, COLUMN_GAP } from "../../core/picker-columns.js";
import {
  buildRows,
  moveSelection,
  selectableIndices,
  formatContext,
  toModelId,
  type PickerRow,
} from "../../core/model-picker.js";

/** Resolve a semantic theme slot to an Ink color string, honoring the color gate. */
function slotColor(theme: ThemeContextValue, key: keyof ThemeContextValue["theme"]): string | undefined {
  if (!theme.colorEnabled) return undefined;
  return ansi256(theme.theme[key] as number);
}

interface Props {
  open: boolean;
  providerName: string;
  currentModel: string | undefined;
  entries: ModelEntry[];
  /** Provider name -> whether an API key is resolvable. Unconfigured ones are dimmed. */
  configured?: Record<string, boolean>;
  /** Re-fetch the configured map live (e.g. after a Connect-provider save). Falls back to `configured`. */
  getConfigured?: () => Record<string, boolean>;
  /** Display names for providers (deepseek -> DeepSeek). */
  labels?: Record<string, string>;
  /** Provider name -> the env var its API key comes from (deepseek -> DEEPSEEK_API_KEY), for the Connect-provider prompt. */
  keyEnvByProvider?: Record<string, string>;
  /** "provider/model" ids currently favorited. */
  getFavoriteModels?: () => string[];
  /** Toggle a model's favorite status, persist it, and return the new list. */
  onToggleFavorite?: (id: string) => string[];
  /** Recently-switched-to models, newest first. */
  getRecentModels?: () => { id: string; at: number }[];
  /** Save an API key for a provider from the inline Connect-provider prompt. */
  onSaveProviderKey?: (provider: string, key: string) => Promise<{ ok: boolean; error?: string }>;
  width: number;
  height?: number;
  onClose: () => void;
  onSelect: (provider: string, model: string) => void;
}

/**
 * Searchable model picker: type to fuzzy-filter across provider and model name,
 * with results grouped under provider headings.
 *
 * Rows are a flat list where headers are display-only; navigation steps over
 * them via selectableIndices/moveSelection so arrow keys only ever land on a
 * real model. Matching/grouping lives in ../../core/model-picker.js so the
 * rules stay unit-testable apart from rendering.
 */
const ModelsDropdown: React.FC<Props> = ({
  open, providerName, currentModel, entries, configured, getConfigured, labels, keyEnvByProvider,
  getFavoriteModels, onToggleFavorite, getRecentModels, onSaveProviderKey,
  width, height = 24, onClose, onSelect,
}) => {
  const theme = useTheme();
  const accent = slotColor(theme, "accent");
  // The theme's dedicated selection slot — not `surface`, which is only a hair
  // above `background` in the grey ramp and made the band vanish on a near-black
  // terminal (and worse in the midnight theme, where the two are adjacent).
  const selectionBg = slotColor(theme, "selection");
  const stateColor = slotColor(theme, "success");
  const capStyle = {
    fg: theme.theme.textDim,
    bg: theme.theme.border,
    colorEnabled: theme.colorEnabled,
  };
  const borderColor = slotColor(theme, "border");

  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(-1);
  const [scrollOffset, setScrollOffset] = useState(0);
  const queryRef = useRef("");

  // Local, refreshable copies of the live settings the picker annotates rows
  // with. Seeded from the getters on open/prop change and re-pulled after an
  // action (favorite toggle, key save) so the picker never renders a stale
  // snapshot — re-reading a getter is the whole point of passing one instead
  // of only a static prop.
  const [liveConfigured, setLiveConfigured] = useState<Record<string, boolean> | undefined>(
    () => getConfigured?.() ?? configured,
  );
  const [favorites, setFavorites] = useState<string[]>(() => getFavoriteModels?.() ?? []);
  const [recents, setRecents] = useState<{ id: string; at: number }[]>(() => getRecentModels?.() ?? []);

  useEffect(() => {
    if (!open) return;
    setLiveConfigured(getConfigured?.() ?? configured);
    setFavorites(getFavoriteModels?.() ?? []);
    setRecents(getRecentModels?.() ?? []);
    // Only re-seed when the picker (re)opens — actions taken while open refresh
    // these explicitly instead, so typing/navigating doesn't churn them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Inline "Connect provider" key entry: which provider it's for (undefined =
  // closed), the typed key (kept in a ref, never in rendered state — see the
  // security note above the render for why), and a status message.
  const [keyPromptProvider, setKeyPromptProvider] = useState<string | undefined>(undefined);
  const [keyPromptLength, setKeyPromptLength] = useState(0);
  const [keyPromptError, setKeyPromptError] = useState<string | undefined>(undefined);
  const keyInputRef = useRef("");

  const rows = useMemo(
    () => buildRows({
      entries, query, currentProvider: providerName, currentModel,
      configured: liveConfigured, labels, favoriteModels: favorites, recentModels: recents,
    }),
    [entries, query, providerName, currentModel, liveConfigured, labels, favorites, recents],
  );

  // Render as a centered panel rather than a full-width bar: on a wide terminal
  // a 100-column list of short model names is unreadable, and the modal reads
  // as a popup when it is narrower than the screen. Falls back to the full width
  // on narrow terminals so nothing is clipped. (Ink can position absolutely, but
  // it composites rather than occludes — the transcript bleeds through and rows
  // interleave — so this centers within the layout flow instead.)
  const PANEL_MAX_WIDTH = 64;
  const panelWidth = Math.min(width, PANEL_MAX_WIDTH);

  // Anchor the cursor while rendering rather than in an effect. An effect keyed
  // on `rows` re-fires every render (rows is a fresh array) and fights the
  // arrow keys; keying it on `query` alone reads `rows` from a stale closure.
  // Deriving it here keeps the cursor valid for the rows actually on screen:
  // with no query it sits on the active model, while filtering it sits on the
  // top hit so Enter takes the obvious match.
  const selectable = useMemo(() => selectableIndices(rows), [rows]);
  const anchored = useMemo(() => {
    if (selectable.length === 0) return -1;
    if (!query) {
      const currentIdx = rows.findIndex((r) => r.kind === "model" && r.current);
      if (currentIdx >= 0) return currentIdx;
    }
    return selectable[0];
  }, [rows, selectable, query]);

  // `cursor` is -1 until the user moves; -1 means "wherever anchoring says".
  const effectiveCursor = cursor >= 0 && selectable.includes(cursor) ? cursor : anchored;

  // Drop a stale cursor when the query changes so the next arrow key steps from
  // the visible anchor instead of a row that has been filtered away.
  useEffect(() => {
    setCursor(-1);
  }, [query, open]);

  const pageSize = Math.max(4, height - 8);

  useEffect(() => {
    if (effectiveCursor < 0) return;
    if (effectiveCursor < scrollOffset) setScrollOffset(effectiveCursor);
    else if (effectiveCursor >= scrollOffset + pageSize) setScrollOffset(effectiveCursor - pageSize + 1);
  }, [effectiveCursor, pageSize, scrollOffset]);

  function selectItem(): void {
    const row = rows[effectiveCursor];
    if (!row || row.kind !== "model") return;
    onSelect(row.provider, row.model);
    onClose();
  }

  function closeKeyPrompt(): void {
    keyInputRef.current = "";
    setKeyPromptLength(0);
    setKeyPromptError(undefined);
    setKeyPromptProvider(undefined);
  }

  async function submitKeyPrompt(): Promise<void> {
    const provider = keyPromptProvider;
    const key = keyInputRef.current;
    if (!provider || !key || !onSaveProviderKey) return;
    const result = await onSaveProviderKey(provider, key);
    if (!result.ok) {
      setKeyPromptError(result.error ?? "Failed to save key.");
      return;
    }
    closeKeyPrompt();
    // The "no key" marker must clear without restarting — re-read live rather
    // than trust the snapshot taken when the picker opened.
    setLiveConfigured(getConfigured?.() ?? configured);
  }

  useInput(
    (input, key) => {
      if (!open) return;

      // ── Inline Connect-provider key entry owns all input while it's open ──
      if (keyPromptProvider !== undefined) {
        if (key.escape) { closeKeyPrompt(); return; }
        if (key.return) { void submitKeyPrompt(); return; }
        if (key.backspace || key.delete) {
          if (keyInputRef.current) {
            keyInputRef.current = keyInputRef.current.slice(0, -1);
            setKeyPromptLength(keyInputRef.current.length);
          }
          return;
        }
        if (input && !key.ctrl && !key.meta) {
          // eslint-disable-next-line no-control-regex
          const printable = input.replace(/[\x00-\x1f\x7f]/g, "");
          if (!printable) return;
          // The key is held ONLY in this ref — never in React state, so it
          // never reaches a render and can never appear in a frame or an
          // error message. Rendered feedback is the length counter below.
          keyInputRef.current += printable;
          setKeyPromptLength(keyInputRef.current.length);
        }
        return;
      }

      if (key.escape) {
        // First Esc clears an active search, second closes — same as SkillList.
        if (queryRef.current) {
          queryRef.current = "";
          setQuery("");
          setScrollOffset(0);
          return;
        }
        onClose();
        return;
      }
      if (key.ctrl && input === "f") {
        const row = rows[effectiveCursor];
        if (row?.kind === "model" && onToggleFavorite) {
          setFavorites(onToggleFavorite(toModelId(row.provider, row.model)));
        }
        return;
      }
      if (key.ctrl && input === "a") {
        const row = rows[effectiveCursor];
        if (row?.kind === "model" && !row.configured) {
          keyInputRef.current = "";
          setKeyPromptLength(0);
          setKeyPromptError(undefined);
          setKeyPromptProvider(row.provider);
        }
        return;
      }
      // Step from effectiveCursor so the first arrow key moves relative to the
      // row the user can see highlighted, not from an unset -1.
      if (key.upArrow) { setCursor(moveSelection(rows, effectiveCursor, -1)); return; }
      if (key.downArrow) { setCursor(moveSelection(rows, effectiveCursor, 1)); return; }
      if (key.return) { selectItem(); return; }
      if (key.tab) { onClose(); return; }
      if (key.backspace || key.delete) {
        if (queryRef.current) {
          queryRef.current = queryRef.current.slice(0, -1);
          setQuery(queryRef.current);
          setScrollOffset(0);
        }
        return;
      }
      // Space is a search character here, not a selector — the list is
      // filterable, so typing must take precedence.
      //
      // Do NOT gate on input.length === 1: a fast typist or a paste arrives as
      // one multi-character chunk, and requiring a single char silently drops
      // it. Filter out control bytes instead and append whatever printable
      // text came through.
      if (input && !key.ctrl && !key.meta) {
        // eslint-disable-next-line no-control-regex
        const printable = input.replace(/[\x00-\x1f\x7f]/g, "");
        if (!printable) return;
        queryRef.current += printable;
        setQuery(queryRef.current);
        setScrollOffset(0);
        return;
      }
    },
    { isActive: open },
  );

  if (!open) return null;

  // ── Inline Connect-provider key entry replaces the list while open ──
  // SECURITY: the typed key lives only in keyInputRef (never React state), so
  // it is never part of what renders here — this box shows a length-only
  // masked placeholder, never the characters themselves, and keyPromptError
  // is always a static message (never interpolates the key).
  if (keyPromptProvider !== undefined) {
    const providerLabel = labels?.[keyPromptProvider] ?? keyPromptProvider;
    const envVar = keyEnvByProvider?.[keyPromptProvider];
    const masked = "•".repeat(keyPromptLength);
    return (
      <Box justifyContent="center" width={width} marginY={1}>
      <Box flexDirection="column" borderStyle="round" borderColor={borderColor} paddingX={1} width={panelWidth}>
        <Box marginBottom={1}>
          <Text color={accent} bold>Connect {providerLabel}</Text>
        </Box>
        <Text dimColor>
          Paste the API key for {providerLabel}{envVar ? ` (${envVar})` : ""}:
        </Text>
        <Box marginTop={1}>
          <Text>{masked || "…"}</Text>
        </Box>
        {keyPromptError && (
          <Box marginTop={1}>
            <Text color="red">{keyPromptError}</Text>
          </Box>
        )}
        <Box marginTop={1}>
          <Text dimColor>Enter save · Esc cancel</Text>
        </Box>
      </Box>
      </Box>
    );
  }

  const visible = rows.slice(scrollOffset, scrollOffset + pageSize);
  const hiddenAbove = scrollOffset;
  const hiddenBelow = Math.max(0, rows.length - scrollOffset - pageSize);
  // Column widths come from the whole row set (not each row) so every field
  // lines up vertically — that is what turns the list into a table.
  const cols = computeColumns(
    rows
      .filter((r): r is Extract<PickerRow, { kind: "model" }> => r.kind === "model")
      .map((r) => ({
        label: r.free ? `${r.label} · Free` : r.label,
        providerLabel: r.providerLabel,
        ctx: formatContext(r.contextWindow) ?? "",
      })),
    // interior width: panel minus its border and paddingX, minus the 2-col indent
    panelWidth - 4 - 2,
  );

  return (
    <Box justifyContent="center" width={width} marginY={1}>
      <Box flexDirection="column" borderStyle="round" borderColor={borderColor} paddingX={1} width={panelWidth}>
      <Box marginBottom={1} justifyContent="space-between">
        <Text bold>Select model</Text>
        <Text dimColor>esc</Text>
      </Box>
      {/* A bordered field reads as something you type into, rather than a
          label with text after it. */}
      <Box marginBottom={1} borderStyle="round" borderDimColor paddingX={1}>
        <Text dimColor>{"⌕ "}</Text>
        <Text>{query || ""}</Text>
        {!query && <Text dimColor>Search…</Text>}
      </Box>

      {rows.length === 0 ? (
        <Text dimColor>No models match "{query}".</Text>
      ) : (
        <Box flexDirection="column">
          {hiddenAbove > 0 && <Text dimColor>{`  ... (${hiddenAbove} more above) ...`}</Text>}
          {visible.map((row, i) => {
            const idx = scrollOffset + i;
            if (row.kind === "header") {
              return (
                <Box key={`h:${row.provider}`} marginTop={i === 0 ? 0 : 1}>
                  {/* Headers are quiet labels, not accents: every provider name
                      in the accent colour made the list read as a wall of
                      yellow with no way to find the cursor. Weight alone
                      separates a group from its rows. */}
                  <Text dimColor bold>{row.label}</Text>
                </Box>
              );
            }
            if (row.kind === "hint") {
              // Non-selectable, same as a header — selectableIndices/moveSelection
              // already only ever land on "model" rows, so this is skipped by
              // navigation for free.
              return (
                <Box key={`hint:${row.provider}`}>
                  <Text dimColor>{"  " + row.label}</Text>
                </Box>
              );
            }
            const isSelected = idx === effectiveCursor;
            const ctx = formatContext(row.contextWindow) ?? "";
            // A row whose provider has no key is unusable, so the whole row
            // recedes rather than being tagged. Emphasising what you CANNOT
            // pick (a chip per unusable row) fought the panel's actual job.
            const unusable = !row.configured;
            // Fixed columns: provider / ctx / state each sit at the same x on
            // every row, so the list scans as a table instead of a sentence.
            // "Free" is pricing information, not state — it belongs with the
            // model name rather than in the state column.
            const labelText = row.free ? `${row.label} · Free` : row.label;
            const body =
              "  " + fit(labelText, cols.label) +
              " ".repeat(COLUMN_GAP) + fit(row.providerLabel ?? "", cols.provider) +
              " ".repeat(COLUMN_GAP) + fitRight(ctx, cols.ctx) +
              " ".repeat(COLUMN_GAP);
            // Trailing state marker: a dot for a usable provider, blank
            // otherwise. Quieter than repeating "ready" on every row, and it
            // reads as a column of its own.
            const state = row.current ? "◉" : unusable ? " " : "●";
            return (
              <Box key={`${row.group}:${row.provider}/${row.model}`}>
                <Text
                  backgroundColor={isSelected ? selectionBg : undefined}
                  color={isSelected ? accent : undefined}
                  bold={isSelected}
                  dimColor={!isSelected && unusable}
                >
                  {body}
                </Text>
                <Text
                  backgroundColor={isSelected ? selectionBg : undefined}
                  color={!unusable ? stateColor : undefined}
                  dimColor={unusable}
                >
                  {state}
                </Text>
              </Box>
            );
          })}
          {hiddenBelow > 0 && <Text dimColor>{`  ... (${hiddenBelow} more below) ...`}</Text>}
        </Box>
      )}

      {/* Same key-cap treatment as the main hint bar, so a chord looks like a
          chord everywhere in the UI rather than only in the composer. */}
      <Box marginTop={1}>
        <Text>{keyCap("ctrl+a", capStyle)}</Text>
        <Text dimColor>{" connect provider   "}</Text>
        <Text>{keyCap("ctrl+f", capStyle)}</Text>
        <Text dimColor>{" favorite"}</Text>
      </Box>
      </Box>
    </Box>
  );
};

export default ModelsDropdown;
