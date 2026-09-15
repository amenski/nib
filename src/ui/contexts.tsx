/**
 * Nib React Contexts — Theme, Keybinding, and Accessibility contexts
 * for the Ink-based TUI. These wire the theme.ts and keybindings.ts
 * infrastructure into React components via context.
 */

import React, { createContext, useContext, useMemo, useState } from "react";
import { resolveRefreshProfile, type ResolvedRefresh } from "./core/refresh-rates.js";
import {
  ThemeContextValue,
  createDefaultTheme,
  resolveTheme,
  type ThemeDefinition,
} from "./theme.js";
import {
  resolveKeybindings,
  type KeybindingMap,
  type KeybindingConfig,
} from "./keybindings.js";

// ── Theme Context ──

export interface ThemeProviderOptions {
  mode?: "dark" | "light" | "auto";
  /** Named builtin preset (e.g. "dracula"). Takes precedence over `mode`. */
  name?: string;
  overrides?: Partial<ThemeDefinition>;
  colorEnabled?: boolean;
}

/**
 * Map a single picker selection (a builtin preset key, or "dark"/"light"/"auto")
 * to the `{mode, name}` pair resolveTheme expects: a builtin preset goes in
 * `name` (which the resolver prefers), the three mode words go in `mode`.
 */
export function splitThemeSelection(
  selection: string,
): { mode: "dark" | "light" | "auto"; name?: string } {
  if (selection === "dark" || selection === "light" || selection === "auto") {
    return { mode: selection };
  }
  return { mode: "dark", name: selection };
}

const ThemeContext = createContext<ThemeContextValue>(createDefaultTheme());

/**
 * Runtime control over the live theme, exposed so the `/theme` picker can apply
 * a theme immediately (live preview) and revert. `name` is a builtin theme key
 * (e.g. "dark", "light", "high-contrast") or "auto" for system detection —
 * resolveTheme() maps any of these at runtime.
 */
export interface ThemeController {
  /** The name currently applied to the live UI. */
  current: string;
  /** Apply a theme name to the live UI (used for preview and confirm). */
  setThemeName: (name: string) => void;
}

const ThemeControllerContext = createContext<ThemeController>({
  current: "dark",
  setThemeName: () => {},
});

export function ThemeProvider({
  config,
  children,
}: {
  config?: ThemeProviderOptions;
  children: React.ReactNode;
}) {
  // The live theme name is component state (seeded from config) so the /theme
  // picker can retheme the running UI by calling setThemeName. It holds a single
  // selection: "dark" | "light" | "auto" | any builtin preset key. A named
  // preset in config seeds it (name wins over mode, matching resolveTheme).
  const [themeName, setThemeName] = useState<string>(
    config?.name ?? config?.mode ?? "dark",
  );
  const overrides = config?.overrides;

  const value = useMemo(() => {
    const { mode, name } = splitThemeSelection(themeName);
    const resolved = resolveTheme({ mode, name, overrides });
    const colorEnabled =
      config?.colorEnabled ?? (!!process.stdout.isTTY && !process.env.NO_COLOR);
    return new ThemeContextValue(resolved, colorEnabled);
  }, [themeName, JSON.stringify(overrides), config?.colorEnabled]);

  const controller = useMemo<ThemeController>(
    () => ({ current: themeName, setThemeName }),
    [themeName],
  );

  return (
    <ThemeControllerContext.Provider value={controller}>
      <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
    </ThemeControllerContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}

export function useThemeController(): ThemeController {
  return useContext(ThemeControllerContext);
}

// ── Keybinding Context ──

const KeybindingContext = createContext<KeybindingMap>({});

export function KeybindingProvider({
  config,
  children,
}: {
  config?: KeybindingConfig;
  children: React.ReactNode;
}) {
  const value = useMemo(() => resolveKeybindings(config), [config]);
  return (
    <KeybindingContext.Provider value={value}>
      {children}
    </KeybindingContext.Provider>
  );
}

export function useKeybindings(): KeybindingMap {
  return useContext(KeybindingContext);
}

// ── Terminal Info Context (responsive layout) ──

export interface TerminalInfo {
  columns: number;
  rows: number;
}

const TerminalContext = createContext<TerminalInfo>({
  columns: 80,
  rows: 24,
});

/**
 * How long the resize burst must go quiet before the new size is applied.
 * Long enough to swallow a drag gesture's SIGWINCH storm, short enough that
 * a deliberate resize still feels immediate.
 */
export const RESIZE_SETTLE_MS = 120;

// Ink-based tests commonly leave a rendered tree mounted until the worker is
// torn down. Keep one resize listener for all TerminalProvider instances so a
// forgotten test unmount cannot accumulate listeners on stdout. Production
// normally has one provider, so this is also a faithful one-listener model.
const terminalResizeSubscribers = new Set<() => void>();
let terminalResizeStream: NodeJS.WriteStream | null = null;

function dispatchTerminalResize(): void {
  for (const subscriber of terminalResizeSubscribers) subscriber();
}

function subscribeTerminalResize(subscriber: () => void): () => void {
  const stream = process.stdout;
  if (terminalResizeStream !== stream) {
    terminalResizeStream?.off("resize", dispatchTerminalResize);
    terminalResizeStream = stream;
    terminalResizeStream.on("resize", dispatchTerminalResize);
  }
  terminalResizeSubscribers.add(subscriber);

  return () => {
    terminalResizeSubscribers.delete(subscriber);
    if (terminalResizeSubscribers.size === 0 && terminalResizeStream) {
      terminalResizeStream.off("resize", dispatchTerminalResize);
      terminalResizeStream = null;
    }
  };
}

export function TerminalProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [info, setInfo] = React.useState<TerminalInfo>(() => ({
    columns: process.stdout.columns || 80,
    rows: process.stdout.rows || 24,
  }));

  React.useEffect(() => {
    // Dragging a window edge emits a SIGWINCH burst — dozens of events for one
    // gesture. Every one of them re-renders the live frame, and Ink erases its
    // previous frame using the row count from the OLD width, so a mid-drag
    // repaint clears too few rows and strands a copy of the frame on screen.
    // Coalesce the burst into one update at the settled size, and skip updates
    // where nothing actually changed (the old handler allocated a fresh object
    // every event, so the context value was always referentially new).
    let timer: ReturnType<typeof setTimeout> | undefined;

    const apply = () => {
      const columns = process.stdout.columns || 80;
      const rows = process.stdout.rows || 24;
      // No screen writes here — erasing from the React layer proved unfixable
      // both after Ink's paint (wipes the fresh frame, desyncs Ink's cursor
      // bookkeeping) and before it (erases visible transcript that isn't in
      // scrollback yet, and Ink never reprints <Static> content). The frame
      // artifact itself is corrected at the source in core/resize-repaint.ts.
      setInfo((prev) =>
        prev.columns === columns && prev.rows === rows ? prev : { columns, rows },
      );
    };

    const onResize = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(apply, RESIZE_SETTLE_MS);
    };

    const unsubscribeResize = subscribeTerminalResize(onResize);
    return () => {
      if (timer) clearTimeout(timer);
      unsubscribeResize();
    };
  }, []);

  return (
    <TerminalContext.Provider value={info}>
      {children}
    </TerminalContext.Provider>
  );
}

export function useTerminalInfo(): TerminalInfo {
  return useContext(TerminalContext);
}

// ── Accessibility Context (screen reader announcements) ──

export interface AccessibilityState {
  announce: (message: string, priority?: "polite" | "assertive") => void;
  lastAnnouncement: string;
  lastPriority: "polite" | "assertive";
}

const AccessibilityContext = createContext<AccessibilityState>({
  announce: () => {},
  lastAnnouncement: "",
  lastPriority: "polite",
});

export function AccessibilityProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [lastAnnouncement, setLastAnnouncement] = React.useState("");
  const [lastPriority, setLastPriority] = React.useState<"polite" | "assertive">("polite");

  const announce = React.useCallback(
    (message: string, priority: "polite" | "assertive" = "polite") => {
      setLastAnnouncement(message);
      setLastPriority(priority);
    },
    [],
  );

  const value = useMemo(
    () => ({ announce, lastAnnouncement, lastPriority }),
    [announce, lastAnnouncement, lastPriority],
  );

  return (
    <AccessibilityContext.Provider value={value}>
      {children}
    </AccessibilityContext.Provider>
  );
}

export function useAccessibility(): AccessibilityState {
  return useContext(AccessibilityContext);
}

export type RawMode = "lite" | "normal" | "raw";

export interface RawModeState {
  mode: RawMode;
  setMode: (mode: RawMode) => void;
}

const RawModeContext = createContext<RawModeState>({
  mode: "lite",
  setMode: () => {},
});

export function RawModeProvider({ children }: { children: React.ReactNode }) {
  const [mode, setMode] = React.useState<RawMode>("lite");
  const value = useMemo(() => ({ mode, setMode }), [mode]);
  return <RawModeContext.Provider value={value}>{children}</RawModeContext.Provider>;
}

export function useRawMode(): RawModeState {
  return useContext(RawModeContext);
}

// ── Refresh cadence ──
//
// How often the UI repaints. Provided through context rather than resolved at
// module load, because the value comes from settings.json — which is not
// available until after config is loaded, long after module evaluation.

const RefreshContext = React.createContext<ResolvedRefresh>(resolveRefreshProfile());

export function RefreshProvider(
  { value, children }: { value: ResolvedRefresh; children: React.ReactNode },
) {
  return <RefreshContext.Provider value={value}>{children}</RefreshContext.Provider>;
}

export function useRefresh(): ResolvedRefresh {
  return useContext(RefreshContext);
}
