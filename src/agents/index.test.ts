import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { projectDirPath } from "../config/paths.js";
import { tmpdir } from "node:os";
import { AgentLoader } from "./index.js";
import { buildStablePreamble } from "../prompt.js";

describe("AgentLoader (feature-plans.md §F4)", () => {
  let project: string;
  let home: string;
  let prevHome: string | undefined;
  let warns: string[];

  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), "agents-proj-"));
    home = mkdtempSync(join(tmpdir(), "agents-home-"));
    prevHome = process.env.HEIRLOOM_HOME;
    process.env.HEIRLOOM_HOME = home; // isolate from a real ~/.heirloom
    mkdirSync(join(projectDirPath(project), "agents"), { recursive: true });
    mkdirSync(join(home, "agents"), { recursive: true });
    warns = [];
    vi.spyOn(console, "warn").mockImplementation((...args) => {
      warns.push(args.map(String).join(" "));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (prevHome === undefined) delete process.env.HEIRLOOM_HOME;
    else process.env.HEIRLOOM_HOME = prevHome;
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it("loads project and global defs, project winning per name (D3)", async () => {
    writeFileSync(
      join(projectDirPath(project), "agents", "reviewer.md"),
      "---\nname: reviewer\ndescription: reviews code\nmode: code\n---\n",
    );
    writeFileSync(
      join(home, "agents", "reviewer.md"),
      "---\nname: reviewer\ndescription: global reviewer\nmode: ask\n---\n",
    );
    writeFileSync(
      join(home, "agents", "researcher.md"),
      "---\nname: researcher\ndescription: researches things\nmode: ask\n---\n",
    );

    const loader = new AgentLoader();
    const defs = await loader.load(project);

    const byName = Object.fromEntries(defs.map((d) => [d.name, d]));
    expect(byName.reviewer.description).toBe("reviews code"); // project wins
    expect(byName.reviewer.mode).toBe("code");
    expect(byName.researcher.description).toBe("researches things"); // global fills the gap
    expect(loader.get("reviewer")?.sourcePath).toContain(project);
    expect(loader.get("missing")).toBeUndefined();
    expect(warns).toEqual([]);
  });

  it("skips files missing name/description/mode with a warning naming the fields", async () => {
    writeFileSync(
      join(projectDirPath(project), "agents", "a.md"),
      "---\ndescription: no name\nmode: code\n---\n",
    );
    writeFileSync(
      join(projectDirPath(project), "agents", "b.md"),
      "---\nname: b\ndescription: no mode\n---\n",
    );

    const loader = new AgentLoader();
    const defs = await loader.load(project);

    expect(defs).toEqual([]);
    expect(warns.some((w) => w.includes("missing required field(s): name"))).toBe(true);
    expect(warns.some((w) => w.includes("missing required field(s): mode"))).toBe(true);
  });

  it("skips files without frontmatter with a warning, ignores non-md files silently", async () => {
    writeFileSync(join(projectDirPath(project), "agents", "bogus.md"), "no frontmatter here\n");
    writeFileSync(
      join(projectDirPath(project), "agents", "notes.txt"),
      "---\nname: x\ndescription: X\nmode: code\n---\n",
    );

    const loader = new AgentLoader();
    const defs = await loader.load(project);

    expect(defs).toEqual([]);
    expect(warns.some((w) => w.includes("bogus.md") && w.includes("frontmatter"))).toBe(true);
    expect(warns.some((w) => w.includes("notes.txt"))).toBe(false);
  });

  it("warns on unknown frontmatter fields but still loads the file", async () => {
    writeFileSync(
      join(projectDirPath(project), "agents", "a.md"),
      "---\nname: a\ndescription: Agent A\nmode: code\ntools: [read_file]\n---\n",
    );

    const loader = new AgentLoader();
    const defs = await loader.load(project);

    expect(defs.map((d) => d.name)).toEqual(["a"]);
    expect(warns.some((w) => w.includes('unknown frontmatter field "tools"'))).toBe(true);
  });

  it("warns on an unknown model but still loads the def (D2 fallback semantics)", async () => {
    writeFileSync(
      join(projectDirPath(project), "agents", "a.md"),
      "---\nname: a\ndescription: Agent A\nmode: code\nmodel: deepseek/does-not-exist\n---\n",
    );

    const loader = new AgentLoader();
    const defs = await loader.load(project);

    expect(defs[0].model).toBe("deepseek/does-not-exist");
    expect(warns.some((w) => w.includes('unknown model "deepseek/does-not-exist"'))).toBe(true);
  });

  it("accepts a known model without a warning", async () => {
    writeFileSync(
      join(projectDirPath(project), "agents", "a.md"),
      "---\nname: a\ndescription: Agent A\nmode: code\nmodel: deepseek/deepseek-v4-flash\n---\n",
    );

    const loader = new AgentLoader();
    const defs = await loader.load(project);

    expect(defs[0].model).toBe("deepseek/deepseek-v4-flash");
    expect(warns).toEqual([]);
  });

  it("parses multiline instructions and quoted descriptions", async () => {
    writeFileSync(
      join(projectDirPath(project), "agents", "a.md"),
      "---\nname: a\ndescription: \"Agent A\"\nmode: code\ninstructions: |\n  Be critical.\n  Cite paths.\n---\nBody is not part of the def.\n",
    );

    const loader = new AgentLoader();
    const defs = await loader.load(project);

    expect(defs[0].description).toBe("Agent A");
    expect(defs[0].instructions).toBe("Be critical. Cite paths.");
  });

  it("returns an empty list when no agent dirs exist", async () => {
    rmSync(join(projectDirPath(project), "agents"), { recursive: true, force: true });
    rmSync(join(home, "agents"), { recursive: true, force: true });

    const loader = new AgentLoader();
    expect(await loader.load(project)).toEqual([]);
    expect(warns).toEqual([]);
  });

  it("injects the name+description index into the stable preamble", () => {
    const preamble = buildStablePreamble({
      workingDir: "/workspace",
      agents: [
        { name: "reviewer", description: "reviews code", mode: "code", sourcePath: "/x.md" },
        { name: "researcher", description: "researches things", mode: "ask", sourcePath: "/y.md" },
      ],
    });

    expect(preamble).toContain("# Available agents");
    expect(preamble).toContain("- researcher: researches things");
    expect(preamble).toContain("- reviewer: reviews code");
  });

  it("prepends agent instructions to the stable preamble when set", () => {
    const preamble = buildStablePreamble({
      workingDir: "/workspace",
      agentInstructions: "You are a hostile reviewer. Be critical.",
    });

    expect(preamble.startsWith("You are a hostile reviewer. Be critical.")).toBe(true);
  });
});
