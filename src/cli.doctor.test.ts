import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatLspLines, probeSearXngHealth, runDoctor } from "./cli.js";
import { loadConfig } from "./config/loader.js";

// runDoctor calls loadConfig() itself (three times); mock it so the test
// controls whether webSearch.searxngUrl is configured. Importing cli.tsx does
// not run the real CLI startup under vitest (see cli.usage.test.ts). The real
// module is spread in (credentials.ts imports resolveHome from it).
vi.mock("./config/loader.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./config/loader.js")>();
  return { ...actual, loadConfig: vi.fn() };
});

const mockLoadConfig = vi.mocked(loadConfig);

// runDoctor's checkFolderTrust (and credentials/catalog reads) go through
// resolveHome(); without this the result depends on whether the real
// ~/.nib trusts this checkout.
let homeDir: string;
let prevHome: string | undefined;
beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), "nib-doctor-home-"));
  prevHome = process.env.NIB_HOME;
  process.env.NIB_HOME = homeDir;
});
afterEach(() => {
  rmSync(homeDir, { recursive: true, force: true });
  if (prevHome === undefined) delete process.env.NIB_HOME;
  else process.env.NIB_HOME = prevHome;
});

function mockConfig(searxngUrl?: string): void {
  mockLoadConfig.mockReturnValue({
    config: { model: "test-model", webSearch: searxngUrl ? { searxngUrl } : {} },
    errors: [],
    warnings: [],
    // LoadResult field; buildFolderContentSummary reads it unconditionally.
    projectExecutionKeys: [],
  } as any);
}

describe("probeSearXngHealth (doctor SearXNG healthz probe, F2)", () => {
  it("GETs {url}/healthz and reports ok with the latency", async () => {
    const fetchStub = vi.fn(async (url: string) => {
      expect(url).toBe("http://127.0.0.1:8888/healthz");
      return { ok: true, status: 200 };
    });
    const health = await probeSearXngHealth("http://127.0.0.1:8888", fetchStub as any);
    expect(health.ok).toBe(true);
    expect(health.ms).toBeGreaterThanOrEqual(0);
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it("normalizes a trailing slash on the base URL", async () => {
    const fetchStub = vi.fn(async (_url: string) => ({ ok: true }));
    const health = await probeSearXngHealth("http://localhost:8888/", fetchStub as any);
    expect(health.ok).toBe(true);
    expect(fetchStub.mock.calls[0][0]).toBe("http://localhost:8888/healthz");
  });

  it("treats a non-2xx healthz (e.g. 500) as unreachable", async () => {
    const fetchStub = vi.fn(async () => ({ ok: false, status: 500 }));
    const health = await probeSearXngHealth("http://x", fetchStub as any);
    expect(health.ok).toBe(false);
  });

  it("treats a network error as unreachable", async () => {
    const fetchStub = vi.fn(async () => {
      throw new Error("connect ECONNREFUSED");
    });
    const health = await probeSearXngHealth("http://x", fetchStub as any);
    expect(health.ok).toBe(false);
  });

  it("times out an unresponsive healthz and never retries (default 3 s, injectable)", async () => {
    const fetchStub = vi.fn(
      (_url: string, opts: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          opts.signal.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );
    const health = await probeSearXngHealth("http://x", fetchStub as any, 25);
    expect(health.ok).toBe(false);
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });
});

describe("runDoctor SearXNG line", () => {
  let logs: string[];
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logs = [];
    logSpy = vi.spyOn(console, "log").mockImplementation((...args) =>
      logs.push(args.map(String).join(" ")),
    );
  });
  afterEach(() => {
    logSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it("prints 'ok (N ms)' when /healthz responds", async () => {
    mockConfig("http://127.0.0.1:8888");
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true })));
    await runDoctor();
    expect(logs.some((l) => /^  SearXNG\s+ok \(\d+ ms\)$/.test(l))).toBe(true);
  });

  it("prints the Bing-fallback notice when /healthz is unreachable", async () => {
    mockConfig("http://127.0.0.1:8888");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("connect ECONNREFUSED");
      }),
    );
    await runDoctor();
    expect(
      logs.some((l) => l === "  SearXNG           unreachable — searches will fall back to Bing."),
    ).toBe(true);
  });

  it("omits the SearXNG line entirely when no searxngUrl is configured", async () => {
    mockConfig();
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true })));
    await runDoctor();
    expect(logs.some((l) => l.startsWith("  SearXNG"))).toBe(false);
  });
});

describe("runDoctor lsp row", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nib-doctor-lsp-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const server = (command: string) => ({ command, extensionToLanguage: { ".dart": "dart", ".dt": "dart" } });

  it("says 'none configured' when no server applies", () => {
    expect(formatLspLines({ lsp: { builtinServers: false } } as any, dir, dir)).toEqual([
      "  lsp               none configured",
    ]);
  });

  it("reports a resolvable command as ready, with its extensions", () => {
    const bin = join(dir, "dart");
    writeFileSync(bin, "#!/bin/sh\n");
    chmodSync(bin, 0o755);
    const lines = formatLspLines({ lsp: { builtinServers: false }, lspServers: { dart: server("dart") } } as any, dir, dir);
    expect(lines).toEqual(["  lsp               dart: dart (ready) [.dart .dt]"]);
  });

  it("reports a missing binary as not on PATH", () => {
    const lines = formatLspLines({ lsp: { builtinServers: false }, lspServers: { dart: server("dart") } } as any, dir, dir);
    expect(lines[0]).toMatch(/^  lsp {15}dart: dart \(not on PATH\) \[\.dart \.dt\]$/);
  });

  it("reports a command outside the allowlist as blocked under strictMcpConfig", () => {
    const lines = formatLspLines(
      { strictMcpConfig: true, lsp: { builtinServers: false }, lspServers: { evil: server("./x") } } as any,
      dir,
      dir,
    );
    expect(lines[0]).toMatch(/^  lsp {15}evil: \.\/x \(blocked by strictMcpConfig\)/);
  });

  it("reports an allowlisted command with a PATH override as blocked under strictMcpConfig", () => {
    const lines = formatLspLines(
      { strictMcpConfig: true, lsp: { builtinServers: false }, lspServers: { dart: { ...server("dart"), env: { PATH: "./bin" } } } } as any,
      dir,
      dir,
    );
    expect(lines[0]).toContain("(blocked by strictMcpConfig)");
  });

  it("is printed by runDoctor", async () => {
    mockConfig();
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...a) => logs.push(a.map(String).join(" ")));
    await runDoctor();
    spy.mockRestore();
    expect(logs.some((l) => /^ {2}lsp {15}\S/.test(l))).toBe(true);
  });
});
