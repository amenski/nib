/**
 * Replace each tab with spaces up to the next 8-column stop.
 *
 * Ink measures a tab as one column, but the terminal advances it to the next
 * tab stop, so a line with tabs (`od -c`, `git log --format=%x09`, Makefiles)
 * overflowed the width Ink laid it out for and its tail wrapped to column 0.
 * ANSI escapes and the transcript's control-character tags take no columns.
 */
export function expandTabs(text: string, tabSize = 8): string {
  if (!text.includes("\t")) return text;
  let out = "";
  let col = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === "\x1b") {
      const m = /^\x1b\[[0-9;?]*[ -/]*[@-~]/.exec(text.slice(i));
      if (m) {
        out += m[0];
        i += m[0].length - 1;
        continue;
      }
    }
    if (ch === "\t") {
      const pad = tabSize - (col % tabSize);
      out += " ".repeat(pad);
      col += pad;
    } else if (ch === "\n") {
      out += ch;
      col = 0;
    } else {
      out += ch;
      if (ch >= " ") col++;
    }
  }
  return out;
}
