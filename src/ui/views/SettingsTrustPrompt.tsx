import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { useTheme } from "../contexts.js";
import { ansi256 } from "../theme.js";

/**
 * Ask-tier TOFU confirmation for an unseen or changed project settings file
 * that declares execution-capable keys (config/settings-trust.ts): y = trust
 * that hash forever (persisted to settings-trust.json), n = skip this session
 * (the listed keys are stripped from the effective config). Same
 * Promise+modal pattern as HookTrustPrompt / SkillTrustPrompt.
 */
interface Props {
  /** Execution-capable keys the project file is asking for, e.g. ["statusline", "mcpServers"]. */
  keys: string[];
  /** Path to the project settings file. */
  settingsPath: string;
  /** "first seen" vs "changed" — the one-time notice names which. */
  status: "new" | "changed";
  resolve: (trusted: boolean) => void;
}

export default function SettingsTrustPrompt({ keys, settingsPath, status, resolve }: Props) {
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
      <Text bold color={accentColor}>
        Untrusted project settings ({status === "changed" ? "changed" : "first seen"})
      </Text>
      <Box marginTop={1}>
        <Text wrap="wrap">Source: <Text bold>{settingsPath}</Text></Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        <Text color={theme.colorEnabled ? ansi256(theme.theme.textDim) : undefined}>This file asks for these execution-capable settings:</Text>
        {keys.map((k) => (
          <Text key={k}>  - <Text bold>{k}</Text></Text>
        ))}
      </Box>
      <Text color={theme.colorEnabled ? ansi256(theme.theme.textDim) : undefined}>Trusting runs commands/modules/servers this project supplies, with your privileges. Trust it?</Text>
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
