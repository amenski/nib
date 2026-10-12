import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runMcp } from "./mcp-command.js";

let homeDir = "";
let out: string[] = [];
let err: string[] = [];

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), "nib-mcp-cmd-"));
  out = [];
  err = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { out.push(a.join(" ")); });
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => { err.push(a.join(" ")); });
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(homeDir, { recursive: true, force: true });
});

const settings = () => JSON.parse(readFileSync(join(homeDir, "settings.json"), "utf-8"));

describe("nib mcp add", () => {
  it("writes the server into the global settings", async () => {
    expect(await runMcp(["add", "playwright", "--", "npx", "@playwright/mcp@latest"], { homeDir })).toBe(0);
    expect(settings().mcpServers.playwright).toEqual({ command: "npx", args: ["@playwright/mcp@latest"] });
    expect(out.join("\n")).toContain("Restart nib, then run /mcp");
  });

  it("--no-sandbox writes sandbox:false and warns once", async () => {
    await runMcp(["add", "playwright", "--no-sandbox", "--", "npx", "@playwright/mcp@latest"], { homeDir });
    expect(settings().mcpServers.playwright.sandbox).toBe(false);
    expect(out.filter((l) => l.includes("outside nib's sandbox"))).toHaveLength(1);
  });

  it("parses --env KEY=VALUE", async () => {
    await runMcp(["add", "gh", "--env", "TOKEN=a=b", "-e", "X=1", "--", "npx", "gh-mcp"], { homeDir });
    expect(settings().mcpServers.gh.env).toEqual({ TOKEN: "a=b", X: "1" });
  });

  it("keeps every other settings key", async () => {
    writeFileSync(join(homeDir, "settings.json"), JSON.stringify({ model: "m", mcpServers: { old: { command: "node" } } }));
    await runMcp(["add", "new", "--", "npx", "x"], { homeDir });
    expect(settings().model).toBe("m");
    expect(Object.keys(settings().mcpServers)).toEqual(["old", "new"]);
  });

  it("rejects a duplicate name", async () => {
    await runMcp(["add", "p", "--", "npx", "x"], { homeDir });
    expect(await runMcp(["add", "p", "--", "npx", "y"], { homeDir })).toBe(1);
    expect(err.join("\n")).toContain("already exists");
    expect(settings().mcpServers.p.args).toEqual(["x"]);
  });

  it("rejects a bad name, a missing command and a missing name", async () => {
    expect(await runMcp(["add", "bad name!", "--", "npx", "x"], { homeDir })).toBe(1);
    expect(await runMcp(["add", "p", "npx", "x"], { homeDir })).toBe(1);
    expect(await runMcp(["add", "p", "--"], { homeDir })).toBe(1);
    expect(await runMcp(["add", "--", "npx", "x"], { homeDir })).toBe(1);
  });

  it("notes a command outside the strictMcpConfig allowlist", async () => {
    await runMcp(["add", "bin", "--", "/usr/local/bin/server"], { homeDir });
    expect(out.join("\n")).toContain("not on the MCP command allowlist");
  });
});

describe("nib mcp list / remove", () => {
  it("lists servers and marks unsandboxed ones", async () => {
    await runMcp(["add", "a", "--", "npx", "a-mcp"], { homeDir });
    await runMcp(["add", "b", "--no-sandbox", "--", "npx", "b-mcp"], { homeDir });
    out = [];
    await runMcp(["list"], { homeDir });
    expect(out[0]).toContain("a  npx a-mcp");
    expect(out[0]).not.toContain("unsandboxed");
    expect(out[1]).toContain("b  npx b-mcp  (unsandboxed)");
  });

  it("removes a server, and fails for an unknown one", async () => {
    await runMcp(["add", "a", "--", "npx", "a-mcp"], { homeDir });
    expect(await runMcp(["remove", "a"], { homeDir })).toBe(0);
    expect(settings().mcpServers).toEqual({});
    expect(await runMcp(["remove", "a"], { homeDir })).toBe(1);
  });
});
