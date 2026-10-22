import { execFileSync } from 'node:child_process';

// Date (YYYY-MM-DD) of the last git commit touching these paths, relative to site/.
// Undefined when git has no commit for them, so callers can leave the date out.
export function gitDate(...paths) {
  try {
    const out = execFileSync('git', ['log', '-1', '--format=%cs', '--', ...paths], { encoding: 'utf8' }).trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}
