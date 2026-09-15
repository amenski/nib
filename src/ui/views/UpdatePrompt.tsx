import React, { useState } from "react";
import { Box, Text, useInput } from "ink";

export interface UpdatePromptProps {
  version: string;
  installedVersion: string;
  onInstall: () => void;
  onIgnore: () => void;
  onIgnoreVersion: () => void;
}

const OPTIONS = [
  { kind: "install" as const, label: "Install" },
  { kind: "ignore" as const, label: "Ignore once" },
  { kind: "ignoreVersion" as const, label: "Ignore this version" },
];

export function UpdatePrompt({ version, installedVersion, onInstall, onIgnore, onIgnoreVersion }: UpdatePromptProps) {
  const [cursor, setCursor] = useState(0);

  useInput((_value, key) => {
    if (key.upArrow) {
      setCursor((i) => (i - 1 + OPTIONS.length) % OPTIONS.length);
      return;
    }
    if (key.downArrow) {
      setCursor((i) => (i + 1) % OPTIONS.length);
      return;
    }
    if (key.return) {
      const opt = OPTIONS[cursor];
      if (opt.kind === "install") onInstall();
      else if (opt.kind === "ignore") onIgnore();
      else onIgnoreVersion();
      return;
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1} marginY={1}>
      <Box marginBottom={1}>
        <Text color="yellow" bold>Update Available</Text>
      </Box>
      <Text>
        A new version of nib is available:{" "}
        <Text color="yellow" bold>{version}</Text>
        {" "}(currently {installedVersion})
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {OPTIONS.map((opt, i) => (
          <Text key={opt.kind} color={i === cursor ? "cyanBright" : undefined}>
            {i === cursor ? "> " : "  "}
            {i + 1}. {opt.label}
          </Text>
        ))}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>↑↓ navigate · Enter select</Text>
      </Box>
    </Box>
  );
}

export default UpdatePrompt;
