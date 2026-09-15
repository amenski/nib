import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Message } from "../types.js";

const TEST_HOME = join(process.cwd(), ".test-sessions");
const TEST_CWD = "test/project";
const SESSION_SLUG = "test-project";

vi.mock("node:os", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:os")>();
  return { ...original, homedir: () => TEST_HOME };
});

describe("SessionStore", () => {
  let store: import("./store.js").SessionStore;

  beforeEach(async () => {
    vi.spyOn(process, "cwd").mockReturnValue(TEST_CWD);
    if (!existsSync(TEST_HOME)) mkdirSync(TEST_HOME, { recursive: true });
    const mod = await import("./store.js");
    store = new mod.SessionStore();
  });

  afterEach(() => {
    rmSync(TEST_HOME, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function sessionDir(): string {
    return join(TEST_HOME, ".nib", "sessions", SESSION_SLUG);
  }

  it("routes sessions under an explicit home argument", async () => {
    const custom = join(TEST_HOME, "custom-home");
    const mod = await import("./store.js");
    const s = new mod.SessionStore(custom);
    const id = await s.create({ cwd: TEST_CWD, provider: "openai", model: "gpt-4", mode: "ask" });
    expect(existsSync(join(custom, "sessions", SESSION_SLUG, `${id}.jsonl`))).toBe(true);
  });

  describe("create and load", () => {
    it("creates a session and loads it back", async () => {
      const id = await store.create({
        cwd: TEST_CWD,
        provider: "openai",
        model: "gpt-4",
        mode: "ask",
      });

      expect(id).toBeTruthy();
      expect(existsSync(join(sessionDir(), `${id}.jsonl`))).toBe(true);

      const loaded = await store.load(id);
      expect(loaded).not.toBeNull();
      expect(loaded!.meta.provider).toBe("openai");
      expect(loaded!.meta.model).toBe("gpt-4");
      expect(loaded!.messages).toHaveLength(0);
    });

    it("returns null for nonexistent session", async () => {
      const loaded = await store.load("nonexistent");
      expect(loaded).toBeNull();
    });
  });

  describe("append messages", () => {
    it("appends and loads messages", async () => {
      const id = await store.create({
        cwd: TEST_CWD,
        provider: "openai",
        model: "gpt-4",
        mode: "ask",
      });

      const msg1: Message = { role: "user", content: "hello" };
      const msg2: Message = { role: "assistant", content: "hi there" };

      await store.appendMessage(id, msg1);
      await store.appendMessage(id, msg2);

      const loaded = await store.load(id);
      expect(loaded).not.toBeNull();
      expect(loaded!.messages).toHaveLength(2);
      expect(loaded!.messages[0].content).toBe("hello");
      expect(loaded!.messages[1].content).toBe("hi there");
    });
  });

  describe("state folding", () => {
    it("applies state records to meta", async () => {
      const id = await store.create({
        cwd: TEST_CWD,
        provider: "openai",
        model: "gpt-4",
        mode: "ask",
      });

      await store.appendState(id, { mode: "all", model: "gpt-4o" });

      const loaded = await store.load(id);
      expect(loaded!.meta.mode).toBe("all");
      expect(loaded!.meta.model).toBe("gpt-4o");
      expect(loaded!.meta.provider).toBe("openai");
    });

    it("preserves tri-state model origin markers for resume policy", async () => {
      const modeDerived = await store.create({
        cwd: TEST_CWD,
        provider: "deepseek",
        model: "deepseek-v4-flash",
        mode: "general",
        modelExplicit: false,
      });
      const explicit = await store.create({
        cwd: TEST_CWD,
        provider: "openai",
        model: "gpt-5.6-sol",
        mode: "general",
        modelExplicit: true,
      });
      const legacy = await store.create({
        cwd: TEST_CWD,
        provider: "openai",
        model: "gpt-5.6-sol",
        mode: "general",
      });

      expect((await store.load(modeDerived))!.meta.modelExplicit).toBe(false);
      expect((await store.load(explicit))!.meta.modelExplicit).toBe(true);
      expect((await store.load(legacy))!.meta.modelExplicit).toBeUndefined();
    });
  });

  describe("compaction", () => {
    it("loadEffective prepends summary and skips replaced messages", async () => {
      const id = await store.create({
        cwd: TEST_CWD,
        provider: "openai",
        model: "gpt-4",
        mode: "ask",
      });

      await store.appendMessage(id, { role: "user", content: "msg0" });
      await store.appendMessage(id, { role: "assistant", content: "msg1" });
      await store.appendMessage(id, { role: "user", content: "msg2" });
      await store.appendMessage(id, { role: "assistant", content: "msg3" });

      await store.appendCompaction(id, 1, {
        task: "fix bug",
        decisions: ["use regex"],
        files: ["src/index.ts"],
        errors_resolved: ["type error"],
      });

      await store.appendMessage(id, { role: "user", content: "continue" });

      const effective = await store.loadEffective(id);
      expect(effective.messages).toHaveLength(4);

      expect(effective.messages[0].role).toBe("user");
      expect(effective.messages[0].content).toContain("fix bug");
      expect(effective.messages[0].content).toContain("use regex");
      expect(effective.messages[0].content).toContain("src/index.ts");

      expect(effective.messages[1].content).toBe("msg2");
      expect(effective.messages[2].content).toBe("msg3");
      expect(effective.messages[3].content).toBe("continue");
    });

    it("strips DSML tool-call markup from summaries on write", async () => {
      const id = await store.create({ cwd: TEST_CWD, provider: "openai", model: "gpt-4", mode: "ask" });
      await store.appendMessage(id, { role: "user", content: "msg0" });
      await store.appendMessage(id, { role: "assistant", content: "msg1" });

      // Escaped (deepseek-family U+FF5C) and plain DSML tool-call blocks.
      const esc = "\uFF5C";
      const escaped = [
        `<${esc}${esc}DSML${esc}${esc}tool_calls>`,
        `<${esc}${esc}DSML${esc}${esc}invoke name="read_file">`,
        `<${esc}${esc}DSML${esc}${esc}parameter name="file_path" string="true">/tmp/a.md</${esc}${esc}DSML${esc}${esc}parameter>`,
        `</${esc}${esc}DSML${esc}${esc}invoke>`,
        `</${esc}${esc}DSML${esc}${esc}tool_calls>`,
      ].join("\n");
      const plain =
        '<tool_calls>\n<invoke name="check_job">\n<parameter name="job_id" string="true">abc</parameter>\n</invoke>\n</tool_calls>';

      await store.appendCompaction(id, 1, {
        task: `## Task\nFinish the menu work.\n\n${escaped}`,
        decisions: [`picked regex ${plain}`],
        files: [],
        errors_resolved: [],
      });

      // The JSONL must hold cleaned text, never the markup.
      const { readFile } = await import("node:fs/promises");
      const raw = await readFile(join(sessionDir(), `${id}.jsonl`), "utf-8");
      expect(raw).not.toContain("DSML");
      expect(raw).not.toContain("tool_calls");
      expect(raw).not.toContain("invoke name");

      const effective = await store.loadEffective(id);
      const content = effective.messages[0].content as string;
      expect(content).toContain("Finish the menu work.");
      expect(content).toContain("picked regex");
      expect(content).not.toContain("<");
      expect(content).not.toContain("DSML");
    });

    it("renders already-corrupted on-disk summaries without DSML markup", async () => {
      const id = await store.create({ cwd: TEST_CWD, provider: "openai", model: "gpt-4", mode: "ask" });
      await store.appendMessage(id, { role: "user", content: "msg0" });
      await store.appendMessage(id, { role: "assistant", content: "msg1" });
      await store.appendMessage(id, { role: "user", content: "msg2" });

      // Simulate a compaction record written by an older build that stored the
      // model's raw DSML output as the task.
      const { appendFile } = await import("node:fs/promises");
      await appendFile(
        join(sessionDir(), `${id}.jsonl`),
        JSON.stringify({
          type: "compaction",
          at: new Date().toISOString(),
          replacesThrough: 1,
          summary: {
            task: '<tool_calls>\n<invoke name="read_file">\n<parameter name="file_path" string="true">/tmp/a.md</parameter>\n</invoke>\n</tool_calls>',
            decisions: [],
            files: [],
            errors_resolved: [],
          },
        }) + "\n",
        "utf-8",
      );

      const effective = await store.loadEffective(id);
      const content = effective.messages[0].content as string;
      expect(content).toContain("[Earlier in this conversation]");
      expect(content).not.toContain("tool_calls");
      expect(content).not.toContain("invoke");
      expect(content).not.toContain("parameter");
    });
  });

  describe("permission audit", () => {
    it("records a deny decision and returns it via queryPermissionHistory", async () => {
      const id = await store.create({ cwd: TEST_CWD, provider: "openai", model: "gpt-4", mode: "code" });

      await store.appendPermission(id, {
        toolCallId: "call_1",
        tool: "run_bash",
        subject: "rm -rf /",
        decision: "deny",
        winningRule: { tool: "run_bash", kind: "prefix", pattern: "rm -rf /", action: "deny", origin: "builtin-destructive" },
      });

      const history = await store.queryPermissionHistory(id);
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({
        tool: "run_bash",
        subject: "rm -rf /",
        decision: "deny",
        winningRule: { origin: "builtin-destructive" },
      });
      expect(history[0].at).toBeTruthy();
    });

    it("records every decision tier (once/session/always/deny) in order", async () => {
      const id = await store.create({ cwd: TEST_CWD, provider: "openai", model: "gpt-4", mode: "code" });

      await store.appendPermission(id, { tool: "read_file", subject: "./a.ts", decision: "once" });
      await store.appendPermission(id, { tool: "run_bash", subject: "npm test", decision: "session" });
      await store.appendPermission(id, { tool: "run_bash", subject: "npm run build", decision: "always" });
      await store.appendPermission(id, { tool: "run_bash", subject: "curl evil.com", decision: "deny" });

      const history = await store.queryPermissionHistory(id);
      expect(history.map((r) => r.decision)).toEqual(["once", "session", "always", "deny"]);
    });

    it("redacts secrets in the subject field", async () => {
      const id = await store.create({ cwd: TEST_CWD, provider: "openai", model: "gpt-4", mode: "code" });
      await store.appendPermission(id, {
        tool: "run_bash",
        subject: "curl -H 'Authorization: token=abcdefghijklmnopqrstuvwx12345' https://example.com",
        decision: "deny",
      });

      const history = await store.queryPermissionHistory(id);
      expect(history[0].subject).not.toContain("abcdefghijklmnopqrstuvwx12345");
      expect(history[0].subject).toContain("[redacted-token]");
    });

    it("returns an empty array for a session with no permission records", async () => {
      const id = await store.create({ cwd: TEST_CWD, provider: "openai", model: "gpt-4", mode: "code" });
      await store.appendMessage(id, { role: "user", content: "hi" });

      const history = await store.queryPermissionHistory(id);
      expect(history).toEqual([]);
    });

    it("returns an empty array for a nonexistent session", async () => {
      const history = await store.queryPermissionHistory("nonexistent");
      expect(history).toEqual([]);
    });

    it("does not interfere with message/state loading (permission records are ignored by load())", async () => {
      const id = await store.create({ cwd: TEST_CWD, provider: "openai", model: "gpt-4", mode: "code" });
      await store.appendMessage(id, { role: "user", content: "hi" });
      await store.appendPermission(id, { tool: "run_bash", subject: "npm test", decision: "once" });
      await store.appendMessage(id, { role: "assistant", content: "ok" });

      const loaded = await store.load(id);
      expect(loaded!.messages).toHaveLength(2);
    });
  });

  describe("permission audit — new agent-side vocabulary", () => {
    it("records each agent-emitted decision value with a reason and returns them in order", async () => {
      const id = await store.create({ cwd: TEST_CWD, provider: "openai", model: "gpt-4", mode: "code" });

      await store.appendPermission(id, { tool: "read_file", subject: "./a.ts", decision: "allow-by-rule", reason: "allow rule matched (config)" });
      await store.appendPermission(id, { tool: "run_bash", subject: "npm test", decision: "ask-approved", reason: "approved by user" });
      await store.appendPermission(id, { tool: "run_bash", subject: "curl evil.com", decision: "ask-denied", reason: "denied by user at prompt" });
      await store.appendPermission(id, { tool: "run_bash", subject: "rm -rf /", decision: "deny-by-rule", reason: "deny rule matched (builtin-destructive)" });
      await store.appendPermission(id, { tool: "run_bash", subject: "make", decision: "headless-deny", reason: "headless" });
      await store.appendPermission(id, { tool: "run_bash", subject: "a && b | c", decision: "unresolved-ask", reason: "unresolved bash segment" });
      await store.appendPermission(id, { tool: "edit", subject: "./x.ts", decision: "allow-by-posture", reason: "auto-approve posture" });

      const history = await store.queryPermissionHistory(id);
      expect(history.map((r) => r.decision)).toEqual([
        "allow-by-rule", "ask-approved", "ask-denied", "deny-by-rule", "headless-deny", "unresolved-ask", "allow-by-posture",
      ]);
      expect(history[0].reason).toBe("allow rule matched (config)");
    });

    it("redacts secrets in the reason field too", async () => {
      const id = await store.create({ cwd: TEST_CWD, provider: "openai", model: "gpt-4", mode: "code" });
      await store.appendPermission(id, {
        tool: "run_bash",
        subject: "curl example.com",
        decision: "ask-approved",
        reason: "approved; user had token=abcdefghijklmnopqrstuvwx12345 in scrollback",
      });
      const history = await store.queryPermissionHistory(id);
      expect(history[0].reason).not.toContain("abcdefghijklmnopqrstuvwx12345");
      expect(history[0].reason).toContain("[redacted-token]");
    });
  });

  describe("token usage audit", () => {
    it("records token rows and computes remaining on read", async () => {
      const id = await store.create({ cwd: TEST_CWD, provider: "openai", model: "gpt-4", mode: "code" });

      await store.appendToken(id, { turnTokens: 140, totalUsed: 500, budgetMax: 200000 });
      await store.appendToken(id, { turnTokens: 270, totalUsed: 1200, budgetMax: 200000 });

      const usage = await store.queryTokenUsage(id);
      expect(usage).toHaveLength(2);
      expect(usage[0]).toMatchObject({ turnTokens: 140, totalUsed: 500, budgetMax: 200000, remaining: 199500 });
      expect(usage[1].remaining).toBe(198800);
      expect(usage[0].at).toBeTruthy();
    });

    it("returns an empty array for a session with no token records", async () => {
      const id = await store.create({ cwd: TEST_CWD, provider: "openai", model: "gpt-4", mode: "code" });
      await store.appendMessage(id, { role: "user", content: "hi" });
      expect(await store.queryTokenUsage(id)).toEqual([]);
    });

    it("returns an empty array for a nonexistent session", async () => {
      expect(await store.queryTokenUsage("nonexistent")).toEqual([]);
    });

    it("token records are ignored by load() and don't corrupt messages", async () => {
      const id = await store.create({ cwd: TEST_CWD, provider: "openai", model: "gpt-4", mode: "code" });
      await store.appendMessage(id, { role: "user", content: "hi" });
      await store.appendToken(id, { turnTokens: 10, totalUsed: 10, budgetMax: 128000 });
      await store.appendMessage(id, { role: "assistant", content: "ok" });

      const loaded = await store.load(id);
      expect(loaded!.messages).toHaveLength(2);
    });
  });

  describe("todo snapshots", () => {
    it("round-trips appended todo lists in chronological order", async () => {
      const id = await store.create({ cwd: TEST_CWD, provider: "openai", model: "gpt-4", mode: "code" });
      await store.appendTodo(id, [
        { content: "step one", status: "pending" },
        { content: "step two", status: "in_progress" },
      ]);
      await store.appendTodo(id, [
        { content: "step one", status: "completed" },
        { content: "step two", status: "in_progress" },
      ]);

      const rows = await store.queryTodos(id);
      expect(rows).toHaveLength(2);
      expect(rows[0].todos).toEqual([
        { content: "step one", status: "pending" },
        { content: "step two", status: "in_progress" },
      ]);
      // Chronological: the last row is the latest snapshot.
      expect(rows[1].todos[0].status).toBe("completed");
    });

    it("redacts secrets in todo content", async () => {
      const id = await store.create({ cwd: TEST_CWD, provider: "openai", model: "gpt-4", mode: "code" });
      const key = "sk-" + "a".repeat(24);
      await store.appendTodo(id, [{ content: `use ${key} in config`, status: "pending" }]);
      const rows = await store.queryTodos(id);
      expect(rows[0].todos[0].content).not.toContain(key);
      expect(rows[0].todos[0].content).toContain("[redacted-api-key]");
    });

    it("todo records are ignored by load() and don't corrupt messages", async () => {
      const id = await store.create({ cwd: TEST_CWD, provider: "openai", model: "gpt-4", mode: "code" });
      await store.appendMessage(id, { role: "user", content: "hi" });
      await store.appendTodo(id, [{ content: "plan", status: "pending" }]);
      await store.appendMessage(id, { role: "assistant", content: "ok" });

      const loaded = await store.load(id);
      expect(loaded!.messages).toHaveLength(2);
    });

    it("returns an empty array for a session with no todo records", async () => {
      const id = await store.create({ cwd: TEST_CWD, provider: "openai", model: "gpt-4", mode: "code" });
      expect(await store.queryTodos(id)).toEqual([]);
    });
  });

  describe("old-session resume compatibility", () => {
    it("loads a legacy session that predates permission/token rows", async () => {
      // Simulate an on-disk session written before this feature existed: only
      // meta + message + state records, no permission/token rows at all.
      const id = await store.create({ cwd: TEST_CWD, provider: "openai", model: "gpt-4", mode: "ask" });
      await store.appendMessage(id, { role: "user", content: "old message" });
      await store.appendState(id, { model: "gpt-4o" });
      await store.appendMessage(id, { role: "assistant", content: "old reply" });

      const loaded = await store.load(id);
      expect(loaded).not.toBeNull();
      expect(loaded!.messages).toHaveLength(2);
      expect(loaded!.meta.model).toBe("gpt-4o");

      // The new read-side queries must return empty, not throw, on such sessions.
      expect(await store.queryPermissionHistory(id)).toEqual([]);
      expect(await store.queryTokenUsage(id)).toEqual([]);
    });
  });

  describe("torn last line", () => {
    it("drops torn final line and loads remaining records", async () => {
      const id = await store.create({
        cwd: TEST_CWD,
        provider: "openai",
        model: "gpt-4",
        mode: "ask",
      });

      await store.appendMessage(id, { role: "user", content: "good message" });

      const fs = await import("node:fs/promises");
      await fs.appendFile(
        join(sessionDir(), `${id}.jsonl`),
        '{"type":"message","message":{"role":"user","content":"torn"}\n',
        "utf-8",
      );

      const loaded = await store.load(id);
      expect(loaded).not.toBeNull();
      expect(loaded!.messages).toHaveLength(1);
      expect(loaded!.messages[0].content).toBe("good message");
    });
  });

  describe("unknown version", () => {
    it("rejects sessions with unknown version", async () => {
      const id = await store.create({
        cwd: TEST_CWD,
        provider: "openai",
        model: "gpt-4",
        mode: "ask",
      });

      const fp = join(sessionDir(), `${id}.jsonl`);
      const { readFile, writeFile } = await import("node:fs/promises");
      let raw = await readFile(fp, "utf-8");
      raw = raw.replace('"version":1', '"version":99');
      await writeFile(fp, raw, "utf-8");

      const loaded = await store.load(id);
      expect(loaded).toBeNull();
    });
  });

  describe("list", () => {
    it("lists created sessions", async () => {
      await store.create({
        cwd: TEST_CWD,
        provider: "openai",
        model: "gpt-4",
        mode: "ask",
      });

      const items = await store.list();
      expect(items.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("sessions-index", () => {
    const readFile = (p: string) =>
      import("node:fs/promises").then((m) => m.readFile(p, "utf-8"));
    const writeFile = (p: string, c: string) =>
      import("node:fs/promises").then((m) => m.writeFile(p, c, "utf-8"));
    const exists = existsSync;
    function indexPath(): string {
      return join(sessionDir(), "sessions-index.json");
    }

    it("creates the index on create() and updates it on append", async () => {
      const id = await store.create({ cwd: TEST_CWD, provider: "openai", model: "gpt-4", mode: "ask" });
      expect(exists(indexPath())).toBe(true);

      let idx = JSON.parse(await readFile(indexPath()));
      expect(idx.sessions).toHaveLength(1);
      expect(idx.sessions[0]).toMatchObject({ id, title: "", messageCount: 0, status: "interrupted" });

      await store.appendMessage(id, { role: "user", content: "build a parser" });
      await store.appendMessage(id, { role: "assistant", content: "sure" });

      idx = JSON.parse(await readFile(indexPath()));
      const entry = idx.sessions.find((s: any) => s.id === id);
      expect(entry.title).toBe("build a parser");
      expect(entry.messageCount).toBe(2);
      expect(entry.status).toBe("completed");
    });

    it("derives status: interrupted when the last message is a user prompt", async () => {
      const id = await store.create({ cwd: TEST_CWD, provider: "openai", model: "gpt-4", mode: "ask" });
      await store.appendMessage(id, { role: "user", content: "hello?" });

      const items = await store.list();
      expect(items.find((s) => s.id === id)!.status).toBe("interrupted");
    });

    it("truncates the title to 100 chars and redacts secrets", async () => {
      const id = await store.create({ cwd: TEST_CWD, provider: "openai", model: "gpt-4", mode: "ask" });
      const long = "x".repeat(200);
      await store.appendMessage(id, { role: "user", content: long });
      let idx = JSON.parse(await readFile(indexPath()));
      expect(idx.sessions.find((s: any) => s.id === id).title).toHaveLength(100);

      const id2 = await store.create({ cwd: TEST_CWD, provider: "openai", model: "gpt-4", mode: "ask" });
      await store.appendMessage(id2, { role: "user", content: "use token=abcdefghijklmnopqrstuvwx12345 please" });
      idx = JSON.parse(await readFile(indexPath()));
      const t = idx.sessions.find((s: any) => s.id === id2).title;
      expect(t).not.toContain("abcdefghijklmnopqrstuvwx12345");
      expect(t).toContain("[redacted-token]");
    });

    it("captures last token totals when token rows exist", async () => {
      const id = await store.create({ cwd: TEST_CWD, provider: "openai", model: "gpt-4", mode: "ask" });
      await store.appendToken(id, { turnTokens: 100, totalUsed: 500, budgetMax: 200000 });
      await store.appendToken(id, { turnTokens: 200, totalUsed: 1500, budgetMax: 200000 });

      const item = (await store.list()).find((s) => s.id === id)!;
      expect(item.totalUsed).toBe(1500);
      expect(item.budgetMax).toBe(200000);
    });

    it("rebuilds a corrupt index from the JSONL scan", async () => {
      const id = await store.create({ cwd: TEST_CWD, provider: "openai", model: "gpt-4", mode: "ask" });
      await store.appendMessage(id, { role: "user", content: "real prompt" });
      await store.appendMessage(id, { role: "assistant", content: "done" });

      await writeFile(indexPath(), "{ this is not valid json ]]]");

      const items = await store.list();
      const item = items.find((s) => s.id === id)!;
      expect(item.title).toBe("real prompt");
      expect(item.status).toBe("completed");

      // The index file is now valid again (repaired in place).
      const idx = JSON.parse(await readFile(indexPath()));
      expect(idx.sessions.find((s: any) => s.id === id)).toBeTruthy();
    });

    it("builds an index transparently for a legacy dir with no index", async () => {
      const id = await store.create({ cwd: TEST_CWD, provider: "openai", model: "gpt-4", mode: "ask" });
      await store.appendMessage(id, { role: "user", content: "legacy work" });

      // Simulate a pre-index install: delete the index the store just wrote.
      const { unlink } = await import("node:fs/promises");
      await unlink(indexPath());
      expect(exists(indexPath())).toBe(false);

      const items = await store.list();
      expect(items.find((s) => s.id === id)!.title).toBe("legacy work");
      expect(exists(indexPath())).toBe(true);
    });

    it("renameSession sets a custom title that survives further appends", async () => {
      const id = await store.create({ cwd: TEST_CWD, provider: "openai", model: "gpt-4", mode: "ask" });
      await store.appendMessage(id, { role: "user", content: "original prompt" });

      expect(await store.renameSession(id, "My renamed session")).toBe(true);
      let item = (await store.list()).find((s) => s.id === id)!;
      expect(item.title).toBe("My renamed session");

      // A later append must not clobber the user's title.
      await store.appendMessage(id, { role: "assistant", content: "ok" });
      item = (await store.list()).find((s) => s.id === id)!;
      expect(item.title).toBe("My renamed session");
      expect(item.messageCount).toBe(2);
    });

    it("renameSession returns false for a nonexistent session", async () => {
      expect(await store.renameSession("nope", "x")).toBe(false);
    });

    it("renameSession redacts + truncates the given title", async () => {
      const id = await store.create({ cwd: TEST_CWD, provider: "openai", model: "gpt-4", mode: "ask" });
      await store.renameSession(id, "leak token=abcdefghijklmnopqrstuvwx12345");
      const item = (await store.list()).find((s) => s.id === id)!;
      expect(item.title).not.toContain("abcdefghijklmnopqrstuvwx12345");
      expect(item.title).toContain("[redacted-token]");
    });

    it("list() from the index equals list() after a forced rebuild (scan path)", async () => {
      const a = await store.create({ cwd: TEST_CWD, provider: "openai", model: "gpt-4", mode: "ask" });
      await store.appendMessage(a, { role: "user", content: "first" });
      await store.appendMessage(a, { role: "assistant", content: "reply" });
      const b = await store.create({ cwd: TEST_CWD, provider: "openai", model: "gpt-4", mode: "ask" });
      await store.appendMessage(b, { role: "user", content: "second" });

      // Index path.
      const fromIndex = await store.list();

      // Force the scan/rebuild path by deleting the index, then list again.
      const { unlink } = await import("node:fs/promises");
      await unlink(indexPath());
      const fromScan = await store.list();

      expect(fromScan).toEqual(fromIndex);
    });

    it("prunes the deleted session from the index", async () => {
      const id = await store.create({ cwd: TEST_CWD, provider: "openai", model: "gpt-4", mode: "ask" });
      await store.appendMessage(id, { role: "user", content: "to delete" });

      await store.deleteSession(id);
      const idx = JSON.parse(await readFile(indexPath()));
      expect(idx.sessions.find((s: any) => s.id === id)).toBeUndefined();
      expect((await store.list()).find((s) => s.id === id)).toBeUndefined();
    });
  });

  describe("subagent audit view (decision H)", () => {
    it("forwards permission and token rows tagged source: \"subagent\"; parent rows stay untagged", async () => {
      const id = await store.create({ cwd: TEST_CWD, provider: "openai", model: "gpt-4", mode: "code" });
      const { subagentAuditStore } = await import("./store.js");
      const view = subagentAuditStore(store);

      await view.appendPermission(id, { tool: "run_bash", subject: "npm test", decision: "headless-deny" });
      await view.appendToken(id, { turnTokens: 140, totalUsed: 500, budgetMax: 128000 });

      const history = await store.queryPermissionHistory(id);
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({ tool: "run_bash", subject: "npm test", decision: "headless-deny", source: "subagent" });

      const usage = await store.queryTokenUsage(id);
      expect(usage[0]).toMatchObject({ turnTokens: 140, totalUsed: 500, budgetMax: 128000, source: "subagent" });

      // A parent-side write through the real store stays untagged (it was
      // appended after the sub-agent row above).
      await store.appendPermission(id, { tool: "read_file", subject: "./a.ts", decision: "allow-by-rule" });
      const all = await store.queryPermissionHistory(id);
      expect(all.map((r) => r.source)).toEqual(["subagent", undefined]);
    });

    it("blocks every non-audit write, so a sub-agent cannot touch the parent transcript", async () => {
      const id = await store.create({ cwd: TEST_CWD, provider: "openai", model: "gpt-4", mode: "code" });
      const { subagentAuditStore } = await import("./store.js");
      const view = subagentAuditStore(store);

      expect(view.appendMessage).toBeUndefined();
      expect(view.appendTodo).toBeUndefined();
      expect(view.appendCompaction).toBeUndefined();
      expect(view.appendState).toBeUndefined();
      expect(view.append).toBeUndefined();
      expect(view.create).toBeUndefined();
      expect(view.deleteSession).toBeUndefined();
      expect(view.load).toBeUndefined();

      await view.appendPermission(id, { tool: "run_bash", subject: "npm test", decision: "deny" });

      // The JSONL holds exactly the meta record plus the one audit row.
      const { readFile } = await import("node:fs/promises");
      const raw = await readFile(join(sessionDir(), `${id}.jsonl`), "utf-8");
      const types = raw.split("\n").filter(Boolean).map((l) => JSON.parse(l).type);
      expect(types).toEqual(["meta", "permission"]);
    });

    it("reports getMessageCount 0 so agent.ts's compaction-persist path stays dormant", async () => {
      const id = await store.create({ cwd: TEST_CWD, provider: "openai", model: "gpt-4", mode: "code" });
      await store.appendMessage(id, { role: "user", content: "hi" });
      const { subagentAuditStore } = await import("./store.js");
      const view = subagentAuditStore(store);
      expect(await view.getMessageCount(id)).toBe(0);
    });
  });
});
