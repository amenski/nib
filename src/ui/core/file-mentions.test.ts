import { describe, it, expect, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  scanFileMentionItems,
  filterFileMentionItems,
  extractMentionedPaths,
  expandFileMentions,
} from "./file-mentions.js";
import { PermissionEngine, ProfileEvaluator, authorize } from "../../permissions/index.js";

describe("scanFileMentionItems", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nib-mentions-"));
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it("lists files and directories with directories first, skipping noise and dotfiles", () => {
    fs.mkdirSync(path.join(root, "src"));
    fs.mkdirSync(path.join(root, "node_modules"));
    fs.writeFileSync(path.join(root, ".env"), "SECRET=1");
    fs.writeFileSync(path.join(root, "src", "main.ts"), "export const x = 1;");
    fs.writeFileSync(path.join(root, "README.md"), "# hi");

    const items = scanFileMentionItems(root);
    expect(items).toContainEqual({ path: "src/", type: "directory" });
    expect(items).toContainEqual({ path: "src/main.ts", type: "file" });
    expect(items).toContainEqual({ path: "README.md", type: "file" });
    expect(items.some((i) => i.path.includes("node_modules"))).toBe(false);
    expect(items.some((i) => i.path.includes(".env"))).toBe(false);
    // Directories sort before files.
    expect(items[0].type).toBe("directory");
  });
});

describe("filterFileMentionItems", () => {
  const items = [
    { path: "src/ui/App.tsx", type: "file" as const },
    { path: "src/ui/", type: "directory" as const },
    { path: "README.md", type: "file" as const },
  ];

  it("empty query ranks directories ahead of files", () => {
    const [first, second] = filterFileMentionItems(items, "");
    expect(first.type).toBe("directory");
    expect(second.type).toBe("file");
  });

  it("prefix matches beat basename matches", () => {
    const byPrefix = filterFileMentionItems(items, "src");
    expect(byPrefix[0].path).toBe("src/ui/");
    const byBase = filterFileMentionItems(items, "readme");
    expect(byBase[0].path).toBe("README.md");
  });
});

describe("extractMentionedPaths", () => {
  it("finds @mentions at start of line or after whitespace", () => {
    expect(extractMentionedPaths("@README.md")).toEqual(["README.md"]);
    expect(extractMentionedPaths("look at @src/main.ts please")).toEqual(["src/main.ts"]);
  });

  it("ignores emails, word-internal @, and @ with a slash or parens", () => {
    expect(extractMentionedPaths("mail me at a@b.com")).toEqual([]);
    expect(extractMentionedPaths("foo@bar")).toEqual([]);
    expect(extractMentionedPaths("hi @(")).toEqual([]);
  });

  it("strips trailing punctuation from a mention", () => {
    expect(extractMentionedPaths("see @src/main.ts.")).toEqual(["src/main.ts"]);
    expect(extractMentionedPaths("see @src/main.ts, ok")).toEqual(["src/main.ts"]);
  });

  it("deduplicates repeated mentions, keeping first-occurrence order", () => {
    expect(extractMentionedPaths("@a.ts and @b.ts and @a.ts again")).toEqual(["a.ts", "b.ts"]);
  });
});

describe("expandFileMentions", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nib-expand-"));
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it("reads resolvable files into <file> blocks and skips the rest", async () => {
    fs.writeFileSync(path.join(root, "a.ts"), "export const a = 1;");
    fs.writeFileSync(path.join(root, "b.ts"), Buffer.from([0, 1, 2])); // binary

    const { blocks, imageUrls } = await expandFileMentions("@a.ts and @missing.ts and @b.ts", root);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toBe('<file path="a.ts">\nexport const a = 1;\n</file>');
    expect(imageUrls).toEqual([]);
  });

  it("truncates oversized files with a marker", async () => {
    fs.writeFileSync(path.join(root, "big.txt"), "x".repeat(70_000));
    const { blocks: [block] } = await expandFileMentions("@big.txt", root);
    expect(block.length).toBeLessThan(70_000);
    expect(block.includes("… [truncated]")).toBe(true);
  });
});

describe("expandFileMentions permission gate", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nib-gate-"));
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  // The gate cli.tsx's runAgentTurnBridge wires up: each mention is routed
  // through authorize() (profile layer 1, then the rule engine), so a profile
  // fs denial blocks injection exactly like a read-rule deny.
  const gateFor = (engine: PermissionEngine, profile?: ProfileEvaluator) =>
    (raw: string) =>
      authorize({ tool: "read_file", arguments: { path: raw } }, engine, profile).action === "deny" ? "deny" : "allow";

  it("replaces a profile-denied path with a not-injected note and injects allowed ones", async () => {
    fs.writeFileSync(path.join(root, "ok.ts"), "export const ok = 1;");
    fs.writeFileSync(path.join(root, "secret.env"), "TOKEN=abc");
    const engine = new PermissionEngine(undefined, root);
    const profile = new ProfileEvaluator(
      { level: "strict-sandbox", fs: [{ path: "secret.env", action: "deny" }] },
      root,
    );

    const { blocks } = await expandFileMentions("@ok.ts and @secret.env", root, gateFor(engine, profile));
    expect(blocks).toEqual([
      '<file path="ok.ts">\nexport const ok = 1;\n</file>',
      '<file path="secret.env">\n[not injected: denied by permissions]\n</file>',
    ]);
  });

  it("without a profile, the gate falls through to the rule engine and allows pass", async () => {
    fs.writeFileSync(path.join(root, "plain.ts"), "export const p = 1;");
    const { blocks } = await expandFileMentions("@plain.ts", root, gateFor(new PermissionEngine(undefined, root)));
    expect(blocks).toEqual(['<file path="plain.ts">\nexport const p = 1;\n</file>']);
  });

  it("without a gate, behavior is unchanged", async () => {
    fs.writeFileSync(path.join(root, "ungated.ts"), "export const u = 1;");
    const { blocks } = await expandFileMentions("@ungated.ts", root);
    expect(blocks).toEqual(['<file path="ungated.ts">\nexport const u = 1;\n</file>']);
  });
});

describe("expandFileMentions image mentions", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nib-images-"));
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  // Real image bytes, not a stand-in: the leading 0x00 is what makes this
  // case interesting — it is exactly the byte that used to trip the binary
  // guard and drop a path-referenced image on the floor.
  const IMAGE_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);

  it("attaches an image mention as a data URL instead of dropping it as binary", async () => {
    fs.writeFileSync(path.join(root, "shot.png"), IMAGE_BYTES);

    const { blocks, imageUrls } = await expandFileMentions("look at @shot.png", root);

    expect(blocks).toEqual([]);
    expect(imageUrls).toEqual([`data:image/png;base64,${IMAGE_BYTES.toString("base64")}`]);
  });

  it("keeps text and image mentions on their own channels", async () => {
    fs.writeFileSync(path.join(root, "notes.md"), "# notes");
    fs.writeFileSync(path.join(root, "diagram.png"), IMAGE_BYTES);

    const { blocks, imageUrls } = await expandFileMentions("@notes.md and @diagram.png", root);

    expect(blocks).toEqual(['<file path="notes.md">\n# notes\n</file>']);
    expect(imageUrls).toEqual([`data:image/png;base64,${IMAGE_BYTES.toString("base64")}`]);
  });

  it("resolves the media type from the path extension", async () => {
    // Same shape as clipboard.ts: the extension picks the media type.
    fs.writeFileSync(path.join(root, "photo.jpeg"), IMAGE_BYTES);

    const { imageUrls } = await expandFileMentions("@photo.jpeg", root);

    expect(imageUrls).toEqual([`data:image/jpeg;base64,${IMAGE_BYTES.toString("base64")}`]);
  });

  it("notes an over-limit image instead of attaching it", async () => {
    fs.writeFileSync(path.join(root, "huge.png"), Buffer.alloc(5 * 1024 * 1024 + 1));

    const { blocks, imageUrls } = await expandFileMentions("@huge.png", root);

    expect(imageUrls).toEqual([]);
    expect(blocks.join("")).toContain("image not attached");
    expect(blocks.join("")).toContain("exceeds the 5 MB limit");
  });

  it("does not attach an image the permission gate denies", async () => {
    fs.writeFileSync(path.join(root, "secret.png"), IMAGE_BYTES);

    const { blocks, imageUrls } = await expandFileMentions("@secret.png", root, () => "deny");

    expect(imageUrls).toEqual([]);
    expect(blocks).toEqual(['<file path="secret.png">\n[not injected: denied by permissions]\n</file>']);
  });
});
