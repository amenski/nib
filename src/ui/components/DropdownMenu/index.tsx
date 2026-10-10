import React, { useMemo } from "react";
import { Box, Text } from "ink";
import { useTheme } from "../../contexts.js";
import { ansi256 } from "../../theme.js";

export type DropdownMenuItem = {
  key: string;
  label: string;
  description?: string;
  selected?: boolean;
  statusIndicator?: { symbol: string; color: string };
};

type Props = {
  items: DropdownMenuItem[];
  activeIndex: number;
  maxVisible?: number;
  width: number;
  title?: string;
  titleColor?: string;
  activeColor?: string;
  helpText?: string;
  emptyText?: string;
  renderItem?: (item: DropdownMenuItem, isActive: boolean) => React.ReactNode;
};

export function calculateVisibleStart(activeIndex: number, totalItems: number, maxVisible: number): number {
  return Math.min(Math.max(0, activeIndex - Math.floor((maxVisible - 1) / 2)), Math.max(0, totalItems - maxVisible));
}

const DropdownMenu = React.memo(function DropdownMenu({
  items, activeIndex, maxVisible = 8, width, title, titleColor,
  activeColor = "cyanBright", helpText, emptyText = "No items found", renderItem,
}: Props): React.ReactElement | null {
  const theme = useTheme();
  const resolvedTitleColor = titleColor ?? (theme.colorEnabled ? ansi256(theme.theme.accent) : undefined);
  const resolvedDimColor = theme.colorEnabled ? ansi256(theme.theme.textDim) : undefined;
  const visibleStart = calculateVisibleStart(activeIndex, items?.length, maxVisible);
  const visibleItems = items?.slice(visibleStart, visibleStart + maxVisible);

  const labelColumnWidth = useMemo(() => {
    if (visibleItems.length === 0) return 0;
    const maxContentWidth = Math.max(...visibleItems.map((item) => {
      let w = 2;
      if (item.selected !== undefined) w += 2;
      w += item.label.length;
      if (item.statusIndicator) w += 2;
      return w;
    }));
    return Math.min(maxContentWidth, Math.max(10, (width - 2) >> 1));
  }, [visibleItems, width]);

  if (items?.length === 0) {
    return (
      <Box flexDirection="column" marginBottom={1} width={width}>
        {title ? <Text color={resolvedTitleColor} bold>{title}</Text> : null}
        <Text color={resolvedDimColor}>{emptyText}</Text>
        {helpText ? <Text color={resolvedDimColor}>{helpText}</Text> : null}
      </Box>
    );
  }

  return (
    <Box flexDirection="column" marginBottom={1} borderStyle={"round"} borderDimColor width={width}>
      {title ? (
        <Box borderStyle={"single"} borderDimColor borderBottom={true} borderRight={false} borderTop={false} borderLeft={false} paddingX={1}>
          <Text color={resolvedTitleColor} bold>{title}</Text>
        </Box>
      ) : null}
      {visibleStart > 0 ? (
        <Box marginLeft={2}><Text color={resolvedDimColor}>… {visibleStart} above</Text></Box>
      ) : null}
      <Box flexDirection="column">
        {visibleItems.map((item, idx) => {
          const actualIndex = visibleStart + idx;
          const isActive = actualIndex === activeIndex;
          if (renderItem) return <React.Fragment key={item.key}>{renderItem(item, isActive)}</React.Fragment>;
          return (
            <Box key={item.key} flexGrow={1} flexDirection="row" gap={2} paddingX={1}>
              <Box width={labelColumnWidth} flexShrink={0}>
                <Text color={isActive ? activeColor : undefined} wrap="truncate-end">
                  {isActive ? "> " : "  "}
                  {item.selected !== undefined ? (item.selected ? "● " : "○ ") : null}
                  <Text bold>{item.label}</Text>
                  {item.statusIndicator ? <Text color={item.statusIndicator.color}> {item.statusIndicator.symbol}</Text> : null}
                </Text>
              </Box>
              <Box flexGrow={1}>
                {item.description ? <Text color={resolvedDimColor}>{item.description}</Text> : null}
              </Box>
            </Box>
          );
        })}
      </Box>
      {visibleStart + visibleItems.length < items.length ? (
        <Box marginLeft={2}><Text color={resolvedDimColor}>… {items.length - visibleStart - visibleItems.length} more</Text></Box>
      ) : null}
      {helpText ? (
        <Box borderStyle={"single"} borderDimColor borderBottom={false} borderRight={false} borderTop={true} borderLeft={false} paddingX={1}>
          <Text color={resolvedDimColor}>{helpText}</Text>
        </Box>
      ) : null}
    </Box>
  );
});

export { calculateVisibleStart as calcVisibleStart };
export default DropdownMenu;
