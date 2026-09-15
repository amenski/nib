import { createInterface } from "node:readline";

const CTRL_C = "";
const CTRL_H = ""; // backspace
const CTRL_U = ""; // clear line
const DEL = ""; // terminal backspace

/**
 * Reads a single line of input without echoing the characters.
 *
 * On a TTY, raw mode is enabled and each typed character is masked with `*`.
 * Handles Backspace/Ctrl+H (erase one char), Ctrl+U (clear the line),
 * Ctrl+C (cancel → resolves to `null`, nothing written), and Enter (submit).
 *
 * On a non-TTY stdin (e.g. `echo KEY | nib auth ...`), the prompt is
 * skipped and a single line is read verbatim from the pipe.
 *
 * Returns the entered line, or `null` if the user cancelled (Ctrl+C).
 */
export function readHiddenLine(prompt: string): Promise<string | null> {
  const input = process.stdin;

  if (!input.isTTY) {
    return new Promise((resolve) => {
      const rl = createInterface({ input });
      let resolved = false;
      const done = (value: string | null) => {
        if (resolved) return;
        resolved = true;
        rl.close();
        resolve(value);
      };
      rl.once("line", (line) => done(line));
      rl.once("close", () => done(null));
    });
  }

  return new Promise((resolve) => {
    process.stdout.write(prompt);

    const chars: string[] = [];
    const wasRaw = input.isRaw ?? false;
    input.setRawMode(true);
    input.resume();
    if (typeof input.setEncoding === "function") input.setEncoding("utf-8");

    const cleanup = () => {
      input.setRawMode(wasRaw);
      input.pause();
      input.removeListener("data", onData);
    };

    const onData = (data: string) => {
      for (const ch of data) {
        if (ch === "\r" || ch === "\n") {
          process.stdout.write("\n");
          cleanup();
          resolve(chars.join(""));
          return;
        }
        if (ch === CTRL_C) {
          // Cancel — write nothing.
          process.stdout.write("\n");
          cleanup();
          resolve(null);
          return;
        }
        if (ch === CTRL_U) {
          // Clear the current line.
          if (chars.length > 0) {
            process.stdout.write("\b \b".repeat(chars.length));
            chars.length = 0;
          }
          continue;
        }
        if (ch === CTRL_H || ch === DEL) {
          // Erase one char.
          if (chars.length > 0) {
            chars.pop();
            process.stdout.write("\b \b");
          }
          continue;
        }
        // Echo printable characters as `*`; ignore other control chars.
        if (ch >= " ") {
          chars.push(ch);
          process.stdout.write("*");
        }
      }
    };

    input.on("data", onData);
  });
}
