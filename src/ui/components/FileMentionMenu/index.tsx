import React from "react";
import { Box, Text } from "ink";
import DropdownMenu from "../DropdownMenu/index.js";
import type { FileMentionItem } from "../../core/file-mentions.js";
import { useTheme } from "../../contexts.js";
import { ansi256 } from "../../theme.js";

interface Props {
  width: number;
  items: FileMentionItem[];
  activeIndex: number;
  query: string;
}

/**
 * Purely presentational — all key handling (↑↓ navigate, Enter/Tab insert,
 * Esc close) lives in PromptInput, the same pattern as SlashCommandMenu. The
 * alternative was the menu owning a `useInput` of its own, which would fire
 * alongside PromptInput's handler for the same keypress (Ink has no
 * stop-propagation): Enter would both select a file AND submit the prompt,
 * Esc would both close the menu AND interrupt the turn, and ↑↓ would both
 * navigate the list AND walk history. Ordering them in one handler keeps the
 * two behaviors mutually exclusive.
 */
const FileMentionMenu: React.FC<Props> = ({ width, items, activeIndex, query }) => {
  const theme = useTheme();
  const accent = theme.colorEnabled ? ansi256(theme.theme.accent) : undefined;
  return (
    <DropdownMenu
      width={width}
      title="Mention File"
      helpText="↑↓ navigate · Enter/Tab insert · Esc close"
      emptyText={query ? "No matching files" : "Type after @ to search files"}
      items={items.map((item) => ({
        key: item.path,
        label: item.path,
        description: item.type === "directory" ? "directory" : "file",
      }))}
      activeIndex={activeIndex}
      activeColor={accent}
      maxVisible={8}
      renderItem={(item, isActive) => (
        <Box flexDirection="row" paddingX={1} gap={1}>
          <Text color={isActive ? accent : undefined}>{isActive ? "> " : "  "}</Text>
          <Box flexGrow={1}>
            <Text color={isActive ? accent : undefined} wrap="truncate-end" bold={isActive}>{item.label}</Text>
          </Box>
          {item.description ? (
            <Box width={10} flexShrink={0}><Text color={theme.colorEnabled ? ansi256(theme.theme.textDim) : undefined}>{item.description}</Text></Box>
          ) : null}
        </Box>
      )}
    />
  );
};

export default FileMentionMenu;
