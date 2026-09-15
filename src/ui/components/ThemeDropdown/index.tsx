import React, { useEffect, useState } from "react";
import { useInput } from "ink";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import DropdownMenu from "../DropdownMenu/index.js";
import { BUILTIN_THEMES } from "../../theme.js";
import { resolveHome } from "../../../config/loader.js";

/** Sentinel name for the "follow the system theme" entry. */
export const AUTO_THEME = "auto";

/**
 * The theme names offered by the picker: every builtin theme (read dynamically
 * from BUILTIN_THEMES so presets added elsewhere show up automatically) plus an
 * "auto (system)" entry. Order: builtins in insertion order, then auto last.
 */
export function themeChoices(): string[] {
  return [...Object.keys(BUILTIN_THEMES), AUTO_THEME];
}

/**
 * Pure revert helper: given the theme name active when the picker opened and the
 * name currently previewed, return the name the live UI should end on for a
 * given outcome. Extracted so the open/preview/confirm/revert logic is testable
 * without React.
 */
export function resolveThemeOutcome(
  original: string,
  previewed: string,
  outcome: "confirm" | "revert",
): string {
  return outcome === "confirm" ? previewed : original;
}

/**
 * Read-modify-write the user-level settings.json: read (tolerating a missing
 * or corrupt file), hand the parsed object to `mutate` to merge in whatever
 * changed, then write back atomically (temp file + rename), mirroring the
 * permission engine's persist(). `homeDir` defaults to NIB_HOME. Never
 * writes project settings.
 *
 * Shared by every settings.json writer in the picker UI (theme, favorite
 * models, recent models) so there is exactly one atomic-write implementation.
 */
export function updateSettings(
  mutate: (config: Record<string, unknown>) => void,
  homeDir?: string,
): void {
  const dir = homeDir ?? resolveHome();
  const settingsPath = join(dir, "settings.json");

  let config: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try {
      const parsed = JSON.parse(readFileSync(settingsPath, "utf-8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        config = parsed as Record<string, unknown>;
      }
    } catch {
      // Corrupt file — start from empty rather than clobber-and-crash.
    }
  }

  mutate(config);

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const tmpPath = join(dir, `.settings.json.${randomBytes(6).toString("hex")}.tmp`);
  writeFileSync(tmpPath, JSON.stringify(config, null, 2), "utf-8");
  renameSync(tmpPath, settingsPath);
}

/**
 * Persist the chosen theme into the user-level settings.json `theme` block.
 * Existing settings are preserved; only `theme` is merged.
 *
 * "auto" is stored as `theme.mode = "auto"`; a builtin preset name is stored as
 * `theme.mode = <name>` (the loader/resolver accept a preset name in `mode`).
 */
export function persistThemeChoice(name: string, homeDir?: string): void {
  updateSettings((config) => {
    const existingTheme =
      config.theme && typeof config.theme === "object" && !Array.isArray(config.theme)
        ? (config.theme as Record<string, unknown>)
        : {};
    config.theme = { ...existingTheme, mode: name };
  }, homeDir);
}

interface Props {
  open: boolean;
  /** The theme name applied when the picker opened (the revert target). */
  currentName: string;
  width: number;
  /** Apply a theme name to the live UI (live preview + confirm). */
  onPreview: (name: string) => void;
  /** Confirm: persist the chosen name and close. */
  onConfirm: (name: string) => void;
  /** Cancel: revert to the pre-open theme and close. */
  onCancel: () => void;
}

const ThemeDropdown: React.FC<Props> = ({
  open,
  currentName,
  width,
  onPreview,
  onConfirm,
  onCancel,
}) => {
  const choices = React.useMemo(() => themeChoices(), []);
  const [activeIndex, setActiveIndex] = useState(0);

  // Seed the cursor on the currently-active theme when the picker opens.
  useEffect(() => {
    if (!open) return;
    const idx = choices.indexOf(currentName);
    setActiveIndex(idx >= 0 ? idx : 0);
  }, [open, choices, currentName]);

  // Live preview: whenever the highlighted entry changes, apply it to the live
  // UI immediately so the user sees the theme before confirming.
  useEffect(() => {
    if (!open) return;
    const name = choices[activeIndex];
    if (name) onPreview(name);
  }, [open, activeIndex, choices]);

  useInput(
    (input, key) => {
      if (!open) return;
      const count = choices.length;
      if (key.upArrow) {
        setActiveIndex((i) => (i - 1 + count) % count);
        return;
      }
      if (key.downArrow) {
        setActiveIndex((i) => (i + 1) % count);
        return;
      }
      if ((input === " " && !key.ctrl && !key.meta) || (key.return && !key.shift && !key.meta)) {
        onConfirm(choices[activeIndex]);
        return;
      }
      if (key.tab || key.escape) {
        onCancel();
        return;
      }
    },
    { isActive: open },
  );

  if (!open) return null;

  const items = choices.map((name) => ({
    key: name,
    label: name === AUTO_THEME ? "auto (system)" : name,
    description: name === currentName ? "current" : "",
    selected: name === currentName,
  }));

  return (
    <DropdownMenu
      width={width}
      title="Select Theme"
      helpText="↑↓ preview · Space/Enter apply · Esc revert"
      items={items}
      activeIndex={activeIndex}
      activeColor="#229ac3"
      maxVisible={8}
    />
  );
};

export default ThemeDropdown;
