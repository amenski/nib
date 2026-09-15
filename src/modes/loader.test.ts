import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { projectDirPath } from "../config/paths.js";
import { fileURLToPath } from "node:url";
import { ModeLoader } from "./loader.js";

const builtinSrc = join(dirname(fileURLToPath(import.meta.url)), "builtin");

describe("ModeLoader", () => {
  it("lists and loads all builtin modes from the source layout", async () => {
    const loader = new ModeLoader();
    const modes = await loader.listAll();
    const slugs = modes.map((m) => m.slug).sort();
    // Only General and Code are discoverable. The retired personas remain
    // loadable by slug for old sessions and explicit compatibility switches.
    expect(slugs).toEqual(["code", "general"]);
    const code = await loader.load("code");
    expect(code?.roleDefinition.length).toBeGreaterThan(0);
    expect(code?.groups).toContain("workflow");
    expect((await loader.load("general"))?.groups).toEqual(["read"]);
  });

  it("keeps hidden builtin modes loadable by slug while excluding them from listAll", async () => {
    const loader = new ModeLoader();
    for (const slug of ["ask", "architect", "debug", "orchestrator"]) {
      const mode = await loader.load(slug);
      expect(mode?.hidden).toBe(true);
    }
    const slugs = (await loader.listAll()).map((m) => m.slug);
    expect(slugs).toEqual(expect.arrayContaining(["general", "code"]));
    expect(slugs).not.toEqual(expect.arrayContaining(["ask", "architect", "debug", "orchestrator"]));
  });

  describe("dist layout (bundle in one dir, builtin/ beside it)", () => {
    let dist: string;

    beforeAll(async () => {
      // Reproduce the packaged layout: the loader resolves ./builtin/ relative
      // to its own module URL, so pointing builtinDir at <dir>/builtin models
      // the bundled binary at <dir>/cli.js. This is the regression under test:
      // tsup must copy the YAMLs so this directory exists next to the bundle.
      dist = await mkdtemp(join(tmpdir(), "nib-dist-"));
      await cp(builtinSrc, join(dist, "builtin"), { recursive: true });
    });

    afterAll(async () => {
      await rm(dist, { recursive: true, force: true });
    });

    it("enumerates builtin modes when they sit beside the bundle", async () => {
      const loader = new ModeLoader(join(dist, "builtin"));
      const slugs = (await loader.listAll()).map((m) => m.slug).sort();
      expect(slugs).toEqual(["code", "general"]);
    });

    it("returns an empty list (not a throw) when the builtin dir is absent", async () => {
      // Mirrors a bundle shipped WITHOUT the copy step: listAll must degrade to
      // an empty list so the CLI's "available: ..." message stays coherent.
      const loader = new ModeLoader(join(dist, "does-not-exist"));
      expect(await loader.listAll()).toEqual([]);
    });
  });

  describe("override precedence", () => {
    let home: string;
    let project: string;

    beforeAll(async () => {
      home = await mkdtemp(join(tmpdir(), "nib-home-"));
      project = await mkdtemp(join(tmpdir(), "nib-proj-"));
      await mkdir(join(home, "modes"), { recursive: true });
      await mkdir(join(projectDirPath(project), "modes"), { recursive: true });
    });

    afterAll(async () => {
      await rm(home, { recursive: true, force: true });
      await rm(project, { recursive: true, force: true });
    });

    it("prefers a project mode over the builtin of the same slug", async () => {
      await writeFile(
        join(projectDirPath(project), "modes", "code.yaml"),
        'slug: code\nname: "Project Code"\nroleDefinition: "overridden"\n',
      );
      const prevHome = process.env.NIB_HOME;
      process.env.NIB_HOME = home; // isolate from a real ~/.nib
      try {
        const loader = new ModeLoader();
        const mode = await loader.load("code", project);
        expect(mode?.name).toBe("Project Code");
        expect(mode?.roleDefinition).toBe("overridden");
      } finally {
        if (prevHome === undefined) delete process.env.NIB_HOME;
        else process.env.NIB_HOME = prevHome;
      }
    });
  });
});
