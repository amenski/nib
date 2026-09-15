/**
 * Nib CommandPalette — Fuzzy-searchable command palette (Ctrl+Shift+P).
 *
 * Displays a searchable list of all available slash commands, modes,
 * and actions. As the user types, results are filtered by fuzzy match.
 * Enter executes the selected command; Esc dismisses.
 */

import React, { useState, useMemo, useRef, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import { useTheme } from "./contexts.js";
import { fuzzyFilter } from "./FuzzySearch.js";

export interface CommandPaletteAction {
  id: string;
  label: string;
  description: string;
  category: "command" | "mode" | "action";
  execute: () => void;
}

interface CommandPaletteProps {
  actions: CommandPaletteAction[];
  onClose: () => void;
}

export default function CommandPalette({
  actions,
  onClose,
}: CommandPaletteProps) {
  const theme = useTheme();
  const [query, setQuery] = useState("");
  const [selection, setSelection] = useState(0);
  const inputRef = useRef<string>("");

  const results = useMemo(() => {
    if (!query.trim()) {
      // Show all actions, sorted by category then label
      return [...actions].sort((a, b) => {
        if (a.category !== b.category) {
          const order = { command: 0, mode: 1, action: 2 };
          return order[a.category] - order[b.category];
        }
        return a.label.localeCompare(b.label);
      });
    }
    const labels = actions.map((a) => a.label);
    const matches = fuzzyFilter(labels, query);
    return matches
      .map((m) => actions.find((a) => a.label === m.item)!)
      .filter(Boolean);
  }, [query, actions]);

  // Reset selection when results change
  useEffect(() => {
    setSelection(0);
  }, [results.length]);

  useInput((value: string, key: any) => {
    if (key.escape || (key.ctrl && key.name === "c")) {
      onClose();
      return;
    }
    if (key.return) {
      if (results.length > 0 && selection >= 0 && selection < results.length) {
        const action = results[selection];
        action.execute();
      }
      onClose();
      return;
    }
    if (key.upArrow) {
      setSelection((s) => Math.max(0, s - 1));
      return;
    }
    if (key.downArrow) {
      setSelection((s) => Math.min(results.length - 1, s + 1));
      return;
    }
    if (key.backspace) {
      setQuery((q) => q.slice(0, -1));
      return;
    }
    if (key.delete) {
      // no-op for now
      return;
    }
    if (value && !key.ctrl && !key.meta && !key.alt) {
      setQuery((q) => q + value);
      return;
    }
  });

  const dim = (s: string) => (theme.colorEnabled ? `\x1b[2m${s}\x1b[0m` : s);
  const bright = (s: string) => (theme.colorEnabled ? `\x1b[97m${s}\x1b[0m` : s);

  const maxVisible = Math.min(results.length, 12);
  const visibleResults = results.slice(0, maxVisible);

  return (
    <Box flexDirection="column" marginTop={1} marginBottom={1}>
      {/* Search box */}
      <Box>
        <Text>
          {dim("\u250C")}
          {dim(" Command Palette ")}
          {dim("\u2500".repeat(30))}
        </Text>
      </Box>
      <Box>
        <Text>
          {"> "}
          {query}
          <Text inverse> </Text>
        </Text>
      </Box>

      {/* Results */}
      {visibleResults.length > 0 ? (
        <Box flexDirection="column">
          {visibleResults.map((action, i) => {
            const categoryColor = (
              cat: string,
            ): { color?: string; label: string } => {
              switch (cat) {
                case "command":
                  return { color: "cyan", label: "cmd" };
                case "mode":
                  return { color: "yellow", label: "mode" };
                case "action":
                  return { color: "green", label: "act" };
                default:
                  return { color: undefined, label: "  " };
              }
            };
            const cat = categoryColor(action.category);
            const isSelected = i === selection;
            const prefix = isSelected ? "\u203A " : "  ";
            return (
              <Box key={action.id}>
                <Text>
                  {isSelected ? bright(prefix) : dim(prefix)}
                  <Text color={cat.color as any}>{cat.label}</Text>
                  {" "}
                  {!isSelected ? (
                    <Text bold>{action.label}</Text>
                  ) : (
                    <Text bold inverse>
                      {action.label}
                    </Text>
                  )}
                  <Text dimColor>{dim(`  ${action.description}`)}</Text>
                </Text>
              </Box>
            );
          })}
          {results.length > maxVisible && (
            <Box>
              <Text dimColor>
                {dim(`  ... ${results.length - maxVisible} more results`)}
              </Text>
            </Box>
          )}
        </Box>
      ) : query.trim() ? (
        <Box>
          <Text dimColor>{dim("  No matching commands")}</Text>
        </Box>
      ) : null}

      {/* Footer */}
      <Box>
        <Text dimColor>
          {dim("\u2514")}
          {dim("\u2500".repeat(40))}
          {"\n"}
          {dim("  Type to filter  Enter execute  Esc cancel")}
        </Text>
      </Box>
    </Box>
  );
}
