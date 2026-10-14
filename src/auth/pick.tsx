import React from "react";
import { render } from "ink";
import { ThemeProvider } from "../ui/contexts.js";
import SearchPicker, { type SearchPickerItem } from "../ui/views/SearchPicker.js";

/**
 * Show a type-to-filter list as its own short-lived Ink render (the
 * promptSettingsTrust pattern in cli.tsx) and resolve the chosen item's id,
 * or null on Esc / Ctrl+C.
 */
export function pickFromList(title: string, items: SearchPickerItem[], initialId?: string): Promise<string | null> {
  return new Promise((resolvePromise) => {
    const done = (id: string | null) => {
      inkInstance.unmount();
      // Ink unrefs stdin as it exits. Wait for that, then ref it again, or the
      // process quits silently while the next prompt waits for a keypress.
      void inkInstance.waitUntilExit().then(() => {
        process.stdin.ref();
        resolvePromise(id);
      });
    };
    const width = Math.min(process.stdout.columns || 80, 80);
    const height = Math.min(process.stdout.rows || 24, 30);
    const inkInstance = render(
      <ThemeProvider>
        <SearchPicker
          title={title}
          items={items}
          initialId={initialId}
          onSelect={(id) => done(id)}
          onCancel={() => done(null)}
          width={width}
          height={height}
        />
      </ThemeProvider>,
      { exitOnCtrlC: false },
    );
  });
}
