// The statusline module renders into the shared StatusBar, so it reuses the
// canonical StatusSegment shape (bold/dimColor/color/backgroundColor/newLine)
// rather than defining its own — the dead module's simpler local shape was
// superseded by src/ui/types.ts once StatusBar became the single renderer.
export type { StatusSegment } from "../types.js";

export interface SessionInfo {
  activeSessionId: string | null;
  messageCount: number;
  requestCount: number;
  totalTokens: number;
  activeTokens: number;
  maxContextTokens: number;
  model: string;
  reasoningEffort: string | undefined;
  toolUsage: Record<string, number>;
}

// ── Config-driven providers (deepcode-compatible statusline schema) ──

/** A provider that runs a shell command each refresh; first stdout line is the segment. */
export interface CommandProviderConfig {
  type: "command";
  id: string;
  command: string;
  color?: string;
  /** Per-run timeout in ms (default 1500). */
  timeoutMs?: number;
  /** Working directory for the command (default process.cwd()). */
  cwd?: string;
}

/** A provider that imports a local JS module and calls its default export. */
export interface ModuleProviderConfig {
  type: "module";
  id: string;
  /** Path to a local .js/.mjs module (resolved relative to cwd). */
  path: string;
  color?: string;
}

export type StatusLineProviderConfig = CommandProviderConfig | ModuleProviderConfig;

export interface StatusLineConfig {
  /** Master switch. Defaults to true when providers exist. */
  enabled: boolean;
  /** Refresh interval in ms (min 500, default 2000). */
  refreshMs: number;
  /** Separator between config-provider segments (default " · "). */
  separator: string;
  providers: StatusLineProviderConfig[];
}
