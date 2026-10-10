import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import type { HookEntry } from "../../hooks/types.js";
import { useTheme } from "../contexts.js";
import { ansi256 } from "../theme.js";

/**
 * Ask-tier TOFU confirmation for an unseen project hook (hooks-spec.md §6):
 * y = trust forever (persisted to hooks-trust.json), n = skip this session.
 * Wired like askUser — a Promise resolved by this modal — so hook trust asks
 * flow through the same interactive surface as permission prompts.
 */
interface Props {
  entry: HookEntry;
  resolve: (trusted: boolean) => void;
}

export default function HookTrustPrompt({ entry, resolve }: Props) {
  const theme = useTheme();
  const accentColor = theme.colorEnabled ? ansi256(theme.theme.accent) : undefined;
  const borderColor = theme.colorEnabled ? ansi256(theme.theme.border) : undefined;
  const [cursor, setCursor] = useState(0);

  useInput((value, key) => {
    if (key.escape || value.toLowerCase() === "n") {
      resolve(false);
      return;
    }
    if (value.toLowerCase() === "y") {
      resolve(true);
      return;
    }
    if (key.upArrow || key.downArrow) {
      setCursor((c) => (c === 0 ? 1 : 0));
      return;
    }
    if (key.return) {
      resolve(cursor === 0);
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={accentColor ?? borderColor} paddingX={1} marginY={1}>
      <Text bold color={accentColor}>Untrusted project hook</Text>
      <Box marginTop={1}>
        <Text>Event: </Text>
        <Text bold>{entry.event}</Text>
      </Box>
      {entry.matcher ? (
        <Box>
          <Text>Matcher: </Text>
          <Text bold>{entry.matcher}</Text>
        </Box>
      ) : null}
      <Box>
        <Text wrap="wrap">Command: <Text bold>{entry.command}</Text></Text>
      </Box>
      <Text color={theme.colorEnabled ? ansi256(theme.theme.textDim) : undefined}>This project hook runs a shell command with your privileges. Trust it?</Text>
      <Box flexDirection="column" marginTop={1}>
        <Text color={cursor === 0 ? accentColor : undefined}>
          {cursor === 0 ? "> " : "  "}Yes — trust forever
        </Text>
        <Text color={cursor === 1 ? accentColor : undefined}>
          {cursor === 1 ? "> " : "  "}No — skip this session
        </Text>
      </Box>
      <Text color={theme.colorEnabled ? ansi256(theme.theme.textDim) : undefined}>↑↓ navigate · Enter choose · y/n · Esc cancel</Text>
    </Box>
  );
}
