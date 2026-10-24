import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgent } from "./agent.js";
import type { Provider, StreamEvent } from "./providers/types.js";
import type { Message } from "./types.js";
import type { LspManager } from "./lsp/index.js";
import type { LspDiagnostic } from "./lsp/protocol.js";
import { parseUntrustedMarker } from "./tools/untrusted-content.js";

vi.mock("./prompt.js", () => ({
  buildStablePreamble: vi.fn(() => "SYSTEM PROMPT"),
  buildVolatileContext: vi.fn(async () => ""),
}));

function makeProvider(turns: StreamEvent[][]) {
  let call = 0;
  const provider: Provider = {
    name: "fake",
    async *streamChat(messages: Message[]) {
      const events = turns[call] ?? [];
      call++;
      for (const event of events) yield event;
    },
  };
  return { provider };
}

const textTurn = (text: string): StreamEvent[] => [
  { type: "text_delta", content: text },
  { type: "done", finishReason: "stop" },
];

/** One turn that calls `tool` with `args`, then answers. */
const toolTurn = (id: string, name: string, args: unknown): StreamEvent[] => [
  { type: "tool_call_start", id, name },
  { type: "tool_call_delta", id, arguments: JSON.stringify(args) },
  { type: "done", finishReason: "tool_calls" },
];

function diagnostic(path: string, line: number, message: string, severity: 1 | 2 = 1): LspDiagnostic {
  return { path, line, character: 9, severity, message, code: "invalid_assignment" };
}

/**
 * A stub manager with the surface agent.ts uses. Real routing/lifecycle is
 * covered by lsp/manager.test.ts; this test is about what the agent loop does
 * with the numbers.
 */
function stubManager(
  byPath: Map<string, LspDiagnostic[]>,
  rootDir: string,
): { manager: LspManager; seen: string[][] } {
  const seen: string[][] = [];
  const manager = {
    workspaceRoot: rootDir,
    hasServers: true,
    serverNameFor: (path: string) => (/\.dart$/.test(path) ? "dart" : undefined),
    diagnosticsFor: async (paths: readonly string[]) => {
      seen.push([...paths]);
      const out = new Map<string, LspDiagnostic[]>();
      for (const path of paths) {
        const list = byPath.get(path);
        if (list) out.set(path, list);
      }
      return out;
    },
  } as unknown as LspManager;
  return { manager, seen };
}

describe("runAgent post-edit LSP diagnostics", () => {
  it("appends the diagnostics block to the edit's own result, not a system message", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nib-agent-lsp-"));
    try {
      const file = join(dir, "a.dart");
      writeFileSync(file, 'int x = "s";\n', "utf-8");
      const { manager } = stubManager(
        new Map([[file, [diagnostic(file, 1, "A value of type 'String' can't be assigned")]]]),
        dir,
      );
      const { provider } = makeProvider([
        toolTurn("c1", "edit", { path: file, oldString: "a", newString: "b" }),
        textTurn("fixed"),
      ]);

      const result = await runAgent("edit it", {
        provider,
        tools: [],
        executeTool: async () => ({ content: "edited a.dart" }),
        ...({ lsp: manager } as any),
      });

      const toolMessage = result.messages.find((m) => m.role === "tool") as any;
      expect(toolMessage.content).toContain("edited a.dart");
      expect(toolMessage.content).toContain("[nib] dart diagnostics for a.dart:");
      expect(toolMessage.content).toContain("a.dart:1:9  error:");
      expect(toolMessage.content).toContain("[invalid_assignment]");

      // Exactly one untrusted block, with matching markers around the body.
      const lines = toolMessage.content.split("\n");
      const markers = lines.map(parseUntrustedMarker).filter(Boolean);
      expect(markers).toHaveLength(2);
      expect(markers[0]!.id).toBe(markers[1]!.id);
      expect(markers[0]!.role).toBe("begin");
      expect(markers[1]!.role).toBe("end");

      // The label sits outside the wrapper (nib's own voice).
      const labelIndex = lines.findIndex((l: string) => l.startsWith("[nib] dart diagnostics"));
      const beginIndex = lines.findIndex((l: string) => parseUntrustedMarker(l)?.role === "begin");
      expect(labelIndex).toBeGreaterThan(-1);
      expect(beginIndex).toBe(labelIndex + 1);

      // No separate system note was added for the diagnostics.
      expect(
        result.messages.some(
          (m) => m.role === "system" && String(m.content).includes("diagnostics"),
        ),
      ).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports an error count through onDiagnostic", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nib-agent-lsp-"));
    try {
      const file = join(dir, "a.dart");
      writeFileSync(file, "int x;\n", "utf-8");
      const { manager } = stubManager(
        new Map([
          [
            file,
            [
              diagnostic(file, 1, "one"),
              diagnostic(file, 2, "two"),
              diagnostic(file, 3, "a warning", 2),
            ],
          ],
        ]),
        dir,
      );
      const { provider } = makeProvider([
        toolTurn("c1", "write_to_file", { path: file, content: "int x;\n" }),
        textTurn("ok"),
      ]);
      const notes: string[] = [];

      await runAgent("write", {
        provider,
        tools: [],
        executeTool: async () => ({ content: "wrote" }),
        onDiagnostic: (msg) => notes.push(msg),
        ...({ lsp: manager } as any),
      });

      expect(notes).toContain("lsp: 2 error(s) in a.dart");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("emits one block per file for a multi-file apply_patch", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nib-agent-lsp-"));
    try {
      const a = join(dir, "a.dart");
      const b = join(dir, "b.dart");
      writeFileSync(a, "int a;\n", "utf-8");
      writeFileSync(b, "int b;\n", "utf-8");
      const { manager, seen } = stubManager(
        new Map([
          [a, [diagnostic(a, 1, "first bad")]],
          [b, [diagnostic(b, 2, "second bad")]],
        ]),
        dir,
      );
      // Absolute targets: writtenPaths resolves relative ones against
      // process.cwd(), which is the repo here, not the temp root.
      const patch = `--- a/${a}\n+++ b/${a}\n@@\n-x\n+y\n--- a/${b}\n+++ b/${b}\n@@\n-x\n+z`;
      const { provider } = makeProvider([
        toolTurn("c1", "apply_patch", { patch }),
        textTurn("ok"),
      ]);

      const result = await runAgent("patch", {
        provider,
        tools: [],
        executeTool: async () => ({ content: "patched 2 files" }),
        ...({ lsp: manager } as any),
      });

      expect(seen[0]).toEqual([a, b]);
      const toolMessage = result.messages.find((m) => m.role === "tool") as any;
      expect(toolMessage.content).toContain("[nib] dart diagnostics for a.dart:");
      expect(toolMessage.content).toContain("[nib] dart diagnostics for b.dart:");
      expect(toolMessage.content).toContain("first bad");
      expect(toolMessage.content).toContain("second bad");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves the result untouched when the file has no diagnostics", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nib-agent-lsp-"));
    try {
      const file = join(dir, "a.dart");
      writeFileSync(file, "int x;\n", "utf-8");
      const { manager } = stubManager(new Map([[file, []]]), dir);
      const { provider } = makeProvider([
        toolTurn("c1", "edit", { path: file }),
        textTurn("ok"),
      ]);

      const result = await runAgent("edit", {
        provider,
        tools: [],
        executeTool: async () => ({ content: "edited" }),
        ...({ lsp: manager } as any),
      });

      const toolMessage = result.messages.find((m) => m.role === "tool") as any;
      expect(toolMessage.content).toBe("edited");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not ask for diagnostics when there is no manager", async () => {
    const executeTool = vi.fn(async () => ({ content: "edited" }));
    const { provider } = makeProvider([
      toolTurn("c1", "edit", { path: "/tmp/a.dart" }),
      textTurn("ok"),
    ]);

    const result = await runAgent("edit", { provider, tools: [], executeTool });

    expect(executeTool).toHaveBeenCalledTimes(1);
    const toolMessage = result.messages.find((m) => m.role === "tool") as any;
    expect(toolMessage.content).toBe("edited");
  });

  it("does not ask for diagnostics when the write failed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nib-agent-lsp-"));
    try {
      const file = join(dir, "a.dart");
      const { manager, seen } = stubManager(new Map(), dir);
      const { provider } = makeProvider([
        toolTurn("c1", "edit", { path: file }),
        textTurn("failed"),
      ]);

      const result = await runAgent("edit", {
        provider,
        tools: [],
        executeTool: async () => ({ content: "", error: "no match" }),
        ...({ lsp: manager } as any),
      });

      expect(seen).toEqual([]);
      const toolMessage = result.messages.find((m) => m.role === "tool") as any;
      expect(toolMessage.content).toContain("no match");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores a non-write tool", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nib-agent-lsp-"));
    try {
      const { manager, seen } = stubManager(new Map(), dir);
      const { provider } = makeProvider([
        toolTurn("c1", "read_file", { path: join(dir, "a.dart") }),
        textTurn("ok"),
      ]);

      await runAgent("read", {
        provider,
        tools: [],
        executeTool: async () => ({ content: "contents" }),
        ...({ lsp: manager } as any),
      });

      expect(seen).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("caps a long list and notes how many were omitted", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nib-agent-lsp-"));
    try {
      const file = join(dir, "a.dart");
      writeFileSync(file, "int x;\n", "utf-8");
      const many = Array.from({ length: 25 }, (_, i) => diagnostic(file, i + 1, `err ${i + 1}`));
      const { manager } = stubManager(new Map([[file, many]]), dir);
      const { provider } = makeProvider([
        toolTurn("c1", "edit", { path: file }),
        textTurn("ok"),
      ]);

      const result = await runAgent("edit", {
        provider,
        tools: [],
        executeTool: async () => ({ content: "edited" }),
        ...({ lsp: manager } as any),
      });

      const content = (result.messages.find((m) => m.role === "tool") as any).content;
      const bodyLines = content
        .split("\n")
        .filter((l: string) => /^\S+:\d+:\d+\s{2}(error|warning): /.test(l));
      expect(bodyLines).toHaveLength(20);
      expect(content).toContain("(+5 more)");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never turns a manager failure into a failed tool result", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nib-agent-lsp-"));
    try {
      const file = join(dir, "a.dart");
      writeFileSync(file, "int x;\n", "utf-8");
      const manager = {
        workspaceRoot: dir,
        hasServers: true,
        serverNameFor: () => "dart",
        diagnosticsFor: async () => {
          throw new Error("server will not start");
        },
      } as unknown as LspManager;
      const { provider } = makeProvider([
        toolTurn("c1", "edit", { path: file }),
        textTurn("ok"),
      ]);

      const result = await runAgent("edit", {
        provider,
        tools: [],
        executeTool: async () => ({ content: "edited" }),
        ...({ lsp: manager } as any),
      });

      const toolMessage = result.messages.find((m) => m.role === "tool") as any;
      expect(toolMessage.content).toBe("edited");
      expect(result.stopReason).toBe("done");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
