export type SlashCommandKind =
  | "model" | "mode" | "effort" | "new" | "resume" | "continue" | "undo" | "mcp" | "tasks" | "permissions" | "usage" | "exit" | "help" | "clear" | "skills" | "plan" | "raw" | "doctor" | "context" | "compact";

export interface SlashCommandItem {
  kind: SlashCommandKind;
  name: string;
  label: string;
  description: string;
}

export const BUILTIN_SLASH_COMMANDS: SlashCommandItem[] = [
  { kind: "skills", name: "skills", label: "/skills", description: "List available skills" },
  { kind: "model", name: "model", label: "/model", description: "Select model" },
  { kind: "mode", name: "mode", label: "/mode", description: "Switch persona (general/code)" },
  { kind: "effort", name: "effort", label: "/effort", description: "Set reasoning effort" },
  { kind: "new", name: "new", label: "/new", description: "Start a fresh conversation" },
  { kind: "resume", name: "resume", label: "/resume", description: "Pick a previous session" },
  { kind: "continue", name: "continue", label: "/continue", description: "Continue the active session" },
  { kind: "undo", name: "undo", label: "/undo", description: "Restore to a previous point" },
  { kind: "mcp", name: "mcp", label: "/mcp", description: "Show MCP server status" },
  { kind: "tasks", name: "tasks", label: "/tasks", description: "Show running sub-agent tasks" },
  { kind: "permissions", name: "permissions", label: "/permissions", description: "Show this session's permission decision history" },
  { kind: "usage", name: "usage", label: "/usage", description: "Show account balance and token usage" },
  { kind: "plan", name: "plan", label: "/plan", description: "Toggle plan mode (propose before implementing)" },
  { kind: "raw", name: "raw", label: "/raw", description: "Cycle display mode (lite | normal | raw-scrollback)" },
  { kind: "clear", name: "clear", label: "/clear", description: "Clear the conversation and the screen" },
  { kind: "compact", name: "compact", label: "/compact", description: "Summarize older turns to free context" },
  { kind: "context", name: "context", label: "/context", description: "Show context usage and when compaction triggers" },
  { kind: "doctor", name: "doctor", label: "/doctor", description: "Show provider, model, and refresh settings" },
  { kind: "help", name: "help", label: "/help", description: "Show help" },
  { kind: "exit", name: "exit", label: "/exit", description: "Quit" },
];

export function getSlashCommands(): SlashCommandItem[] {
  return BUILTIN_SLASH_COMMANDS;
}

export function filterSlashCommands(items: SlashCommandItem[], token: string): SlashCommandItem[] {
  if (!token.startsWith("/")) return [];
  const query = token.slice(1).toLowerCase();
  if (!query) return items;
  return items.filter((item) => item.name.toLowerCase().includes(query));
}

export function findExactSlashCommand(items: SlashCommandItem[], token: string): SlashCommandItem | null {
  if (!token.startsWith("/")) return null;
  const query = token.slice(1);
  return items.find((item) => item.name === query) ?? null;
}
