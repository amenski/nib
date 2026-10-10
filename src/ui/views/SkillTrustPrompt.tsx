import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import type { SkillDef } from "../../skills/index.js";
import { useTheme } from "../contexts.js";
import { ansi256 } from "../theme.js";

/**
 * Ask-tier TOFU confirmation for an unseen or changed project skill
 * (skill-spec.md §6): y = trust that hash forever (persisted to
 * skill-trust.json), n = skip this session. Wired like askUser and
 * HookTrustPrompt — a Promise resolved by this modal — so skill trust asks
 * flow through the same interactive surface as permission prompts.
 */
interface Props {
  skill: SkillDef;
  /** "first seen" vs "changed" — the one-time notice names which. */
  status: "new" | "changed";
  resolve: (trusted: boolean) => void;
}

export default function SkillTrustPrompt({ skill, status, resolve }: Props) {
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
        Untrusted project skill ({status === "changed" ? "changed" : "first seen"})
      </Text>
      <Box marginTop={1}>
        <Text>Skill: </Text>
        <Text bold>{skill.name}</Text>
      </Box>
      <Box>
        <Text wrap="wrap">Source: <Text bold>{skill.sourcePath}</Text></Text>
      </Box>
      <Text color={theme.colorEnabled ? ansi256(theme.theme.textDim) : undefined}>This skill's instructions are injected into the system prompt. Trust it?</Text>
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
