import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync, statSync, utimesSync } from "node:fs";
import { join } from "node:path";
import type { ToolContext } from "./types.js";
import {
  editHandler,
  applyDiffHandler,
  applyPatchHandler,
  searchReplaceHandler,
  editFileHandler,
  writeToFileHandler,
} from "./edit.js";

const TEST_DIR = join(process.cwd(), ".test-tmp");

const mockCtx: ToolContext = {
  workingDir: TEST_DIR,
  sessionId: "test-session",
  askUser: async () => true,
  signal: new AbortController().signal,
};

function testPath(name: string): string {
  return join(TEST_DIR, name);
}

describe("edit", () => {
  beforeEach(() => {
    if (!existsSync(TEST_DIR)) mkdirSync(TEST_DIR, { recursive: true });
  });
  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("replaces exact match", async () => {
    const path = testPath("test.txt");
    writeFileSync(path, "Hello World", "utf-8");
    const result = await editHandler(
      { path, oldString: "Hello", newString: "Goodbye" },
      mockCtx,
    );
    expect(result.error).toBeUndefined();
    expect(result.content).toContain("1 occurrence");
    expect(readFileSync(path, "utf-8")).toBe("Goodbye World");
  });

  it("returns error when string not found", async () => {
    const path = testPath("test.txt");
    writeFileSync(path, "Hello World", "utf-8");
    const result = await editHandler(
      { path, oldString: "xyz", newString: "abc" },
      mockCtx,
    );
    expect(result.error).toContain("String not found");
  });

  it("returns error when multiple occurrences", async () => {
    const path = testPath("test.txt");
    writeFileSync(path, "foo foo foo", "utf-8");
    const result = await editHandler(
      { path, oldString: "foo", newString: "bar" },
      mockCtx,
    );
    expect(result.error).toContain("Found 3 occurrences");
  });

  it("returns error when oldString is empty", async () => {
    const result = await editHandler(
      { path: testPath("test.txt"), oldString: "", newString: "bar" },
      mockCtx,
    );
    expect(result.error).toContain("must not be empty");
  });

  it("does not falsely report FILE_MODIFIED on a second consecutive edit (regression)", async () => {
    const path = testPath("test.txt");
    writeFileSync(path, "Hello World", "utf-8");

    // Simulate a read that happened, followed by a real pause (>1000ms) before
    // the user issues the first edit -- backdate the file's own mtime so that,
    // at the moment edit #1 runs, disk mtime == recorded mtime (nothing has
    // written to the file since the read; only wall-clock time has passed).
    const oldMtime = statSync(path).mtimeMs - 5000;
    utimesSync(path, new Date(oldMtime), new Date(oldMtime));
    const fileMtimes = new Map<string, number>();
    fileMtimes.set(path, oldMtime);
    const ctx: ToolContext = { ...mockCtx, fileMtimes };

    const first = await editHandler(
      { path, oldString: "Hello", newString: "Goodbye" },
      ctx,
    );
    expect(first.error).toBeUndefined();
    expect(first.content).toContain("1 occurrence");

    // The first edit's write just bumped the on-disk mtime to "now" (roughly
    // oldMtime + 5000ms, i.e. >1000ms ahead of the read-time recorded above).
    //
    // With the OLD (buggy) code, writeAndTrack did not exist: ctx.fileMtimes
    // still holds `oldMtime` from the read, never refreshed by the write.
    // The second edit's checkStaleFile would then compare the post-write disk
    // mtime (~oldMtime + 5000ms) against that stale `oldMtime`, see a >1000ms
    // gap, and incorrectly return FILE_MODIFIED -- even though the only writer
    // was this same tool. That is the exact regression being guarded against.
    //
    // With the FIX, writeAndTrack re-stats after the first write and sets
    // ctx.fileMtimes to the fresh post-write mtime, so the second edit's
    // checkStaleFile compares disk mtime against that fresh value (delta ~0),
    // and does NOT flag FILE_MODIFIED.
    const second = await editHandler(
      { path, oldString: "Goodbye", newString: "Farewell" },
      ctx,
    );
    expect(second.error).toBeUndefined();
    expect(second.content).toContain("1 occurrence");
    expect(readFileSync(path, "utf-8")).toBe("Farewell World");
  });

  it("still reports FILE_MODIFIED on a genuine external change between edits", async () => {
    const path = testPath("test.txt");
    writeFileSync(path, "Hello World", "utf-8");

    const fileMtimes = new Map<string, number>();
    const s1 = statSync(path);
    fileMtimes.set(path, s1.mtimeMs);
    const ctx: ToolContext = { ...mockCtx, fileMtimes };

    // Simulate a genuine external writer (a different tool/process) bumping the
    // file's mtime forward without going through writeAndTrack, so ctx.fileMtimes
    // is never updated for this write.
    writeFileSync(path, "Hello World (externally edited)", "utf-8");
    const bumped = statSync(path).mtimeMs + 5000;
    utimesSync(path, new Date(bumped), new Date(bumped));

    const result = await editHandler(
      { path, oldString: "Hello", newString: "Goodbye" },
      ctx,
    );
    expect(result.error).toBe("FILE_MODIFIED");
    expect(result.content).toContain("FILE_MODIFIED");
  });
});

describe("apply_diff", () => {
  beforeEach(() => {
    if (!existsSync(TEST_DIR)) mkdirSync(TEST_DIR, { recursive: true });
  });
  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("applies a matching diff", async () => {
    const path = testPath("test.txt");
    writeFileSync(path, "line1\nline2\nline3\n", "utf-8");
    const diff = "@@ -1,3 +1,3 @@\n line1\n-line2\n+replaced\n line3\n";
    const result = await applyDiffHandler({ path, diff }, mockCtx);
    expect(result.error).toBeUndefined();
    expect(result.content).toContain("applied");
    expect(readFileSync(path, "utf-8")).toBe("line1\nreplaced\nline3\n");
  });

  it("returns error on non-matching diff", async () => {
    const path = testPath("test.txt");
    writeFileSync(path, "line1\nline2\nline3\n", "utf-8");
    const diff = "@@ -1,3 +1,3 @@\n line1\n-nonexistent\n+replaced\n line3\n";
    const result = await applyDiffHandler({ path, diff }, mockCtx);
    expect(result.error).toContain("Diff does not match");
  });

  it("returns success for empty diff", async () => {
    const path = testPath("test.txt");
    writeFileSync(path, "content", "utf-8");
    const result = await applyDiffHandler({ path, diff: "" }, mockCtx);
    expect(result.error).toBeUndefined();
    expect(result.content).toContain("Empty diff");
  });

  it("does not falsely report FILE_MODIFIED when edit and apply_diff alternate on the same tracked file", async () => {
    const path = testPath("test.txt");
    writeFileSync(path, "line1\nline2\nline3\n", "utf-8");

    // Backdate the file's mtime to simulate a read that happened >1000ms ago,
    // with no writes since (disk mtime == recorded read-time), so the first
    // operation's checkStaleFile correctly passes.
    const oldMtime = statSync(path).mtimeMs - 5000;
    utimesSync(path, new Date(oldMtime), new Date(oldMtime));
    const fileMtimes = new Map<string, number>();
    fileMtimes.set(path, oldMtime);
    const ctx: ToolContext = { ...mockCtx, fileMtimes };

    const editResult = await editHandler(
      { path, oldString: "line1", newString: "LINE1" },
      ctx,
    );
    expect(editResult.error).toBeUndefined();

    // apply_diff shares ctx.fileMtimes with the prior edit call. editHandler's
    // writeAndTrack just bumped the recorded mtime to the post-write value (far
    // ahead of oldMtime); if apply_diff's checkStaleFile read a stale recorded
    // value instead, it would false-positive FILE_MODIFIED here.
    const diff = "@@ -1,3 +1,3 @@\n LINE1\n-line2\n+replaced\n line3\n";
    const diffResult = await applyDiffHandler({ path, diff }, ctx);
    expect(diffResult.error).toBeUndefined();
    expect(readFileSync(path, "utf-8")).toBe("LINE1\nreplaced\nline3\n");
  });
});

describe("apply_patch", () => {
  beforeEach(() => {
    if (!existsSync(TEST_DIR)) mkdirSync(TEST_DIR, { recursive: true });
  });
  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("applies a multi-file patch", async () => {
    const path1 = testPath("a.txt");
    const path2 = testPath("b.txt");
    writeFileSync(path1, "hello\n", "utf-8");
    writeFileSync(path2, "world\n", "utf-8");
    const patch = `diff --git a/a.txt b/a.txt
--- a/a.txt
+++ b/${path1}
@@ -1 +1 @@
-hello
+hi
diff --git a/b.txt b/b.txt
--- a/b.txt
+++ b/${path2}
@@ -1 +1 @@
-world
+earth`;
    const result = await applyPatchHandler({ patch }, mockCtx);
    expect(result.error).toBeUndefined();
    expect(result.content).toContain("ok");
    expect(readFileSync(path1, "utf-8")).toBe("hi\n");
    expect(readFileSync(path2, "utf-8")).toBe("earth\n");
  });

  it("returns early for empty patch", async () => {
    const result = await applyPatchHandler({ patch: "" }, mockCtx);
    expect(result.content).toContain("Empty patch");
  });

  it("rejects a patch target that escapes the working directory", async () => {
    const outside = join(process.cwd(), ".patch-outside-test.txt");
    writeFileSync(outside, "secret\n", "utf-8");
    try {
      const result = await applyPatchHandler({ patch: `--- a/../.patch-outside-test.txt
+++ b/../.patch-outside-test.txt
@@ -1 +1 @@
-secret
+changed` }, mockCtx);

      expect(result.error).toContain("escapes the working directory");
      expect(readFileSync(outside, "utf-8")).toBe("secret\n");
    } finally {
      rmSync(outside, { force: true });
    }
  });

  it("tracks the mtime of every file written in a multi-file patch, avoiding false FILE_MODIFIED on subsequent edits to either file", async () => {
    const path1 = testPath("a.txt");
    const path2 = testPath("b.txt");
    writeFileSync(path1, "hello\n", "utf-8");
    writeFileSync(path2, "world\n", "utf-8");

    // Backdate both files' mtimes to simulate reads that happened >1000ms ago,
    // with no writes since, so the patch's own checkStaleFile calls pass.
    const oldMtime1 = statSync(path1).mtimeMs - 5000;
    const oldMtime2 = statSync(path2).mtimeMs - 5000;
    utimesSync(path1, new Date(oldMtime1), new Date(oldMtime1));
    utimesSync(path2, new Date(oldMtime2), new Date(oldMtime2));
    const fileMtimes = new Map<string, number>();
    fileMtimes.set(path1, oldMtime1);
    fileMtimes.set(path2, oldMtime2);
    const ctx: ToolContext = { ...mockCtx, fileMtimes };

    const patch = `diff --git a/a.txt b/a.txt
--- a/a.txt
+++ b/${path1}
@@ -1 +1 @@
-hello
+hi
diff --git a/b.txt b/b.txt
--- a/b.txt
+++ b/${path2}
@@ -1 +1 @@
-world
+earth`;
    const patchResult = await applyPatchHandler({ patch }, ctx);
    expect(patchResult.content).toContain(`${path1}: ok`);
    expect(patchResult.content).toContain(`${path2}: ok`);

    // Both paths' recorded mtimes should now be fresh (within 1000ms of the
    // post-write on-disk mtime), so a follow-up edit to either file must not
    // false-positive FILE_MODIFIED.
    const edit1 = await editHandler({ path: path1, oldString: "hi", newString: "hey" }, ctx);
    expect(edit1.error).toBeUndefined();
    const edit2 = await editHandler({ path: path2, oldString: "earth", newString: "planet" }, ctx);
    expect(edit2.error).toBeUndefined();
    expect(readFileSync(path1, "utf-8")).toBe("hey\n");
    expect(readFileSync(path2, "utf-8")).toBe("planet\n");
  });

  it("does not throw when ctx.fileMtimes is undefined", async () => {
    const path1 = testPath("a.txt");
    const path2 = testPath("b.txt");
    writeFileSync(path1, "hello\n", "utf-8");
    writeFileSync(path2, "world\n", "utf-8");

    const ctxNoMtimes: ToolContext = { ...mockCtx, fileMtimes: undefined };
    const patch = `diff --git a/a.txt b/a.txt
--- a/a.txt
+++ b/${path1}
@@ -1 +1 @@
-hello
+hi
diff --git a/b.txt b/b.txt
--- a/b.txt
+++ b/${path2}
@@ -1 +1 @@
-world
+earth`;
    const result = await applyPatchHandler({ patch }, ctxNoMtimes);
    expect(result.content).toContain(`${path1}: ok`);
    expect(result.content).toContain(`${path2}: ok`);
    expect(readFileSync(path1, "utf-8")).toBe("hi\n");
    expect(readFileSync(path2, "utf-8")).toBe("earth\n");
  });
});

describe("search_replace", () => {
  beforeEach(() => {
    if (!existsSync(TEST_DIR)) mkdirSync(TEST_DIR, { recursive: true });
  });
  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("replaces single occurrence", async () => {
    const path = testPath("test.txt");
    writeFileSync(path, "hello world", "utf-8");
    const result = await searchReplaceHandler(
      { path, search: "hello", replace: "hi" },
      mockCtx,
    );
    expect(result.error).toBeUndefined();
    expect(result.content).toContain("1 occurrences");
    expect(readFileSync(path, "utf-8")).toBe("hi world");
  });

  it("replaces all occurrences", async () => {
    const path = testPath("test.txt");
    writeFileSync(path, "foo bar foo", "utf-8");
    const result = await searchReplaceHandler(
      { path, search: "foo", replace: "baz" },
      mockCtx,
    );
    expect(result.error).toBeUndefined();
    expect(result.content).toContain("2 occurrences");
    expect(readFileSync(path, "utf-8")).toBe("baz bar baz");
  });

  it("returns error when string not found", async () => {
    const path = testPath("test.txt");
    writeFileSync(path, "hello world", "utf-8");
    const result = await searchReplaceHandler(
      { path, search: "xyz", replace: "abc" },
      mockCtx,
    );
    expect(result.error).toContain("String not found");
  });
});

describe("edit_file", () => {
  beforeEach(() => {
    if (!existsSync(TEST_DIR)) mkdirSync(TEST_DIR, { recursive: true });
  });
  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("replaces when count matches", async () => {
    const path = testPath("test.txt");
    writeFileSync(path, "foo foo foo", "utf-8");
    const result = await editFileHandler(
      { path, search: "foo", replace: "bar", expectedCount: 3 },
      mockCtx,
    );
    expect(result.error).toBeUndefined();
    expect(result.content).toContain("3 occurrences");
    expect(readFileSync(path, "utf-8")).toBe("bar bar bar");
  });

  it("aborts when count differs", async () => {
    const path = testPath("test.txt");
    writeFileSync(path, "foo foo foo", "utf-8");
    const result = await editFileHandler(
      { path, search: "foo", replace: "bar", expectedCount: 2 },
      mockCtx,
    );
    expect(result.error).toContain("Expected 2 occurrences, found 3");
    expect(readFileSync(path, "utf-8")).toBe("foo foo foo");
  });

  it("aborts when zero occurrences expected and found", async () => {
    const path = testPath("test.txt");
    writeFileSync(path, "foo foo foo", "utf-8");
    const result = await editFileHandler(
      { path, search: "foo", replace: "bar", expectedCount: 0 },
      mockCtx,
    );
    expect(result.error).toBeDefined();
    expect(readFileSync(path, "utf-8")).toBe("foo foo foo");
  });
});

describe("write_to_file", () => {
  beforeEach(() => {
    if (!existsSync(TEST_DIR)) mkdirSync(TEST_DIR, { recursive: true });
  });
  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("writes a new file", async () => {
    const path = testPath("new.txt");
    const result = await writeToFileHandler(
      { path, content: "hello world" },
      mockCtx,
    );
    expect(result.error).toBeUndefined();
    expect(result.content).toContain("Wrote");
    expect(readFileSync(path, "utf-8")).toBe("hello world");
  });

  it("overwrites an existing file", async () => {
    const path = testPath("existing.txt");
    writeFileSync(path, "old content", "utf-8");
    const result = await writeToFileHandler(
      { path, content: "new content" },
      mockCtx,
    );
    expect(result.error).toBeUndefined();
    expect(readFileSync(path, "utf-8")).toBe("new content");
  });

  it("creates parent directories", async () => {
    const path = testPath("sub/deep/new.txt");
    const result = await writeToFileHandler(
      { path, content: "nested" },
      mockCtx,
    );
    expect(result.error).toBeUndefined();
    expect(readFileSync(path, "utf-8")).toBe("nested");
  });
});
