import React from "react";
import { Box, Text } from "ink";
import type { SlashCommandItem } from "../core/slash-commands.js";
import { useTheme } from "../contexts.js";
import { ansi256 } from "../theme.js";

type Props = {
  items: SlashCommandItem[];
  activeIndex: number;
  width: number;
  maxVisible?: number;
};

const SlashCommandMenu = React.memo(function SlashCommandMenu({
  items, activeIndex, width, maxVisible = 8,
}: Props): React.ReactElement | null {
  const theme = useTheme();
  const accent = theme.colorEnabled ? ansi256(theme.theme.accent) : undefined;
  // Rules of Hooks: all hooks must run unconditionally before any early
  // return — a conditional useMemo after `return null` changed the hook count
  // between renders (items 0 vs >0), which corrupted React state whenever the
  // menu opened and broke Enter-to-select.
  const labelColumnWidth = React.useMemo(() => {
    if (items.length === 0) return 0;
    const longestLabel = Math.max(...items.map((s) => s.label.length));
    return Math.min(longestLabel + 2, Math.max(10, (width - 2) >> 1));
  }, [items, width]);

  if (items.length === 0) return null;

  const visibleStart = Math.min(Math.max(0, activeIndex - Math.floor((maxVisible - 1) / 2)), Math.max(0, items.length - maxVisible));
  const visibleItems = items.slice(visibleStart, visibleStart + maxVisible);

  return (
    <Box flexDirection="column" marginBottom={1} width={width}>
      {visibleStart > 0 ? <Box marginLeft={2}><Text color={theme.colorEnabled ? ansi256(theme.theme.textDim) : undefined}>▲</Text></Box> : null}
      {visibleItems.map((item, idx) => {
        const actualIndex = visibleStart + idx;
        const isActive = actualIndex === activeIndex;
        return (
          <Box key={item.label} gap={2} flexDirection="row" flexGrow={1}>
            <Box width={labelColumnWidth} flexShrink={0}>
              <Text color={isActive ? accent : undefined} wrap="truncate-end">
                {isActive ? "> " : "  "}
                <Text bold>{item.label}</Text>
              </Text>
            </Box>
            <Box flexGrow={1}>
              <Text color={isActive ? accent : undefined} wrap="truncate-end">
                {item.description}
              </Text>
            </Box>
          </Box>
        );
      })}
      {visibleStart + visibleItems.length < items.length ? <Box marginLeft={2}><Text color={theme.colorEnabled ? ansi256(theme.theme.textDim) : undefined}>▼</Text></Box> : null}
      <Box marginLeft={2}>
        <Text color={theme.colorEnabled ? ansi256(theme.theme.textDim) : undefined}>({activeIndex + 1}/{items.length}) ↑↓ navigate · Enter select</Text>
      </Box>
    </Box>
  );
});

export default SlashCommandMenu;
