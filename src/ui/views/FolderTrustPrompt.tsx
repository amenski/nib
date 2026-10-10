import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import type { FolderContentSummary } from "../../config/folder-trust.js";
import { useTheme } from "../contexts.js";
import { ansi256 } from "../theme.js";

/**
 * Ask-tier folder-level "fast path" confirmation (config/folder-trust.ts): a
 * single bulk-approval question shown once per project dir, on top of the
 * three existing per-artifact TOFU gates (skills/settings/hooks). y = trust
 * this folder AND every artifact listed below, forever, as of right now
 * (persisted, and bulk-applied to the three underlying trust stores); n =
 * decline, falling back to exactly today's per-artifact prompts/strip/skip
 * behavior. Same Promise+modal pattern as SettingsTrustPrompt/SkillTrustPrompt
 * /HookTrustPrompt — this is not a replacement for those, only a convenience
 * layered in front of them.
 */
interface Props {
  projectDir: string;
  summary: FolderContentSummary;
  status: "new" | "changed";
  resolve: (trusted: boolean) => void;
}

export default function FolderTrustPrompt({ projectDir, summary, status, resolve }: Props) {
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
        Do you trust the files in this folder? ({status === "changed" ? "changed since last trust" : "first seen"})
      </Text>
      <Box marginTop={1}>
        <Text wrap="wrap">Folder: <Text bold>{projectDir}</Text></Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        <Text color={theme.colorEnabled ? ansi256(theme.theme.textDim) : undefined}>Trusting will mark all of the following as trusted, right now:</Text>
        {summary.skills.length > 0 ? (
          <Text>  - <Text bold>{summary.skills.length}</Text> skill{summary.skills.length === 1 ? "" : "s"}</Text>
        ) : null}
        {summary.settingsKeys.length > 0 ? (
          <Text>  - settings keys: <Text bold>{summary.settingsKeys.join(", ")}</Text></Text>
        ) : null}
        {summary.hooks.length > 0 ? (
          <Text>  - <Text bold>{summary.hooks.length}</Text> hook{summary.hooks.length === 1 ? "" : "s"}</Text>
        ) : null}
      </Box>
      <Text color={theme.colorEnabled ? ansi256(theme.theme.textDim) : undefined}>
        This is a one-time bulk approval for exactly what's here now — content added or changed later still asks again.
      </Text>
      <Box flexDirection="column" marginTop={1}>
        <Text color={cursor === 0 ? accentColor : undefined}>
          {cursor === 0 ? "> " : "  "}Yes — trust this folder
        </Text>
        <Text color={cursor === 1 ? accentColor : undefined}>
          {cursor === 1 ? "> " : "  "}No — ask me per item instead
        </Text>
      </Box>
      <Text color={theme.colorEnabled ? ansi256(theme.theme.textDim) : undefined}>↑↓ navigate · Enter choose · y/n · Esc cancel</Text>
    </Box>
  );
}
