import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { projectDirPath, PROJECT_DIR_NAME } from "./config/paths.js";
import { tmpdir } from "node:os";
import { loadProjectRules, loadProjectResearch, buildVolatileContext, buildStablePreamble, buildRepoMap, getUserInstructions, getProjectInstructions, REPOMAP_BYTE_BUDGET, MAX_RESEARCH_BYTES } from "./prompt.js";

describe("loadProjectRules", () => {
  let projectDir: string;

  function rulesDir(): string {
    return join(projectDirPath(projectDir), "rules");
  }

  function writeRule(relPath: string, content: string): void {
    const full = join(rulesDir(), relPath);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "heirloom-rules-"));
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it("returns null when the rules dir is absent", () => {
    expect(loadProjectRules(projectDir)).toBeNull();
  });

  it("returns null when the rules dir has no usable content", () => {
    mkdirSync(rulesDir(), { recursive: true });
    expect(loadProjectRules(projectDir)).toBeNull();
  });

  it("scopes a nested file by its path relative to the rules dir", () => {
    writeRule("api/naming.md", "Use camelCase for functions.");

    const out = loadProjectRules(projectDir);
    expect(out).toContain("# Project Rules");
    expect(out).toContain("### Rule: api/naming");
    expect(out).toContain("Use camelCase for functions.");
  });

  it("orders files before subdirectories, alphabetical within each group", () => {
    // Deliberately interleaved: top-level files, plus nested dirs.
    writeRule("zeta.md", "Z rule.");
    writeRule("alpha.md", "A rule.");
    writeRule("api/naming.md", "API naming.");
    writeRule("api/errors.md", "API errors.");
    writeRule("db/schema.md", "DB schema.");

    const out = loadProjectRules(projectDir)!;
    const scopes = [...out.matchAll(/### Rule: (\S+)/g)].map((m) => m[1]);

    // Files (alpha, zeta) come before subdirectories (api/*, db/*).
    // Within api/, errors < naming. db/ comes after api/.
    expect(scopes).toEqual([
      "alpha",
      "zeta",
      "api/errors",
      "api/naming",
      "db/schema",
    ]);
  });

  it("skips empty (and whitespace-only) files", () => {
    writeRule("kept.md", "Real content.");
    writeRule("empty.md", "");
    writeRule("blank.md", "   \n\t\n  ");

    const out = loadProjectRules(projectDir)!;
    expect(out).toContain("### Rule: kept");
    expect(out).not.toContain("### Rule: empty");
    expect(out).not.toContain("### Rule: blank");
  });

  it("skips symlinked files that resolve outside the project directory", () => {
    // A secret file living entirely outside the project.
    const outside = mkdtempSync(join(tmpdir(), "heirloom-outside-"));
    const secret = join(outside, "secret.md");
    writeFileSync(secret, "SHOULD NOT BE INJECTED");

    mkdirSync(rulesDir(), { recursive: true });
    writeRule("legit.md", "Legit rule.");
    symlinkSync(secret, join(rulesDir(), "escape.md"));

    const out = loadProjectRules(projectDir)!;
    expect(out).toContain("### Rule: legit");
    expect(out).not.toContain("SHOULD NOT BE INJECTED");
    expect(out).not.toContain("### Rule: escape");

    rmSync(outside, { recursive: true, force: true });
  });

  it("truncates with a note when the size cap is exceeded", () => {
    // Each rule ~8KB; three of them blow past the 20KB cap.
    const big = "x".repeat(8 * 1024);
    writeRule("a.md", big);
    writeRule("b.md", big);
    writeRule("c.md", big);

    const out = loadProjectRules(projectDir)!;
    expect(out).toContain("Project rules truncated");
    // First two fit; the third pushes over and is dropped.
    expect(out).toContain("### Rule: a");
    expect(out).toContain("### Rule: b");
    expect(out).not.toContain("### Rule: c");
  });
});

describe("loadProjectResearch", () => {
  let projectDir: string;

  function researchDir(): string {
    return join(projectDirPath(projectDir), "research");
  }

  function writeNote(relPath: string, content: string): void {
    const full = join(researchDir(), relPath);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "heirloom-research-"));
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it("returns null when the research dir is absent", () => {
    expect(loadProjectResearch(projectDir)).toBeNull();
  });

  it("scopes a nested file by its path relative to the research dir", () => {
    writeNote("api/design.md", "Use the gateway pattern for external calls.");

    const out = loadProjectResearch(projectDir);
    expect(out).toContain("# Research Notes");
    expect(out).toContain("### Note: api/design");
    expect(out).toContain("Use the gateway pattern for external calls.");
  });

  it("orders files before subdirectories, alphabetical within each group", () => {
    writeNote("zeta.md", "Z note.");
    writeNote("alpha.md", "A note.");
    writeNote("api/naming.md", "API naming.");
    writeNote("api/errors.md", "API errors.");
    writeNote("db/schema.md", "DB schema.");

    const out = loadProjectResearch(projectDir)!;
    const scopes = [...out.matchAll(/### Note: (\S+)/g)].map((m) => m[1]);
    expect(scopes).toEqual([
      "alpha",
      "zeta",
      "api/errors",
      "api/naming",
      "db/schema",
    ]);
  });

  it("skips symlinked files that resolve outside the project directory", () => {
    const outside = mkdtempSync(join(tmpdir(), "heirloom-research-outside-"));
    const secret = join(outside, "secret.md");
    writeFileSync(secret, "SHOULD NOT BE INJECTED");

    mkdirSync(researchDir(), { recursive: true });
    writeNote("legit.md", "Legit note.");
    symlinkSync(secret, join(researchDir(), "escape.md"));

    const out = loadProjectResearch(projectDir)!;
    expect(out).toContain("### Note: legit");
    expect(out).not.toContain("SHOULD NOT BE INJECTED");
    expect(out).not.toContain("### Note: escape");

    rmSync(outside, { recursive: true, force: true });
  });

  it("truncates with a note when the size cap is exceeded", () => {
    // Each note ~5KB; two of them plus the header exceed the 8KB cap.
    const big = "x".repeat(5 * 1024);
    writeNote("a.md", big);
    writeNote("b.md", big);

    const out = loadProjectResearch(projectDir)!;
    expect(out).toContain("Research notes truncated");
    // First note fits; the second pushes over and is dropped.
    expect(out).toContain("### Note: a");
    expect(out).not.toContain("### Note: b");
    expect(Buffer.byteLength(out, "utf-8")).toBeLessThanOrEqual(MAX_RESEARCH_BYTES + 256);
  });
});

describe("buildVolatileContext — plan-mode research injection", () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "heirloom-volatile-"));
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it("includes the research block in plan mode when research is provided", async () => {
    const research = "# Research Notes\n### Note: api\nUse the gateway pattern.";
    const out = await buildVolatileContext({ workingDir: projectDir, planMode: true, research });
    expect(out).toContain("You are in planning mode.");
    expect(out).toContain("# Research Notes");
    expect(out).toContain("### Note: api");
  });

  it("omits the research block when not in plan mode", async () => {
    const research = "# Research Notes\n### Note: api\nUse the gateway pattern.";
    const out = await buildVolatileContext({ workingDir: projectDir, planMode: false, research });
    expect(out).not.toContain("# Research Notes");
  });

  it("omits the research block in plan mode when none is loaded", async () => {
    const out = await buildVolatileContext({ workingDir: projectDir, planMode: true });
    expect(out).toContain("You are in planning mode.");
    expect(out).not.toContain("# Research Notes");
  });
});

describe("buildRepoMap", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "heirloom-repomap-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns a map (no truncation note) for a small repo under budget", async () => {
    writeFileSync(join(dir, "a.ts"), "export function alpha() {}\n");
    writeFileSync(join(dir, "b.ts"), "export class Beta {}\n");

    const out = await buildRepoMap(dir);
    expect(out).not.toBeNull();
    expect(out).toContain("a.ts");
    expect(out).toContain("alpha");
    expect(Buffer.byteLength(out!, "utf-8")).toBeLessThanOrEqual(REPOMAP_BYTE_BUDGET + 128);
    expect(out).not.toContain("truncated");
  });

  it("caps at the byte budget and appends a truncation note when the corpus overflows", async () => {
    // Many files, each with several exported symbols — well over the 4KB cap.
    for (let i = 0; i < 200; i++) {
      const syms = Array.from({ length: 8 }, (_, j) => `export function fn_${i}_${j}() {}`).join("\n");
      writeFileSync(join(dir, `mod_${i}.ts`), syms + "\n");
    }

    const out = await buildRepoMap(dir);
    expect(out).not.toBeNull();
    expect(out).toContain("Repository map truncated");
    // The capped body (everything before the note) must respect the byte budget.
    const body = out!.split("*(Repository map truncated")[0];
    expect(Buffer.byteLength(body, "utf-8")).toBeLessThanOrEqual(REPOMAP_BYTE_BUDGET);
  });

  it("returns null for an empty repository (degrades to no map)", async () => {
    // Directory with no source files → nothing to map.
    writeFileSync(join(dir, "README.md"), "# no source here\n");
    expect(await buildRepoMap(dir)).toBeNull();
  });

  it("returns null (never throws) when the directory does not exist", async () => {
    const missing = join(dir, "does-not-exist");
    await expect(buildRepoMap(missing)).resolves.toBeNull();
  });
});

describe("buildStablePreamble — repository map injection", () => {
  it("injects the map under a '# Repository map' header, after project rules", () => {
    const projectDir = mkdtempSync(join(tmpdir(), "heirloom-preamble-"));
    try {
      mkdirSync(join(projectDirPath(projectDir), "rules"), { recursive: true });
      writeFileSync(
        join(projectDirPath(projectDir), "rules", "naming.md"),
        "Use camelCase.",
      );

      const out = buildStablePreamble({
        workingDir: projectDir,
        repomap: "src/foo.ts: function foo",
      });

      expect(out).toContain("# Repository map");
      expect(out).toContain("src/foo.ts: function foo");
      // Ordering: rules block precedes the repository map.
      const rulesIdx = out.indexOf("# Project Rules");
      const mapIdx = out.indexOf("# Repository map");
      expect(rulesIdx).toBeGreaterThanOrEqual(0);
      expect(mapIdx).toBeGreaterThan(rulesIdx);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("omits the map header entirely when no map is provided", () => {
    const out = buildStablePreamble({ workingDir: process.cwd() });
    expect(out).not.toContain("# Repository map");
  });
});

describe("buildStablePreamble — tool guides", () => {
  const workingDir = process.cwd();
  const mode = (groups: ("read" | "edit" | "command" | "workflow")[]) => ({
    slug: "test",
    name: "Test",
    roleDefinition: "Test mode",
    groups,
  });

  it("keeps the edit and shell guide for Code with workflow delegation", () => {
    const out = buildStablePreamble({
      workingDir,
      mode: mode(["read", "edit", "command", "workflow"]),
    });

    expect(out).toContain("# Choosing an edit tool");
    expect(out).toContain("# Shell");
  });

  it("does not add the edit or shell guide to a workflow-only mode", () => {
    const out = buildStablePreamble({
      workingDir,
      mode: mode(["workflow"]),
    });

    expect(out).not.toContain("# Choosing an edit tool");
    expect(out).not.toContain("# Shell");
  });

  it("keeps General without the edit or shell guide", () => {
    const out = buildStablePreamble({
      workingDir,
      mode: mode(["read"]),
    });

    expect(out).not.toContain("# Choosing an edit tool");
    expect(out).not.toContain("# Shell");
  });
});

describe("getProjectInstructions — CLAUDE.md chain", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "heirloom-instructions-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeFile(rel: string, content: string): void {
    const full = join(dir, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }

  it("returns empty when no instructions file exists", () => {
    expect(getProjectInstructions(dir)).toBe("");
  });

  it("prefers .heirloom/instructions.md over CLAUDE.md", () => {
    writeFile("CLAUDE.md", "repo CLAUDE.md");
    writeFile(`${PROJECT_DIR_NAME}/instructions.md`, "heirloom instructions");
    expect(getProjectInstructions(dir)).toContain("heirloom instructions");
    expect(getProjectInstructions(dir)).not.toContain("repo CLAUDE.md");
  });

  it("falls back to CLAUDE.md when instructions.md is absent", () => {
    writeFile("CLAUDE.md", "repo CLAUDE.md");
    expect(getProjectInstructions(dir)).toContain("# Project instructions");
    expect(getProjectInstructions(dir)).toContain("repo CLAUDE.md");
  });

  it("uses AGENTS.md only when neither instructions.md nor CLAUDE.md exists", () => {
    writeFile("AGENTS.md", "agents content");
    expect(getProjectInstructions(dir)).toContain("agents content");
  });

  it("ignores an empty CLAUDE.md and falls through to AGENTS.md", () => {
    writeFile("CLAUDE.md", "   ");
    writeFile("AGENTS.md", "agents content");
    expect(getProjectInstructions(dir)).toContain("agents content");
  });
});

describe("getUserInstructions — ~/.claude/CLAUDE.md", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "heirloom-home-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("returns empty when ~/.claude/CLAUDE.md is absent", () => {
    expect(getUserInstructions(home)).toBe("");
  });

  it("returns a # User instructions section when present", () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", "CLAUDE.md"), "global rules");
    const out = getUserInstructions(home);
    expect(out).toContain("# User instructions");
    expect(out).toContain("global rules");
  });

  it("ignores an empty file", () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", "CLAUDE.md"), "\n  \n");
    expect(getUserInstructions(home)).toBe("");
  });
});
