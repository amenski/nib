import React from "react";
import { Box, Text } from "ink";
import { useTheme } from "./contexts.js";
import { ansi256, type ThemeContextValue } from "./theme.js";
import type { TodoItem } from "../tools/todo.js";

/** Resolve a semantic theme slot to an Ink color string, honoring the color gate. */
function slotColor(theme: ThemeContextValue, key: keyof ThemeContextValue["theme"]): string | undefined {
  if (!theme.colorEnabled) return undefined;
  return ansi256(theme.theme[key] as number);
}

interface Props {
  todos: TodoItem[];
  /** False after the turn ends: keep the last state on screen, fully dimmed. */
  active: boolean;
  /** Add a blank row above: the transcript's last row is not already blank. */
  gapAbove?: boolean;
}

/**
 * Live checklist panel for the agent's update_todo_list plan (src/tools/todo.ts).
 * Renders between the transcript and the input.
 *
 * Event-driven: re-renders only when the store pushes a new list (App.tsx
 * subscribes), never on a timer — the only timer-driven row is the status
 * line's spinner, the LAST row, so a panel repaint cannot cascade below it
 * (see StatusBar.tsx).
 * Glyphs: ◻ pending (dim) / ▸ in_progress (accent) / ☑ completed (dim).
 */
export default function TodoPanel({ todos, active, gapAbove = false }: Props) {
  const theme = useTheme();
  if (todos.length === 0) return null;

  const accent = slotColor(theme, "accent");
  const dimAll = !active;

  return (
    <Box flexDirection="column" paddingLeft={2} marginTop={gapAbove ? 1 : 0}>
      {todos.map((t, i) => {
        const glyph = t.status === "in_progress" ? "▸" : t.status === "completed" ? "☑" : "◻";
        return (
          <Text
            key={i}
            color={(t.status !== "in_progress" || dimAll) ? slotColor(theme, "textDim") : accent}
          >
            {glyph} {t.content}
          </Text>
        );
      })}
    </Box>
  );
}
