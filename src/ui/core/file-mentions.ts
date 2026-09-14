import * as fs from "node:fs";
import * as path from "node:path";
import ignore from "ignore";
import { imageDataUrlFromBuffer, isImageFilePath } from "./clipboard.js";

export interface FileMentionItem {
  path: string;
  type: "file" | "directory";
}

const DEFAULT_MAX_ITEMS = 20000;
const DEFAULT_MAX_DEPTH = 8;
const NOISY_DIRS = new Set([
  ".git", ".next", ".pytest_cache", ".ruff_cache", "__pycache__",
  "build", "dist", "node_modules", "out", "target",
]);

export function scanFileMentionItems(root: string, maxItems = DEFAULT_MAX_ITEMS): FileMentionItem[] {
  const items: FileMentionItem[] = [];
  const seen = new Set<string>();

  function walk(dir: string, depth: number) {
    if (items.length >= maxItems || depth > DEFAULT_MAX_DEPTH) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const entry of entries) {
      if (items.length >= maxItems) return;
      if (entry.name.startsWith(".") || NOISY_DIRS.has(entry.name)) continue;
      const abs = path.join(dir, entry.name);
      const rel = path.relative(root, abs).replace(/\\/g, "/");
      if (seen.has(rel)) continue;
      seen.add(rel);
      if (entry.isDirectory()) {
        items.push({ path: rel + "/", type: "directory" });
        walk(abs, depth + 1);
      } else if (entry.isFile()) {
        items.push({ path: rel, type: "file" });
      }
    }
  }
  walk(root, 0);
  return items;
}

export function filterFileMentionItems(items: FileMentionItem[], query: string, maxResults = 12): FileMentionItem[] {
  const q = query.toLowerCase();
  const scored = items
    .map((item) => ({ item, score: scoreFileMention(item.path, q) }))
    .filter((s) => s.score !== Infinity)
    .sort((a, b) => a.score - b.score || a.item.path.length - b.item.path.length);
  return scored.slice(0, maxResults).map((s) => s.item);
}

// ── Submit-time expansion ────────────────────────────────────────────────────
// When the prompt is sent, `@path` tokens that name real files are read and
// attached to the model's view of the prompt as <file> blocks (Claude Code
// style). Tokens that don't resolve are left in place as plain text — they may
// be email addresses, usernames, or simply typos.

/**
 * Relative-to-cwd `@`-mention paths mentioned in a prompt, deduplicated, in
 * order of appearance. Mirrors the picker's token rules: `@` must sit at the
 * start of a line or after whitespace/`(`, so emails ("a@b.com") and
 * word-internal `@` are never treated as mentions.
 */
export function extractMentionedPaths(text: string): string[] {
  const paths: string[] = [];
  const re = /(^|[\s(])@([^\s@()]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    let token = m[2];
    // A mention glued to trailing prose punctuation ("@foo.ts,") is still a
    // mention — strip the punctuation before resolving the path.
    token = token.replace(/[.,;:!?)\]}]+$/, "");
    if (!token) continue;
    if (!paths.includes(token)) paths.push(token);
  }
  return paths;
}

/** Per-file cap on content attached via `@` (bytes of text, not tokens). */
const MAX_MENTION_CHARS = 60_000;

/** Per-file cap on an image attached via `@` (raw bytes, before base64). */
const MAX_MENTION_IMAGE_BYTES = 5 * 1024 * 1024;

/** What an `@`-mention expands into: text blocks plus image attachments. */
export interface MentionExpansion {
  /** One `<file path="…">` block per readable text mention. */
  blocks: string[];
  /** Data URLs for image mentions, in first-occurrence order. */
  imageUrls: string[];
}

/**
 * Reads each resolvable `@`-mention path and returns one `<file path="…">`
 * block per text file, ready to prepend to the prompt, plus a data URL for
 * each image mention. Unreadable paths are skipped silently — the mention
 * stays in the prompt as text.
 *
 * Images take a separate channel (MentionExpansion.imageUrls) because they
 * reach the model as pixels, not text: a base64 `<file>` block would put
 * bytes the model reads as garbage in the prompt. This branch must run BEFORE
 * the NUL-byte check below — every compressed image contains NUL bytes, so
 * without it a path-referenced image is silently dropped as binary.
 *
 * `gate` lets the caller subject mentions to permission rules before content
 * is injected (Claude Code behavior): a path returning "deny" is replaced
 * with a `[not injected: denied by permissions]` note inside its `<file>`
 * block instead of silently dropping the mention.
 */
export async function expandFileMentions(
  text: string,
  cwd = process.cwd(),
  gate?: (raw: string) => "allow" | "deny",
): Promise<MentionExpansion> {
  const blocks: string[] = [];
  const imageUrls: string[] = [];
  for (const raw of extractMentionedPaths(text)) {
    if (gate?.(raw) === "deny") {
      blocks.push(`<file path="${raw}">\n[not injected: denied by permissions]\n</file>`);
      continue;
    }
    const abs = path.resolve(cwd, raw);
    let buf: Buffer;
    try {
      buf = await fs.promises.readFile(abs);
    } catch {
      continue;
    }
    if (isImageFilePath(raw)) {
      if (buf.length === 0) continue;
      if (buf.length > MAX_MENTION_IMAGE_BYTES) {
        const mb = (buf.length / (1024 * 1024)).toFixed(1);
        blocks.push(
          `<file path="${raw}">\n[image not attached: ${mb} MB exceeds the ${MAX_MENTION_IMAGE_BYTES / (1024 * 1024)} MB limit]\n</file>`,
        );
        continue;
      }
      imageUrls.push(imageDataUrlFromBuffer(buf, raw));
      continue;
    }
    // NUL byte = binary; dumping raw binary into the prompt would garble the
    // model's view of the message and waste context on garbage.
    if (buf.includes(0)) continue;
    let content = buf.toString("utf8");
    if (content.length > MAX_MENTION_CHARS) {
      content = content.slice(0, MAX_MENTION_CHARS) + "\n… [truncated]";
    }
    blocks.push(`<file path="${raw}">\n${content}\n</file>`);
  }
  return { blocks, imageUrls };
}

function scoreFileMention(itemPath: string, query: string): number {
  if (!query) return itemPath.endsWith("/") ? 5 : 10;
  const p = itemPath.toLowerCase();
  const base = path.basename(itemPath.replace(/\/$/, "")).toLowerCase();
  if (p === query) return 0;
  if (p.startsWith(query)) return 1;
  if (base.startsWith(query)) return 3;
  const idx = p.indexOf(query);
  if (idx >= 0) return 20 + idx;
  return Infinity;
}
