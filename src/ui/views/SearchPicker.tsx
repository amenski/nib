import React, { useState, useMemo, useRef, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import { useTheme } from "../contexts.js";
import { fit, COLUMN_GAP } from "../core/picker-columns.js";
import { keyCap } from "../core/chips.js";
import { slotColor } from "../theme.js";
import { fuzzyScore } from "../core/fuzzy.js";

export interface SearchPickerItem {
  id: string;
  label: string;
  /** Dim second column; not searched. */
  detail?: string;
  /** Always listed last, whatever the query (e.g. "Custom URL…"). */
  pinned?: boolean;
}

/**
 * Items matching every whitespace-separated term of `query` (fuzzy, against
 * id and label), tightest match first; pinned items always follow. So
 * "alibaba coding" finds alibaba-coding-plan.
 */
export function filterPickerItems(items: SearchPickerItem[], query: string): SearchPickerItem[] {
  const pinned = items.filter((i) => i.pinned);
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [...items.filter((i) => !i.pinned), ...pinned];
  const scored: Array<{ item: SearchPickerItem; score: number }> = [];
  for (const item of items) {
    if (item.pinned) continue;
    const hay = `${item.id} ${item.label}`;
    let score = 0;
    for (const t of terms) {
      const s = fuzzyScore(hay, t);
      if (s === null) { score = -1; break; }
      score += s;
    }
    if (score >= 0) scored.push({ item, score });
  }
  scored.sort((a, b) => a.score - b.score);
  return [...scored.map((x) => x.item), ...pinned];
}

interface Props {
  title: string;
  items: SearchPickerItem[];
  /** Item highlighted before the user types or moves (defaults to the first). */
  initialId?: string;
  onSelect: (id: string) => void;
  onCancel: () => void;
  width: number;
  height: number;
}

/**
 * Standalone type-to-filter list, for flows outside the main TUI (`nib auth`).
 * Same keys as /skills and /model: type to search, ↑↓ move, Enter select,
 * Esc clears the search then cancels.
 */
export default function SearchPicker({ title, items, initialId, onSelect, onCancel, width, height }: Props) {
  const theme = useTheme();
  const accent = slotColor(theme, "accent");
  const borderColor = slotColor(theme, "border");
  const selectionBg = slotColor(theme, "selection");
  const dim = slotColor(theme, "textDim");
  const [searchText, setSearchText] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(() => Math.max(0, items.findIndex((i) => i.id === initialId)));
  const [scrollOffset, setScrollOffset] = useState(0);
  const searchRef = useRef("");

  const filtered = useMemo(() => filterPickerItems(items, searchText), [items, searchText]);

  const pageSize = Math.max(4, height - 9);
  const safeIndex = Math.max(0, Math.min(selectedIndex, filtered.length - 1));

  useEffect(() => {
    if (safeIndex < scrollOffset) setScrollOffset(safeIndex);
    else if (safeIndex >= scrollOffset + pageSize) setScrollOffset(safeIndex - pageSize + 1);
  }, [safeIndex, pageSize, scrollOffset]);

  function setSearch(next: string): void {
    searchRef.current = next;
    setSearchText(next);
    setSelectedIndex(0);
    setScrollOffset(0);
  }

  useInput((value, key) => {
    if (key.escape) {
      if (searchRef.current) setSearch("");
      else onCancel();
      return;
    }
    if (key.ctrl && value === "c") { onCancel(); return; }
    if (key.upArrow) { setSelectedIndex(Math.max(0, safeIndex - 1)); return; }
    if (key.downArrow) { setSelectedIndex(Math.min(filtered.length - 1, safeIndex + 1)); return; }
    if (key.return) {
      const item = filtered[safeIndex];
      if (item) onSelect(item.id);
      return;
    }
    if (key.backspace || key.delete) {
      if (searchRef.current) setSearch(searchRef.current.slice(0, -1));
      return;
    }
    // Append whole chunks (fast typing / paste), minus control bytes.
    if (value && !key.ctrl && !key.meta) {
      // eslint-disable-next-line no-control-regex
      const printable = value.replace(/[\x00-\x1f\x7f]/g, "");
      if (printable) setSearch(searchRef.current + printable);
    }
  });

  const visible = filtered.slice(scrollOffset, scrollOffset + pageSize);
  const interior = width - 4 - 2;
  const labelWidth = useMemo(() => Math.min(36, items.reduce((max, i) => Math.max(max, i.label.length), 0)), [items]);
  const detailWidth = Math.max(8, interior - labelWidth - COLUMN_GAP);
  const capStyle = { fg: theme.theme.textDim, bg: theme.theme.border, colorEnabled: theme.colorEnabled };

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={borderColor} paddingX={1} width={width}>
      <Box marginBottom={1}>
        <Text color={accent} bold>{title}</Text>
      </Box>
      <Box marginBottom={1} borderStyle="round" borderDimColor paddingX={1}>
        <Text color={dim}>{"⌕ "}</Text>
        <Text>{searchText}</Text>
        {!searchText && <Text color={dim}>Search…</Text>}
      </Box>

      {filtered.length === 0 ? (
        <Text color={dim}>No matches for "{searchText}".</Text>
      ) : (
        <Box flexDirection="column">
          {scrollOffset > 0 && <Text color={dim}>{`  ... (${scrollOffset} more above) ...`}</Text>}
          {visible.map((item, i) => {
            const isSelected = scrollOffset + i === safeIndex;
            return (
              <Box key={item.id}>
                <Text backgroundColor={isSelected ? selectionBg : undefined} color={isSelected ? accent : undefined} bold={isSelected}>
                  {"  " + fit(item.label, labelWidth) + " ".repeat(COLUMN_GAP)}
                </Text>
                <Text backgroundColor={isSelected ? selectionBg : undefined} color={dim}>
                  {fit(item.detail ?? "", detailWidth)}
                </Text>
              </Box>
            );
          })}
          {scrollOffset + pageSize < filtered.length && (
            <Text color={dim}>{`  ... (${filtered.length - scrollOffset - pageSize} more below) ...`}</Text>
          )}
        </Box>
      )}

      <Box marginTop={1}>
        <Text>
          {keyCap("↑↓", capStyle)}<Text color={dim}>{" move   "}</Text>
          {keyCap("enter", capStyle)}<Text color={dim}>{" select   "}</Text>
          {keyCap("esc", capStyle)}<Text color={dim}>{" cancel"}</Text>
        </Text>
      </Box>
    </Box>
  );
}
