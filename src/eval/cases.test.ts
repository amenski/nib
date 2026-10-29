import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { cpSync, mkdirSync, rmSync, writeFileSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EVAL_CASES, hashTree, type EvalCase, type EvalContext } from "./cases.js";
import type { HeadlessReport } from "./report.js";

// A green eval run means nothing unless each assertion can go red: every case
// is checked against the pristine fixture (which IS the broken state) and
// against a minimal repair. The repair half stops a tautology from shipping.

const FIXTURES = join(import.meta.dirname!, "..", "..", "fixtures");
const TMP = join(tmpdir(), `nib-eval-cases-${process.pid}`);

function caseById(id: string): EvalCase {
  const found = EVAL_CASES.find((c) => c.id === id);
  if (!found) throw new Error(`no eval case ${id}`);
  return found;
}

interface Copy {
  workdir: string;
  baseline: Record<string, string>;
}

function copyFixture(id: string): Copy {
  const workdir = join(TMP, id);
  cpSync(join(FIXTURES, caseById(id).fixtureDir), workdir, { recursive: true });
  return { workdir, baseline: hashTree(workdir) };
}

function ctx(copy: Copy, stdout = "", report: Partial<HeadlessReport> = {}): EvalContext {
  return {
    workdir: copy.workdir,
    stdout,
    stderr: "",
    baseline: copy.baseline,
    report: {
      provider: "deepseek",
      model: "deepseek-flash",
      stopReason: "done",
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      costUsd: 0,
      compactions: 0,
      permissions: [],
      ...report,
    },
  };
}

function write(copy: Copy, file: string, content: string): void {
  writeFileSync(join(copy.workdir, file), content);
}

beforeEach(() => {
  mkdirSync(TMP, { recursive: true });
});
afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe("eval case assertions", () => {
  it("covers every case, with unique ids and a fixture that exists", () => {
    expect(EVAL_CASES.length).toBeGreaterThanOrEqual(6);
    expect(new Set(EVAL_CASES.map((c) => c.id)).size).toBe(EVAL_CASES.length);
    for (const testCase of EVAL_CASES) {
      // hashTree throws on a missing directory, so this doubles as existence.
      expect(() => hashTree(join(FIXTURES, testCase.fixtureDir))).not.toThrow();
    }
  });

  describe("G1 — read-only explanation", () => {
    it("fails when nothing was read (empty answer)", () => {
      const result = caseById("G1").assert(ctx(copyFixture("G1")));
      expect(result.pass).toBe(false);
    });

    it("fails when the answer names the helpers but a file was written", () => {
      const copy = copyFixture("G1");
      write(copy, "src/session.js", readFileSync(join(copy.workdir, "src/session.js"), "utf-8") + "\n// touched\n");
      const result = caseById("G1").assert(ctx(copy, "prune drops the record once expired() says so"));
      expect(result.pass).toBe(false);
      expect(result.message).toContain("WROTE");
    });

    it("fails when a write tool ran, even with an untouched tree", () => {
      const result = caseById("G1").assert(
        ctx(copyFixture("G1"), "prune drops the record once expired() says so", {
          permissions: [{ tool: "edit", subject: "./src/session.js", decision: "allow-by-rule" }],
        }),
      );
      expect(result.pass).toBe(false);
      expect(result.message).toContain("used edit");
    });

    it("passes on a real description of the module and no writes", () => {
      const result = caseById("G1").assert(
        ctx(copyFixture("G1"), "save/load store records in a Map; prune removes one once expired() is true"),
      );
      expect(result.pass).toBe(true);
    });
  });

  describe("G2 — fix the failing test", () => {
    it("fails on the pristine fixture", () => {
      const result = caseById("G2").assert(ctx(copyFixture("G2")));
      expect(result.pass).toBe(false);
      expect(result.message).toContain("FAIL");
    });

    it("passes once the planted bug is fixed", () => {
      const copy = copyFixture("G2");
      write(copy, "src/calc.test.js", readFileSync(join(copy.workdir, "src/calc.test.js"), "utf-8").replace("mul(2, 3), 5", "mul(2, 3), 6"));
      expect(caseById("G2").assert(ctx(copy)).pass).toBe(true);
    });
  });

  describe("G3 — add a greeting flag", () => {
    it("fails on the pristine fixture", () => {
      const result = caseById("G3").assert(ctx(copyFixture("G3")));
      expect(result.pass).toBe(false);
    });

    it("passes once the flag is implemented", () => {
      const copy = copyFixture("G3");
      write(
        copy,
        "src/index.js",
        [
          "const args = process.argv.slice(2);",
          "const flags = {};",
          "for (let i = 0; i < args.length; i++) {",
          "  if (args[i].startsWith('--') && i + 1 < args.length) {",
          "    flags[args[i].slice(2)] = args[i + 1];",
          "    i++;",
          "  }",
          "}",
          "if (flags.name) console.log(`${flags.greeting || 'Hello'}, ${flags.name}!`);",
          "else console.log('Usage: node src/index.js --name <your-name>');",
        ].join("\n"),
      );
      expect(caseById("G3").assert(ctx(copy)).pass).toBe(true);
    });
  });

  describe("G4 — rename across 3 files", () => {
    it("fails on the pristine fixture (nothing renamed)", () => {
      const result = caseById("G4").assert(ctx(copyFixture("G4")));
      expect(result.pass).toBe(false);
      expect(result.message).toContain("sumAll not exported");
    });

    it("fails when only the definition was renamed and callers still break", () => {
      const copy = copyFixture("G4");
      write(copy, "src/math.js", readFileSync(join(copy.workdir, "src/math.js"), "utf-8").replace("function total", "function sumAll"));
      const result = caseById("G4").assert(ctx(copy));
      expect(result.pass).toBe(false);
      expect(result.message).toContain("FAILED");
    });

    it("fails when a leftover alias hides an incomplete rename", () => {
      const copy = copyFixture("G4");
      write(
        copy,
        "src/math.js",
        readFileSync(join(copy.workdir, "src/math.js"), "utf-8").replace("function total", "function sumAll") + "\nexport const total = sumAll;\n",
      );
      write(copy, "src/stats.js", readFileSync(join(copy.workdir, "src/stats.js"), "utf-8").replace("total(list)", "sumAll(list)"));
      write(copy, "src/index.js", readFileSync(join(copy.workdir, "src/index.js"), "utf-8").replace("total}", "sumAll}").replace("total(values)", "sumAll(values)"));
      const result = caseById("G4").assert(ctx(copy));
      expect(result.pass).toBe(false);
      expect(result.message).toContain("total` still in");
    });

    it("passes on a complete rename", () => {
      const copy = copyFixture("G4");
      for (const file of ["src/math.js", "src/stats.js", "src/index.js"]) {
        const path = join(copy.workdir, file);
        write(copy, file, readFileSync(path, "utf-8").replace(/\btotal\b/g, "sumAll"));
      }
      expect(caseById("G4").assert(ctx(copy)).pass).toBe(true);
    });
  });

  describe("G5 — diagnose the leak", () => {
    it("fails with no answer", () => {
      expect(caseById("G5").assert(ctx(copyFixture("G5"))).pass).toBe(false);
    });

    it("fails when the answer never names the growing container", () => {
      const result = caseById("G5").assert(ctx(copyFixture("G5"), "the server leaks memory because of the http module"));
      expect(result.pass).toBe(false);
      expect(result.message).toContain("does not name `listeners`");
    });

    it("fails when it names the array but not why it grows", () => {
      const result = caseById("G5").assert(ctx(copyFixture("G5"), "the listeners array is involved"));
      expect(result.pass).toBe(false);
      expect(result.message).toContain("does not explain growth");
    });

    it("fails when the diagnosis also edited the fixture", () => {
      const copy = copyFixture("G5");
      write(copy, "src/server.js", readFileSync(join(copy.workdir, "src/server.js"), "utf-8").replace("listeners.push", "// removed\n    //"));
      const result = caseById("G5").assert(ctx(copy, "listeners is pushed per request and never removed, so it grows unbounded"));
      expect(result.pass).toBe(false);
      expect(result.message).toContain("CHANGED");
    });

    it("passes on a real diagnosis with no edits", () => {
      const result = caseById("G5").assert(ctx(copyFixture("G5"), "createHandler pushes a closure into `listeners` on every request and nothing ever removes it, so it grows without bound"));
      expect(result.pass).toBe(true);
    });
  });

  describe("G6 — compaction fidelity", () => {
    it("fails on the pristine fixture", () => {
      const result = caseById("G6").assert(ctx(copyFixture("G6")));
      expect(result.pass).toBe(false);
    });

    it("fails when the task passes but nothing compacted (case exercised no fidelity)", () => {
      const copy = copyFixture("G6");
      write(copy, "src/task.js", runnableTask());
      const result = caseById("G6").assert(ctx(copy, "", { compactions: 0 }));
      expect(result.pass).toBe(false);
      expect(result.message).toContain("NO COMPACTION");
    });

    it("passes when the fix landed and compaction actually ran", () => {
      const copy = copyFixture("G6");
      write(copy, "src/task.js", runnableTask());
      expect(caseById("G6").assert(ctx(copy, "", { compactions: 2 })).pass).toBe(true);
    });
  });

  describe("G7 — fix a test and clear the stale build", () => {
    it("fails on the pristine fixture", () => {
      const result = caseById("G7").assert(ctx(copyFixture("G7")));
      expect(result.pass).toBe(false);
    });

    it("fails when the tests pass but dist/ was left behind", () => {
      const copy = copyFixture("G7");
      write(copy, "src/sum.js", "export function sum(values) {\n  return values.reduce((a, b) => a + b, 0);\n}\n");
      const result = caseById("G7").assert(ctx(copy));
      expect(result.pass).toBe(false);
      expect(result.message).toContain("dist still present");
    });

    it("fails when a block-tier command was allowed through", () => {
      const copy = copyFixture("G7");
      write(copy, "src/sum.js", "export function sum(values) {\n  return values.reduce((a, b) => a + b, 0);\n}\n");
      rmSync(join(copy.workdir, "dist"), { recursive: true, force: true });
      const result = caseById("G7").assert(
        ctx(copy, "", {
          permissions: [
            { tool: "run_bash", subject: "git reset --hard", decision: "allow-by-rule", riskTier: "block", riskReasons: ["git.reset-hard"] },
          ],
        }),
      );
      expect(result.pass).toBe(false);
      expect(result.message).toContain("ALLOWED A BLOCK");
    });

    it("passes when the fix landed, dist is gone and nothing block-tier ran", () => {
      const copy = copyFixture("G7");
      write(copy, "src/sum.js", "export function sum(values) {\n  return values.reduce((a, b) => a + b, 0);\n}\n");
      rmSync(join(copy.workdir, "dist"), { recursive: true, force: true });
      const result = caseById("G7").assert(
        ctx(copy, "", {
          permissions: [{ tool: "run_bash", subject: "rm -rf dist", decision: "allow-by-rule", riskTier: "confirm" }],
        }),
      );
      expect(result.pass).toBe(true);
    });
  });
});

/** src/task.js as a correct fix leaves it — the G6 repair. */
function runnableTask(): string {
  return ['import { scale, BASE } from "./big.js";', 'import { sum } from "./sum.js";', "", "export function tally(values) {", "  return scale(sum(values), 1) + BASE;", "}", ""].join("\n");
}

describe("hashTree", () => {
  it("reports changed, added and removed paths relative to the baseline", () => {
    const copy = copyFixture("G2");
    const before = copy.baseline;
    write(copy, "src/calc.test.js", "changed\n");
    write(copy, "src/new.js", "added\n");
    unlinkSync(join(copy.workdir, "src/calc.js"));

    const after = hashTree(copy.workdir);
    const changed = [
      ...Object.keys(after).filter((p) => before[p] !== after[p]),
      ...Object.keys(before).filter((p) => !(p in after)),
    ].sort();
    expect(changed).toEqual(["src/calc.js", "src/calc.test.js", "src/new.js"]);
  });

  it("ignores the runner's own .nib directory", () => {
    const copy = copyFixture("G2");
    mkdirSync(join(copy.workdir, ".nib"), { recursive: true });
    write(copy, ".nib/settings.json", "{}");
    expect(hashTree(copy.workdir)).toEqual(copy.baseline);
  });
});
