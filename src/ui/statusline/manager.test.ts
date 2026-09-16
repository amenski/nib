import { describe, it, expect, vi } from "vitest";
import { defaultCommandRunner, StatusLineManager } from "./manager.js";
import { sanitizeText, MAX_SEGMENT_LENGTH } from "./sanitize.js";
import type { StatusLineConfig, CommandRunner, ModuleImporter } from "./index.js";

function cfg(partial: Partial<StatusLineConfig>): StatusLineConfig {
  return {
    enabled: true,
    refreshMs: 2000,
    separator: " · ",
    providers: [],
    ...partial,
  };
}

describe("sanitizeText", () => {
  it("strips ANSI escape sequences", () => {
    expect(sanitizeText("\x1b[31mred\x1b[0m")).toBe("red");
  });

  it("strips C0/C1 control characters", () => {
    expect(sanitizeText("a\x00b\x07c\x7f")).toBe("abc");
  });

  it("collapses whitespace and trims", () => {
    expect(sanitizeText("  a   b \t c  ")).toBe("a b c");
  });

  it("caps length", () => {
    const long = "x".repeat(MAX_SEGMENT_LENGTH + 50);
    expect(sanitizeText(long).length).toBe(MAX_SEGMENT_LENGTH);
  });
});

describe("StatusLineManager.refresh — command providers", () => {
  it("preserves the inherited environment when containment is inactive", async () => {
    const output = await defaultCommandRunner('printf %s "${TMPDIR-}"', {
      timeoutMs: 500,
      cwd: process.cwd(),
      sessionTempDir: "/private/tmp/nib-session-statusline",
    });
    expect(output).toBe(process.env.TMPDIR ?? "");
  });

  it("uses the first stdout line as the segment text", async () => {
    const runCommand: CommandRunner = vi.fn(async () => "main\nextra line\n");
    const mgr = new StatusLineManager(
      cfg({ providers: [{ type: "command", id: "git", command: "git branch", color: "cyan" }] }),
      { runCommand },
    );
    const segs = await mgr.refresh();
    expect(segs).toEqual([{ id: "git", text: "main", color: "cyan" }]);
  });

  it("sanitizes command output", async () => {
    const runCommand: CommandRunner = vi.fn(async () => "\x1b[32mbranch\x1b[0m\n");
    const mgr = new StatusLineManager(
      cfg({ providers: [{ type: "command", id: "git", command: "x" }] }),
      { runCommand },
    );
    const segs = await mgr.refresh();
    expect(segs[0].text).toBe("branch");
  });

  it("passes timeoutMs and resolved cwd through to the runner", async () => {
    const runCommand: CommandRunner = vi.fn(async () => "ok");
    const mgr = new StatusLineManager(
      cfg({ providers: [{ type: "command", id: "c", command: "cmd", timeoutMs: 500, cwd: "." }] }),
      { runCommand },
    );
    await mgr.refresh();
    expect(runCommand).toHaveBeenCalledWith("cmd", { timeoutMs: 500, cwd: process.cwd() });
  });

  it("defaults timeoutMs to 1500", async () => {
    const runCommand: CommandRunner = vi.fn(async () => "ok");
    const mgr = new StatusLineManager(
      cfg({ providers: [{ type: "command", id: "c", command: "cmd" }] }),
      { runCommand },
    );
    await mgr.refresh();
    expect(runCommand).toHaveBeenCalledWith("cmd", { timeoutMs: 1500, cwd: process.cwd() });
  });

  it("forwards the active session containment to command providers", async () => {
    const runCommand: CommandRunner = vi.fn(async () => "ok");
    const mgr = new StatusLineManager(
      cfg({ providers: [{ type: "command", id: "c", command: "cmd", cwd: "." }] }),
      {
        runCommand,
        spawn: {
          trustedRoot: process.cwd(),
          sandboxLevel: "workspace-write",
          writeRoots: ["/private/tmp/nib-session-test"],
          sessionTempDir: "/private/tmp/nib-session-test",
        },
      },
    );
    await mgr.refresh();
    expect(runCommand).toHaveBeenCalledWith("cmd", {
      timeoutMs: 1500,
      cwd: process.cwd(),
      trustedRoot: process.cwd(),
      sandboxLevel: "workspace-write",
      writeRoots: ["/private/tmp/nib-session-test"],
      sessionTempDir: "/private/tmp/nib-session-test",
    });
  });

  it("drops the segment when the command times out / rejects", async () => {
    const runCommand: CommandRunner = vi.fn(async () => {
      throw new Error("ETIMEDOUT");
    });
    const mgr = new StatusLineManager(
      cfg({ providers: [{ type: "command", id: "c", command: "cmd" }] }),
      { runCommand },
    );
    const segs = await mgr.refresh();
    expect(segs).toEqual([]);
  });

  it("drops the segment when output sanitizes to empty", async () => {
    const runCommand: CommandRunner = vi.fn(async () => "\n\n");
    const mgr = new StatusLineManager(
      cfg({ providers: [{ type: "command", id: "c", command: "cmd" }] }),
      { runCommand },
    );
    expect(await mgr.refresh()).toEqual([]);
  });
});

describe("StatusLineManager.refresh — module providers", () => {
  it("calls the default export and stringifies its return value", async () => {
    const importModule: ModuleImporter = vi.fn(async () => () => "42");
    const mgr = new StatusLineManager(
      cfg({ providers: [{ type: "module", id: "m", path: "./x.mjs", color: "yellow" }] }),
      { importModule },
    );
    const segs = await mgr.refresh();
    expect(segs).toEqual([{ id: "m", text: "42", color: "yellow" }]);
  });

  it("awaits an async default export", async () => {
    const importModule: ModuleImporter = vi.fn(async () => async () => "async-val");
    const mgr = new StatusLineManager(
      cfg({ providers: [{ type: "module", id: "m", path: "./x.mjs" }] }),
      { importModule },
    );
    expect((await mgr.refresh())[0].text).toBe("async-val");
  });

  it("drops the segment when the module throws", async () => {
    const importModule: ModuleImporter = vi.fn(async () => () => {
      throw new Error("boom");
    });
    const mgr = new StatusLineManager(
      cfg({ providers: [{ type: "module", id: "m", path: "./x.mjs" }] }),
      { importModule },
    );
    expect(await mgr.refresh()).toEqual([]);
  });

  it("drops the segment when the default export is not callable", async () => {
    const importModule: ModuleImporter = vi.fn(async () => ({ notAFunction: true }));
    const mgr = new StatusLineManager(
      cfg({ providers: [{ type: "module", id: "m", path: "./x.mjs" }] }),
      { importModule },
    );
    expect(await mgr.refresh()).toEqual([]);
  });
});

describe("StatusLineManager — multiple providers & isolation", () => {
  it("keeps good segments when one provider fails", async () => {
    const runCommand: CommandRunner = vi.fn(async (command) => {
      if (command === "bad") throw new Error("fail");
      return "good";
    });
    const mgr = new StatusLineManager(
      cfg({
        providers: [
          { type: "command", id: "a", command: "bad" },
          { type: "command", id: "b", command: "good" },
        ],
      }),
      { runCommand },
    );
    const segs = await mgr.refresh();
    expect(segs).toEqual([{ id: "b", text: "good", color: undefined }]);
  });

  it("pushes segments to the onUpdate listener", async () => {
    const runCommand: CommandRunner = vi.fn(async () => "seg");
    const mgr = new StatusLineManager(
      cfg({ providers: [{ type: "command", id: "a", command: "x" }] }),
      { runCommand },
    );
    const listener = vi.fn();
    mgr.onUpdate(listener);
    await mgr.refresh();
    expect(listener).toHaveBeenCalledWith([{ id: "a", text: "seg", color: undefined }]);
  });

  it("exposes the last built segments via .segments", async () => {
    const runCommand: CommandRunner = vi.fn(async () => "seg");
    const mgr = new StatusLineManager(
      cfg({ providers: [{ type: "command", id: "a", command: "x" }] }),
      { runCommand },
    );
    expect(mgr.segments).toEqual([]);
    await mgr.refresh();
    expect(mgr.segments).toEqual([{ id: "a", text: "seg", color: undefined }]);
  });
});

describe("StatusLineManager — start/stop loop", () => {
  it("does not start when disabled", () => {
    const runCommand: CommandRunner = vi.fn(async () => "x");
    const mgr = new StatusLineManager(
      cfg({ enabled: false, providers: [{ type: "command", id: "a", command: "x" }] }),
      { runCommand },
    );
    mgr.start();
    expect(runCommand).not.toHaveBeenCalled();
    mgr.stop();
  });

  it("does not start with no providers", () => {
    const runCommand: CommandRunner = vi.fn(async () => "x");
    const mgr = new StatusLineManager(cfg({ providers: [] }), { runCommand });
    mgr.start();
    expect(runCommand).not.toHaveBeenCalled();
    mgr.stop();
  });

  it("fires an immediate refresh on start", async () => {
    const runCommand: CommandRunner = vi.fn(async () => "x");
    const mgr = new StatusLineManager(
      cfg({ providers: [{ type: "command", id: "a", command: "x" }] }),
      { runCommand },
    );
    mgr.start();
    await vi.waitFor(() => expect(runCommand).toHaveBeenCalled());
    mgr.stop();
  });
});
