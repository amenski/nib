import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { useTheme } from "../contexts.js";
import { ansi256 } from "../theme.js";

interface Props {
  planText: string;
  onImplement: (followUpPrompt: string) => void;
  onStayInPlan: () => void;
  onSwitchToDefault: () => void;
}

function detectCjk(text: string): boolean {
  const fullwidthPunct = text.match(/[，。、！？：；【】「」『』《》—…·～]/g);
  return (fullwidthPunct?.length ?? 0) > 5;
}

const OPTIONS = [
  { kind: "implement" as const, label: "Implement this plan" },
  { kind: "stay" as const, label: "Stay in Plan mode" },
  { kind: "default" as const, label: "Switch to Default mode" },
];

export default function PlanImplementationPrompt({ planText, onImplement, onStayInPlan, onSwitchToDefault }: Props) {
  const theme = useTheme();
  const [cursor, setCursor] = useState(0);

  useInput((_value, key) => {
    if (key.escape) {
      onStayInPlan();
      return;
    }
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
      if (opt.kind === "implement") {
        const prompt = detectCjk(planText) ? "实现此方案。" : "Implement the plan.";
        onImplement(prompt);
      } else if (opt.kind === "stay") {
        onStayInPlan();
      } else {
        onSwitchToDefault();
      }
      return;
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={ansi256(theme.theme.warning)} paddingX={1} marginY={1}>
      <Box marginBottom={1}>
        <Text color={ansi256(theme.theme.warning)} bold>Plan detected</Text>
      </Box>
      <Text color={ansi256(theme.theme.textDim)}>The model produced a plan instead of implementing changes. What would you like to do?</Text>
      <Box flexDirection="column" marginTop={1}>
        {OPTIONS.map((opt, i) => (
          <Text key={opt.kind} color={i === cursor ? ansi256(theme.theme.secondary) : undefined}>
            {i === cursor ? "> " : "  "}
            {i + 1}. {opt.label}
          </Text>
        ))}
      </Box>
      <Box marginTop={1}>
        <Text color={ansi256(theme.theme.textDim)}>↑↓ navigate · Enter select · Esc stay in Plan mode</Text>
      </Box>
    </Box>
  );
}
