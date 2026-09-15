/**
 * Nib Keybinding System
 *
 * Fully offline, configurable keyboard shortcut engine.
 * Supports chord sequences, modifier combinations, and remapping.
 * Keybindings are loaded from config and merged with built-in defaults.
 *
 * No external dependencies — pure TypeScript.
 */

// ── Types ──

export interface KeyCombination {
  /** The primary key name (e.g. 'c', 'enter', 'escape', 'tab') */
  key: string;
  /** Modifier keys */
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  alt?: boolean;
}

export type KeybindingAction =
  // Navigation
  | "cursorLeft"
  | "cursorRight"
  | "cursorWordLeft"
  | "cursorWordRight"
  | "cursorHome"
  | "cursorEnd"
  // Editing
  | "deleteCharLeft"
  | "deleteCharRight"
  | "deleteWordLeft"
  | "deleteWordRight"
  | "deleteLine"
  // History
  | "historyPrev"
  | "historyNext"
  | "historySearch"
  // Completion
  | "complete"
  | "completePartial"
  // Submit & Abort
  | "submit"
  | "abort"
  | "cancel"
  // Mode & App
  | "openModelPicker"
  | "openCommandPalette"
  | "toggleTheme"
  // Multiplex
  | "tabNext"
  | "tabPrev"
  | "tabClose"
  | "tabNew"
  | "splitHorizontal"
  | "splitVertical"
  | "splitClose"
  // View
  | "pageUp"
  | "pageDown"
  | "scrollToTop"
  | "scrollToBottom"
  | "clearScreen"
  // Search
  | "find"
  | "findNext"
  | "findPrev"
  // Panels
  | "toggleStatusBar"
  | "toggleMinimap"
  | "toggleSidebar"
  // Custom
  | "custom1"
  | "custom2"
  | "custom3";

export type KeybindingMap = Partial<Record<KeybindingAction, KeyCombination[]>>;

export interface KeybindingConfig {
  /** User-defined overrides on top of defaults */
  overrides?: KeybindingMap;
  /** Disable specific actions entirely */
  disabled?: KeybindingAction[];
}

// ── Default Keybindings ──

const DEFAULT_BINDINGS: KeybindingMap = {
  // Navigation
  cursorLeft: [{ key: "left" }],
  cursorRight: [{ key: "right" }],
  cursorWordLeft: [{ key: "left", ctrl: true }, { key: "left", alt: true }],
  cursorWordRight: [{ key: "right", ctrl: true }, { key: "right", alt: true }],
  cursorHome: [{ key: "home" }],
  cursorEnd: [{ key: "end" }],

  // Editing
  deleteCharLeft: [{ key: "backspace" }],
  deleteCharRight: [{ key: "delete" }],
  deleteWordLeft: [{ key: "backspace", ctrl: true }, { key: "backspace", alt: true }],
  deleteWordRight: [{ key: "delete", ctrl: true }, { key: "delete", alt: true }],
  deleteLine: [{ key: "u", ctrl: true }],

  // History
  historyPrev: [{ key: "upArrow" }, { key: "p", ctrl: true }],
  historyNext: [{ key: "downArrow" }, { key: "n", ctrl: true }],
  historySearch: [{ key: "r", ctrl: true }],

  // Completion
  complete: [{ key: "tab" }],
  completePartial: [{ key: "tab", shift: true }],

  // Submit & Abort
  submit: [{ key: "return" }],
  abort: [{ key: "escape" }],
  cancel: [{ key: "c", ctrl: true }],

  // Mode & App
  // Unbound by default: Ctrl+M cannot exist in a terminal — 0x0D is the SAME
  // BYTE as Enter, consumed as `return` by the input parser before any ctrl
  // detection. (Ctrl+I is likewise Tab, 0x09.) The action stays so a user
  // keybindings.json can bind a chord that actually encodes; /model and the
  // slash menu are the default routes.
  openModelPicker: [],
  // NOTE: unreachable in a standard terminal. Ctrl+P and Ctrl+Shift+P both
  // arrive as byte 0x10 — shift is not encoded — so a shift-qualified binding
  // can never match, and PromptInput claims ctrl+p for history navigation
  // before App's useInput would see it. "/" opens the same command list in the
  // prompt with fuzzy filtering. Kept so a user-supplied keybindings.json can
  // still bind the action to a chord that does encode (e.g. a function key).
  openCommandPalette: [{ key: "p", ctrl: true, shift: true }],
  toggleTheme: [{ key: "t", ctrl: true, shift: true }],

  // Multiplex
  tabNext: [{ key: "tab", ctrl: true }],
  tabPrev: [{ key: "tab", ctrl: true, shift: true }],
  tabClose: [{ key: "w", ctrl: true }],
  tabNew: [{ key: "t", ctrl: true }],
  splitHorizontal: [{ key: '"', ctrl: true, shift: true }],
  splitVertical: [{ key: "%", ctrl: true, shift: true }],
  splitClose: [{ key: "w", ctrl: true }],

  // View
  pageUp: [{ key: "pageUp" }],
  pageDown: [{ key: "pageDown" }],
  scrollToTop: [{ key: "home", ctrl: true }],
  scrollToBottom: [{ key: "end", ctrl: true }],
  clearScreen: [{ key: "l", ctrl: true }],

  // Search
  find: [{ key: "f", ctrl: true }],
  findNext: [{ key: "g", ctrl: true }],
  findPrev: [{ key: "g", ctrl: true, shift: true }],

  // Panels
  toggleStatusBar: [{ key: "s", ctrl: true, shift: true }],
};

// ── Keybinding Resolution ──

/**
 * Parse a keybinding string from config into a KeyCombination.
 * Supports formats: "ctrl+c", "meta+shift+z", "alt+tab", "escape", etc.
 */
export function parseKeyCombo(str: string): KeyCombination | null {
  const parts = str.toLowerCase().split("+").map((p) => p.trim());
  if (parts.length === 0) return null;

  const combo: KeyCombination = { key: "" };

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (i === parts.length - 1) {
      combo.key = part;
    } else {
      switch (part) {
        case "ctrl":
        case "control":
          combo.ctrl = true;
          break;
        case "meta":
        case "cmd":
        case "command":
          combo.meta = true;
          break;
        case "shift":
          combo.shift = true;
          break;
        case "alt":
        case "option":
          combo.alt = true;
          break;
        default:
          // Unknown modifier — treat as part of key name
          combo.key = part;
          return combo;
      }
    }
  }

  return combo;
}

/**
 * Serialize a KeyCombination to a human-readable string (for display).
 */
export function formatKeyCombo(combo: KeyCombination): string {
  const parts: string[] = [];
  if (combo.ctrl) parts.push("Ctrl");
  if (combo.alt) parts.push("Alt");
  if (combo.meta) parts.push("Cmd");
  if (combo.shift) parts.push("Shift");

  const keyName = formatKeyName(combo.key);
  if (keyName) parts.push(keyName);

  return parts.join("+");
}

function formatKeyName(key: string): string {
  const names: Record<string, string> = {
    return: "Enter",
    escape: "Esc",
    backspace: "Bksp",
    delete: "Del",
    upArrow: "↑",
    downArrow: "↓",
    leftArrow: "←",
    rightArrow: "→",
    tab: "Tab",
    space: "Space",
    pageUp: "PgUp",
    pageDown: "PgDn",
    home: "Home",
    end: "End",
  };
  return names[key] ?? key.toUpperCase();
}

/**
 * Match an Ink `key` object against a KeyCombination.
 */
export function matchKeyCombo(key: Record<string, any>, combo: KeyCombination): boolean {
  // Ctrl+C is special — Ink sends it as ctrl+c with no `.ctrl` property
  const isCtrlC = key.ctrl && key.name === "c" && !key.meta && !key.shift && !key.alt;

  const nameMatch = key.name === combo.key || key.key === combo.key;
  if (!nameMatch) return false;

  // Modifier matching (Ink uses lowercase booleans)
  const ctrlMatch = isCtrlC ? !!combo.ctrl : (key.ctrl || false) === (combo.ctrl || false);
  const metaMatch = (key.meta || false) === (combo.meta || false);
  const shiftMatch = (key.shift || false) === (combo.shift || false);

  return ctrlMatch && metaMatch && shiftMatch;
}

/**
 * Resolve a full keybinding map from config overrides.
 * Disabled actions are removed from the map.
 */
export function resolveKeybindings(config?: KeybindingConfig): KeybindingMap {
  // Deep clone defaults
  const map: KeybindingMap = {};
  for (const [action, combos] of Object.entries(DEFAULT_BINDINGS)) {
    map[action as KeybindingAction] = [...combos];
  }

  if (!config) return map;

  // Apply overrides
  if (config.overrides) {
    for (const [action, combos] of Object.entries(config.overrides)) {
      map[action as KeybindingAction] = combos;
    }
  }

  // Remove disabled
  if (config.disabled) {
    for (const action of config.disabled) {
      delete map[action];
    }
  }

  return map;
}

// ── Action Lookup ──

export interface BoundKeybinding {
  action: KeybindingAction;
  combos: KeyCombination[];
}

/**
 * Find all actions bound to a given Ink key event.
 * Returns an array of matching actions (usually 0 or 1).
 */
export function lookupAction(
  key: Record<string, any>,
  bindings: KeybindingMap,
): KeybindingAction[] {
  const results: KeybindingAction[] = [];

  for (const [action, combos] of Object.entries(bindings)) {
    if (!combos) continue;
    for (const combo of combos) {
      if (matchKeyCombo(key, combo)) {
        results.push(action as KeybindingAction);
        break;
      }
    }
  }

  return results;
}

/**
 * Get the display string for an action's primary keybinding.
 */
export function getActionShortcut(
  action: KeybindingAction,
  bindings: KeybindingMap,
): string {
  const combos = bindings[action];
  if (!combos || combos.length === 0) return "";
  return formatKeyCombo(combos[0]);
}

// ── Help Text Generator ──

export function generateHelpText(bindings: KeybindingMap): string {
  const sections: { title: string; actions: KeybindingAction[] }[] = [
    {
      title: "Navigation",
      actions: ["cursorLeft", "cursorRight", "cursorWordLeft", "cursorWordRight", "cursorHome", "cursorEnd"],
    },
    {
      title: "Editing",
      actions: ["deleteCharLeft", "deleteCharRight", "deleteWordLeft", "deleteWordRight", "deleteLine"],
    },
    {
      title: "History",
      actions: ["historyPrev", "historyNext", "historySearch"],
    },
    {
      title: "Completion",
      actions: ["complete", "completePartial"],
    },
    {
      title: "Submit & Abort",
      actions: ["submit", "abort", "cancel"],
    },
    {
      title: "App",
      actions: ["openModelPicker", "openCommandPalette"],
    },
    {
      title: "Tabs & Panes",
      actions: ["tabNext", "tabPrev", "tabClose", "tabNew", "splitHorizontal", "splitVertical"],
    },
  ];

  const lines: string[] = [];
  for (const section of sections) {
    lines.push(`  ${section.title}:`);
    for (const action of section.actions) {
      const shortcut = getActionShortcut(action, bindings);
      if (!shortcut) continue;
      const actionLabel = action
        .replace(/([A-Z])/g, " $1")
        .replace(/^./, (s) => s.toUpperCase())
        .trim();
      lines.push(`    ${shortcut.padEnd(18)} ${actionLabel}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
