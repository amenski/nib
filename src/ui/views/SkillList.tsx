import React, { useState, useMemo, useRef, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import type { SkillDef } from "../../skills/index.js";
import { useTheme } from "../contexts.js";
import { fit, COLUMN_GAP } from "../core/picker-columns.js";
import { keyCap } from "../core/chips.js";
import { ansi256, type ThemeContextValue } from "../theme.js";
import { fuzzyScore } from "../core/fuzzy.js";

/** Resolve a semantic theme slot to an Ink color string, honoring the color gate. */
function slotColor(theme: ThemeContextValue, key: keyof ThemeContextValue["theme"]): string | undefined {
  if (!theme.colorEnabled) return undefined;
  return ansi256(theme.theme[key] as number);
}

interface Props {
  skills: SkillDef[];
  /** User picked a skill; the host force-loads it (like /skill <name>). */
  onSelect: (name: string) => void;
  onClose: () => void;
  width: number;
  height: number;
}

/**
 * Selectable list of available skills. Mirrors SessionList's navigation and
 * search so /skills behaves like the other interactive pickers rather than
 * dumping plain text into the scrollback. Enter force-loads the selected
 * skill; Esc closes.
 */
export default function SkillList({ skills, onSelect, onClose, width, height }: Props) {
  const theme = useTheme();
  const accent = slotColor(theme, "accent");
  const borderColor = slotColor(theme, "border");
  const [searchText, setSearchText] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [scrollOffset, setScrollOffset] = useState(0);
  const searchRef = useRef("");

  const filtered = useMemo(() => {
    if (!searchText) return skills;
    const scored: Array<{ skill: SkillDef; score: number }> = [];
    for (const s of skills) {
      const nameScore = fuzzyScore(s.name, searchText);
      const descScore = fuzzyScore(s.description ?? "", searchText);
      if (nameScore === null && descScore === null) continue;
      // A name hit ranks ahead of a description-only hit, same as
      // ModelsDropdown preferring a model-name match over a provider one.
      const score = nameScore !== null ? nameScore : descScore! + 1000;
      scored.push({ skill: s, score });
    }
    scored.sort((a, b) => a.score - b.score);
    return scored.map((x) => x.skill);
  }, [skills, searchText]);

  // Each row now spans ~3 terminal lines (name + indented wrapped description +
  // margin), so budget the visible height accordingly rather than 1 line/row —
  // otherwise the slice overflows and pushes the footer off-screen.
  const APPROX_LINES_PER_ROW = 3;
  const pageSize = Math.max(3, Math.floor((height - 8) / APPROX_LINES_PER_ROW));
  const safeIndex = Math.max(0, Math.min(selectedIndex, filtered.length - 1));

  useEffect(() => {
    if (safeIndex < scrollOffset) setScrollOffset(safeIndex);
    else if (safeIndex >= scrollOffset + pageSize) setScrollOffset(safeIndex - pageSize + 1);
  }, [safeIndex, pageSize, scrollOffset]);

  const visible = filtered.slice(scrollOffset, scrollOffset + pageSize);

  useInput((value, key) => {
    if (key.escape) {
      if (searchText) {
        setSearchText("");
        searchRef.current = "";
        return;
      }
      onClose();
      return;
    }
    if (key.upArrow) {
      setSelectedIndex((i) => Math.max(0, i - 1));
      return;
    }
    if (key.downArrow) {
      setSelectedIndex((i) => Math.min(filtered.length - 1, i + 1));
      return;
    }
    if (key.return) {
      const s = filtered[safeIndex];
      if (s) onSelect(s.name);
      return;
    }
    if (key.backspace || key.delete) {
      if (searchRef.current) {
        searchRef.current = searchRef.current.slice(0, -1);
        setSearchText(searchRef.current);
        setSelectedIndex(0);
        setScrollOffset(0);
      }
      return;
    }
    // Do NOT gate on value.length === 1: a fast typist or a paste arrives as
    // one multi-character chunk, and requiring a single char silently drops
    // it. Filter out control bytes instead and append whatever printable
    // text came through.
    if (value && !key.ctrl && !key.meta) {
      // eslint-disable-next-line no-control-regex
      const printable = value.replace(/[\x00-\x1f\x7f]/g, "");
      if (!printable) return;
      searchRef.current += printable;
      setSearchText(searchRef.current);
      setSelectedIndex(0);
      setScrollOffset(0);
      return;
    }
  });

  // Same treatment as the model picker: a full-width selection band rather
  // than a "> " caret, and columns sized from the whole set so the name and
  // description line up vertically instead of reading as prose.
  const selectionBg = slotColor(theme, "selection");
  const capStyle = {
    fg: theme.theme.textDim,
    bg: theme.theme.border,
    colorEnabled: theme.colorEnabled,
  };
  // NOT computeColumns(): that helper gives the leftover width to the label,
  // which is right when the secondary column is a short provider name and
  // wrong here, where the description is a paragraph -- it consumed everything
  // and clamped skill names to the 8-char floor. Skills need the inverse: the
  // name column sized to its content, the description taking what remains.
  const interior = width - 4 - 2;
  const nameWidth = Math.min(
    24,
    filtered.reduce((max, s) => Math.max(max, s.name.length), 0),
  );
  const descWidth = Math.max(12, interior - nameWidth - COLUMN_GAP);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={borderColor} paddingX={1} marginY={1} width={width}>
      <Box marginBottom={1}>
        <Text color={accent} bold>Skills</Text>
        {searchText && <Text color={slotColor(theme, "textDim")}> — matching "{searchText}"</Text>}
      </Box>

      {filtered.length === 0 ? (
        <Text color={slotColor(theme, "textDim")}>{skills.length === 0 ? "No skills available." : "No skills match."}</Text>
      ) : (
        <Box flexDirection="column">
          {scrollOffset > 0 && (
            <Text color={slotColor(theme, "textDim")}>{`  ... (${scrollOffset} more above) ...`}</Text>
          )}
          {visible.map((s, i) => {
            const globalIdx = scrollOffset + i;
            const isSelected = globalIdx === safeIndex;
            // One row per skill, in fixed columns. Descriptions here are
            // paragraphs (median 327 chars, 20 of 22 over 60), so rendering
            // them in full cost 7-11 rows EACH -- about two skills visible on a
            // 24-row terminal. Measured: 35 characters is enough to
            // disambiguate every colliding name in the set (app-*, clean-*,
            // flutter-*), so the description earns one truncated column
            // rather than a wrapped block.
            const desc = (s.description || "").replace(/\s+/g, " ");
            const body =
              "  " + fit(s.name, nameWidth) +
              " ".repeat(COLUMN_GAP) + fit(desc, descWidth);
            return (
              <Box key={s.name}>
                <Text
                  backgroundColor={isSelected ? selectionBg : undefined}
                  color={isSelected ? accent : undefined}
                  bold={isSelected}
                >
                  {body}
                </Text>
              </Box>
            );
          })}
          {scrollOffset + pageSize < filtered.length && (
            <Text color={slotColor(theme, "textDim")}>{`  ... (${filtered.length - scrollOffset - pageSize} more below) ...`}</Text>
          )}
        </Box>
      )}

      <Box flexDirection="column" marginTop={1}>
        <Text>
          {keyCap("↑↓", capStyle)}<Text color={slotColor(theme, "textDim")}>{" move   "}</Text>
          {keyCap("enter", capStyle)}<Text color={slotColor(theme, "textDim")}>{" select   "}</Text>
          {keyCap("esc", capStyle)}<Text color={slotColor(theme, "textDim")}>{" close"}</Text>
        </Text>
        {searchText && <Text color={slotColor(theme, "textDim")}>Search: {searchText}</Text>}
      </Box>
    </Box>
  );
}
