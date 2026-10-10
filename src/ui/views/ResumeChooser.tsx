import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { useTheme } from "../contexts.js";
import { ansi256 } from "../theme.js";

interface Props {
  /** Number of messages in the resumed transcript (for the prompt). */
  messageCount: number;
  /** User chose to load the full transcript. */
  onLoad: () => void;
  /** User chose to compact before loading. */
  onCompact: () => void;
  width: number;
}

const OPTIONS = [
  { key: "load", label: "Load entirely", desc: "Show the full transcript" },
  { key: "compact", label: "Compact first", desc: "Summarize older turns, keep the recent tail" },
] as const;

/**
 * Shown on startup when a session is resumed. Lets the user pick whether to
 * replay the whole transcript or compact it first. Enter/1-2 selects; there is
 * no cancel — a resumed session must resolve to one of the two.
 */
export default function ResumeChooser({ messageCount, onLoad, onCompact, width }: Props) {
  const theme = useTheme();
  const [selected, setSelected] = useState(0);

  const choose = (index: number) => {
    if (OPTIONS[index].key === "load") onLoad();
    else onCompact();
  };

  useInput((value, key) => {
    if (key.upArrow) {
      setSelected((i) => (i - 1 + OPTIONS.length) % OPTIONS.length);
      return;
    }
    if (key.downArrow) {
      setSelected((i) => (i + 1) % OPTIONS.length);
      return;
    }
    if (key.return) {
      choose(selected);
      return;
    }
    const digit = parseInt(value, 10);
    if (digit >= 1 && digit <= OPTIONS.length) {
      setSelected(digit - 1);
      choose(digit - 1);
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={ansi256(theme.theme.secondary)} paddingX={1} marginY={1} width={width}>
      <Box marginBottom={1}>
        <Text color={ansi256(theme.theme.secondary)} bold>Resume session</Text>
      </Box>
      <Text wrap="wrap">
        This session has {messageCount} message{messageCount === 1 ? "" : "s"}. How should it be loaded?
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {OPTIONS.map((opt, i) => {
          const isSelected = selected === i;
          return (
            <Text key={opt.key} color={isSelected ? ansi256(theme.theme.secondary) : undefined}>
              {isSelected ? ">" : " "} {isSelected ? "◉" : "○"} {opt.label}
              <Text color={ansi256(theme.theme.textDim)}> — {opt.desc}</Text>
            </Text>
          );
        })}
      </Box>
      <Box marginTop={1}>
        <Text color={ansi256(theme.theme.textDim)}>↑↓ navigate · 1-2 select · Enter choose</Text>
      </Box>
    </Box>
  );
}
