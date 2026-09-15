/**
 * Nib HelpOverlay — Interactive keyboard shortcut and command reference.
 *
 * Displays a modal overlay with categorized keyboard shortcuts and slash commands.
 * Invoked via Ctrl+Shift+/ (or /help).
 */

import React, { useState, useMemo } from "react";
import { Box, Text, useInput } from "ink";
import { useKeybindings, useTheme } from "./contexts.js";
import {
  formatKeyCombo,
  type KeybindingAction,
} from "./keybindings.js";

interface HelpOverlayProps {
  onClose: () => void;
}

interface HelpSection {
  title: string;
  items: { action: string; shortcut: string; description: string }[];
}

// Build-time section with actions array, mapped to items later
interface HelpSectionBuild {
  title: string;
  actions: string[];
}

const SLASH_COMMANDS: { command: string; description: string }[] = [
  { command: "/help", description: "Show this help screen" },
  { command: "/exit", description: "Exit the CLI" },
  { command: "/clear", description: "Clear conversation history" },
  { command: "/new", description: "Start a fresh conversation" },
  { command: "/mode <slug>", description: "Switch persona (general/code)" },
  { command: "/modes", description: "List available modes" },
  { command: "/model", description: "Show/switch provider/model" },
  { command: "/theme", description: "Switch color theme (live preview)" },
  { command: "/plan", description: "Toggle plan mode (propose before implementing)" },
  { command: "/resume", description: "Pick a previous session" },
  { command: "/continue", description: "Continue the active session" },
  { command: "/sessions", description: "List sessions" },
  { command: "/undo", description: "Restore to a previous point" },
  { command: "/mcp", description: "Show MCP server status" },
  { command: "/tasks", description: "Show running sub-agent tasks" },
  { command: "/permissions", description: "Show this session's permission history" },
  { command: "/raw", description: "Cycle display mode (lite | normal | raw-scrollback)" },
  { command: "/skills", description: "List available skills" },
  { command: "/skill <name>", description: "Print a skill's contents" },
  { command: "/cost", description: "Show session token totals and cost" },
  { command: "/usage", description: "Show account balance and token usage" },
  { command: "/effort", description: "Show/set reasoning effort" },
];

const KEY_ACTION_LABELS: Record<KeybindingAction, string> = {
  cursorLeft: "Move cursor left",
  cursorRight: "Move cursor right",
  cursorWordLeft: "Move cursor word left",
  cursorWordRight: "Move cursor word right",
  cursorHome: "Go to line start",
  cursorEnd: "Go to line end",
  deleteCharLeft: "Delete character left",
  deleteCharRight: "Delete character right",
  deleteWordLeft: "Delete word left",
  deleteWordRight: "Delete word right",
  deleteLine: "Clear line",
  historyPrev: "Previous history entry",
  historyNext: "Next history entry",
  historySearch: "Search history (fuzzy)",
  complete: "Autocomplete",
  completePartial: "Partial complete",
  submit: "Submit prompt",
  abort: "Abort current generation",
  cancel: "Cancel / clear input",
  openModelPicker: "Open model picker",
  openCommandPalette: "Open command palette",
  toggleTheme: "Toggle dark/light theme",
  tabNext: "Next tab",
  tabPrev: "Previous tab",
  tabClose: "Close tab",
  tabNew: "New tab",
  splitHorizontal: "Split horizontal",
  splitVertical: "Split vertical",
  splitClose: "Close split",
  pageUp: "Scroll up",
  pageDown: "Scroll down",
  scrollToTop: "Scroll to top",
  scrollToBottom: "Scroll to bottom",
  clearScreen: "Clear screen",
  find: "Find in output",
  findNext: "Find next",
  findPrev: "Find previous",
  toggleStatusBar: "Toggle status bar",
  toggleMinimap: "Toggle minimap",
  toggleSidebar: "Toggle sidebar",
  custom1: "Custom action 1",
  custom2: "Custom action 2",
  custom3: "Custom action 3",
};

export default function HelpOverlay({ onClose }: HelpOverlayProps) {
  const bindings = useKeybindings();
  const theme = useTheme();

  const [tab, setTab] = useState<"shortcuts" | "commands">("shortcuts");

  useInput((_value: string, key: any) => {
    if (key.escape || (key.ctrl && key.name === "c")) {
      onClose();
      return;
    }
    if (key.leftArrow || key.rightArrow) {
      setTab((t) => (t === "shortcuts" ? "commands" : "shortcuts"));
      return;
    }
  });

  const shortcutSections = useMemo(() => {
    const sections: HelpSectionBuild[] = [
      {
        title: "Navigation",
        actions: [
          "cursorLeft", "cursorRight", "cursorWordLeft", "cursorWordRight",
          "cursorHome", "cursorEnd",
        ],
      },
      {
        title: "Editing",
        actions: [
          "deleteCharLeft", "deleteCharRight", "deleteWordLeft",
          "deleteWordRight", "deleteLine",
        ],
      },
      {
        title: "History & Completion",
        actions: ["historyPrev", "historyNext", "historySearch", "complete"],
      },
      {
        title: "Submit & Abort",
        actions: ["submit", "abort", "cancel"],
      },
      {
        title: "App Controls",
        actions: [
          "openModelPicker", "openCommandPalette",
          "toggleTheme", "clearScreen",
        ],
      },
      {
        title: "View & Search",
        actions: ["find", "findNext", "findPrev", "pageUp", "pageDown"],
      },
    ];

    return sections.map((s: HelpSectionBuild) => ({
      title: s.title,
      items: s.actions
        .filter((a) => bindings[a as KeybindingAction])
        .map((a) => {
          const action = a as KeybindingAction;
          const combos = bindings[action];
          const shortcut = combos && combos.length > 0
            ? combos.map((c) => formatKeyCombo(c)).join(" / ")
            : "";
          return {
            action: KEY_ACTION_LABELS[action] ?? action,
            shortcut,
            description: "",
          };
        }),
    }));
  }, [bindings]);

  const commandSection: HelpSection = {
    title: "Slash Commands",
    items: SLASH_COMMANDS.map((c) => ({
      action: c.command,
      shortcut: "",
      description: c.description,
    })),
  };

  const currentSection: HelpSection[] = tab === "shortcuts" ? shortcutSections : [commandSection];

  const dim = (s: string) => (theme.colorEnabled ? `\x1b[2m${s}\x1b[0m` : s);
  const bright = (s: string) => (theme.colorEnabled ? `\x1b[97m${s}\x1b[0m` : s);

  return (
    <Box flexDirection="column" marginTop={1} marginBottom={1}>
      {/* Header */}
      <Box>
        <Text>
          {dim("\u250C")}
          {tab === "shortcuts" ? bright(" Keyboard Shortcuts ") : dim(" Keyboard Shortcuts ")}
          <Text bold> </Text>
          {tab === "commands" ? bright(" Slash Commands ") : dim(" Slash Commands ")}
          {dim(" \u2500".repeat(20))}
        </Text>
      </Box>

      {/* Tab navigation hint */}
      <Box>
        <Text dimColor>{dim("  \u2190\u2192 switch tab     Esc close")}</Text>
      </Box>

      {/* Content */}
      {currentSection.map((section) => (
        <Box key={section.title} flexDirection="column" marginTop={1}>
          <Box>
            <Text bold>{section.title}</Text>
          </Box>
          {section.items.map((item, i) => {
            const actionCol = Math.max(
              ...section.items.map((si) => si.action.length),
              20,
            );
            const paddedAction = item.action.padEnd(
              Math.min(actionCol, 40),
            );
            return (
              <Box key={i}>
                <Text>
                  {"  "}
                  <Text>{paddedAction}</Text>
                  {item.shortcut ? (
                    <Text dimColor>{dim(`  ${item.shortcut}`)}</Text>
                  ) : null}
                  {item.description ? (
                    <Text dimColor>{dim(`   ${item.description}`)}</Text>
                  ) : null}
                </Text>
              </Box>
            );
          })}
        </Box>
      ))}

      {/* Footer */}
      <Box marginTop={1}>
        <Text dimColor>{dim("\u2514" + "\u2500".repeat(40))}</Text>
      </Box>
    </Box>
  );
}
