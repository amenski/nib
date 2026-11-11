import { describe, it, expect, vi, afterEach } from "vitest";
import { withSharedDeadline } from "./lsp-symbols.js";
import type { WireSymbol } from "./protocol.js";

const SYM: WireSymbol = { name: "Foo", kind: "class", line: 1, path: "/a.dart" };

describe("withSharedDeadline (repo-map LSP budget at startup)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("passes symbols through while the budget lasts", async () => {
    const bounded = withSharedDeadline(async () => [SYM], 1_000);
    await expect(bounded("/a.dart")).resolves.toEqual([SYM]);
  });

  it("gives up on a hanging server when the budget runs out", async () => {
    vi.useFakeTimers();
    const bounded = withSharedDeadline(() => new Promise<WireSymbol[]>(() => {}), 1_000);
    const pending = bounded("/a.dart");
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(pending).resolves.toEqual([]);
  });

  it("shares one budget across files, so later files return at once", async () => {
    vi.useFakeTimers();
    const source = vi.fn(() => new Promise<WireSymbol[]>(() => {}));
    const bounded = withSharedDeadline(source, 1_000);
    const first = bounded("/a.dart");
    await vi.advanceTimersByTimeAsync(1_000);
    await first;

    await expect(bounded("/b.dart")).resolves.toEqual([]);
    expect(source).toHaveBeenCalledTimes(1);
  });

  it("does not leak an unhandled rejection from a call it already gave up on", async () => {
    vi.useFakeTimers();
    let rejectLate!: (err: Error) => void;
    const bounded = withSharedDeadline(
      () => new Promise<WireSymbol[]>((_, reject) => { rejectLate = reject; }),
      1_000,
    );
    const pending = bounded("/a.dart");
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(pending).resolves.toEqual([]);

    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    rejectLate(new Error("LSP connection disposed"));
    await vi.advanceTimersByTimeAsync(0);
    process.off("unhandledRejection", unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });
});
