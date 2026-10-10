import React, { useState, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import type { ModeConfig, ModeLoader } from "../../modes/loader.js";
import { useTheme } from "../contexts.js";
import { ansi256 } from "../theme.js";

interface Props {
  modeLoader: ModeLoader;
  /** Slug of the currently active mode, marked in the list. */
  currentSlug?: string;
  /** User picked a mode; the host switches to it (like /mode <slug>). */
  onSelect: (slug: string) => void;
  onClose: () => void;
  width: number;
}

/**
 * Selectable list of available modes. Mirrors SkillList so /modes behaves like
 * the other interactive pickers rather than dumping plain text into the
 * scrollback. Enter switches to the selected mode; Esc closes.
 */
export default function ModeList({ modeLoader, currentSlug, onSelect, onClose, width }: Props) {
  const theme = useTheme();
  const [modes, setModes] = useState<ModeConfig[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);

  useEffect(() => {
    modeLoader.listAll().then((list: ModeConfig[]) => setModes(list));
  }, [modeLoader]);

  const safeIndex = Math.max(0, Math.min(selectedIndex, modes.length - 1));

  useInput((_value, key) => {
    if (key.escape) {
      onClose();
      return;
    }
    if (key.upArrow) {
      setSelectedIndex((i) => Math.max(0, i - 1));
      return;
    }
    if (key.downArrow) {
      setSelectedIndex((i) => Math.min(modes.length - 1, i + 1));
      return;
    }
    if (key.return) {
      const m = modes[safeIndex];
      if (m) onSelect(m.slug);
      return;
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={ansi256(theme.theme.secondary)} paddingX={1} marginY={1} width={width}>
      <Box marginBottom={1}>
        <Text color={ansi256(theme.theme.secondary)} bold>Modes</Text>
      </Box>

      {modes.length === 0 ? (
        <Text color={ansi256(theme.theme.textDim)}>No modes available.</Text>
      ) : (
        <Box flexDirection="column">
          {modes.map((m, i) => {
            const isSelected = i === safeIndex;
            const isCurrent = m.slug === currentSlug;
            return (
              <Box key={m.slug}>
                <Text color={isSelected ? ansi256(theme.theme.secondary) : ansi256(theme.theme.textDim)}>
                  {isSelected ? "> " : "  "}
                </Text>
                <Text color={isSelected ? ansi256(theme.theme.secondary) : ansi256(theme.theme.textDim)}>
                  {m.slug}
                  {isCurrent && <Text color={ansi256(theme.theme.success)}> (current)</Text>}
                  <Text color={ansi256(theme.theme.textDim)}> — {m.description || m.roleDefinition.slice(0, 60)}</Text>
                </Text>
              </Box>
            );
          })}
        </Box>
      )}

      <Box marginTop={1}>
        <Text color={ansi256(theme.theme.textDim)}>↑↓ navigate · Enter switch · Esc close</Text>
      </Box>
    </Box>
  );
}
