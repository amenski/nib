import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { projectDirPath } from "../config/paths.js";
import { tmpdir } from "node:os";
import { CommandLoader, expandCommand, findCommand } from "./index.js";

const TMP = join(tmpdir(), `nib-commands-test-${process.pid}`);

describe("CommandLoader", () => {
  let home: string;

  beforeEach(() => {
    home = join(TMP, "home");
    mkdirSync(join(home, "commands"), { recursive: true });
    process.env.NIB_HOME = home;
    vi.resetModules();
  });

  afterEach(() => {
    delete process.env.NIB_HOME;
    rmSync(TMP, { recursive: true, force: true });
  });

  it("loads a project command from its filename and frontmatter", async () => {
    const project = join(TMP, "project");
    mkdirSync(join(projectDirPath(project), "commands"), { recursive: true });
    writeFileSync(
      join(projectDirPath(project), "commands", "review.md"),
      "---\ndescription: Review the changes\nargument-hint: \"[focus]\"\n---\nReview $ARGUMENTS carefully.\n",
      "utf-8",
    );

    const loader = new CommandLoader();
    const commands = await loader.load(project);

    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      name: "review",
      description: "Review the changes",
      argumentHint: "[focus]",
      content: "Review $ARGUMENTS carefully.",
    });
  });

  it("lets a project command shadow a global one of the same name", async () => {
    const project = join(TMP, "project");
    mkdirSync(join(projectDirPath(project), "commands"), { recursive: true });
    writeFileSync(join(home, "commands", "review.md"), "---\ndescription: global\n---\nGLOBAL\n", "utf-8");
    writeFileSync(join(projectDirPath(project), "commands", "review.md"), "---\ndescription: project\n---\nPROJECT\n", "utf-8");

    const loader = new CommandLoader();
    const commands = await loader.load(project);

    const review = commands.find((c) => c.name === "review")!;
    expect(review.content).toBe("PROJECT");
    expect(review.description).toBe("project");
    // The shadowed global command must not survive as a second entry.
    expect(commands.filter((c) => c.name === "review")).toHaveLength(1);
  });

  it("skips files with missing frontmatter or an empty body, with a warning", async () => {
    const project = join(TMP, "project");
    mkdirSync(join(projectDirPath(project), "commands"), { recursive: true });
    writeFileSync(join(projectDirPath(project), "commands", "nofm.md"), "no frontmatter\n", "utf-8");
    writeFileSync(join(projectDirPath(project), "commands", "empty.md"), "---\n---\n\n", "utf-8");

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const loader = new CommandLoader();
    const commands = await loader.load(project);

    expect(commands).toHaveLength(0);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("expandCommand / findCommand", () => {
  const command = {
    name: "review",
    description: "",
    content: "Review $ARGUMENTS and be $ARGUMENTS about it.",
    sourcePath: "/tmp/review.md",
  };

  it("substitutes every $ARGUMENTS occurrence with the raw args", () => {
    expect(expandCommand(command, "src/a.ts src/b.ts")).toBe(
      "Review src/a.ts src/b.ts and be src/a.ts src/b.ts about it.",
    );
  });

  it("leaves a template with no placeholder unchanged and ignores args", () => {
    expect(expandCommand({ ...command, content: "Do the thing." }, "ignored")).toBe("Do the thing.");
  });

  it("does not treat $ in the args as a replacement-group reference", () => {
    expect(expandCommand(command, "$1 $2")).toBe("Review $1 $2 and be $1 $2 about it.");
  });

  it("finds a command by name and returns undefined for an unknown name", () => {
    expect(findCommand([command], "review")).toBe(command);
    expect(findCommand([command], "nope")).toBeUndefined();
  });
});
