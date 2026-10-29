#!/usr/bin/env tsx
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, cpSync, writeFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { projectDirPath } from "../src/config/paths.js";
import { resolveHome } from "../src/config/loader.js";
import { trustSettings } from "../src/config/settings-trust.js";
import { EVAL_CASES, hashTree, type EvalCase } from "../src/eval/cases.js";
import {
  formatSuiteTable,
  overallPassRate,
  summarizeCase,
  type HeadlessReport,
  type SuiteReport,
  type TrialResult,
} from "../src/eval/report.js";

const FIXTURES_DIR = resolve(import.meta.dirname!, "..", "fixtures");
const EVAL_TMP = resolve(import.meta.dirname!, "..", ".eval-tmp");
/** Where the eval child's HOME/NIB_HOME point; sessions land under it. */
const EVAL_HOME = join(EVAL_TMP, ".home");
const NIB_SRC = resolve(import.meta.dirname!, "..", "src", "cli.tsx");
const TSX_BIN = resolve(import.meta.dirname!, "..", "node_modules", ".bin", "tsx");
/** The machine-readable run report; overridable with --report. */
const DEFAULT_REPORT = resolve(import.meta.dirname!, "..", "eval-report.json");
const DEFAULT_TRIALS = 3;

// Eval permissions, injected into each copied fixture's .nib/ as
// settings.json. Headless runs fail closed (permission-spec.md §Headless
// Interaction), so a fixture without explicit allow rules would deny every
// edit and run_bash call and the golden task could never modify anything.
//
// Containment model (see eval-harness.md §Security):
// - Edit tools are glob-scoped to ./** — paths outside the fixture copy
//   resolve absolute and match NO rule, so headless denies them. The agent
//   cannot write anywhere on the host except inside the throwaway fixture.
// - run_bash allows only the narrow command prefixes the fixtures need.
//   Compound commands are split into segments (bash-normalize) and the
//   destructive tier denies the catastrophic set outright. Known-dangerous
//   node arg shapes (script evaluation / module loading) are explicitly
//   denied below — the deny tier always beats these allow rules.
// - Residual (documented in eval-harness.md): node itself executes JS, and
//   redirects ride their segment, so prefix rules are model-error
//   mitigation, not adversary containment. Run untrusted evals in a
//   container/VM — the real boundary is OS isolation (security-spec §6).
const EVAL_SETTINGS: { permissions: object; completionGate?: boolean } = {
  permissions: {
    defaultMode: "askAll",
    rules: [
      { tool: "edit", pattern: "./**", action: "allow" },
      { tool: "apply_diff", pattern: "./**", action: "allow" },
      { tool: "apply_patch", pattern: "./**", action: "allow" },
      { tool: "write_to_file", pattern: "./**", action: "allow" },
      // G2/G6: node --test [src/*.test.js]
      { tool: "run_bash", pattern: "node --test:*", action: "allow" },
      // G3/G4: node src/index.js [...]
      { tool: "run_bash", pattern: "node src/index.js:*", action: "allow" },
      // G7: the risky fixture's cleanup — exact matches, deliberately, not the
      // prefix form the node rules use. A prefix `rm -rf dist` would also match
      // `rm -rf dist/../../..`, because a prefix rule's final token extends at
      // any non-alphanumeric boundary, and nothing in the destructive tier
      // catches that. Two spellings, because the rule layer matches text while
      // the risk classifier resolves paths: `dist` and `./dist` are one build
      // directory to the classifier and two strings to an exact rule.
      { tool: "run_bash", pattern: "rm -rf dist", action: "allow" },
      { tool: "run_bash", pattern: "rm -rf ./dist", action: "allow" },
      // G7 cleanup chained with verification. Models routinely write the
      // cleanup as `rm -rf dist && echo done && ls`, and a compound command
      // is split into segments where EVERY segment must be allowed — so
      // without these the one command the task asks for is denied. Both are
      // non-executing and non-writing: `ls` lists names, `echo` prints its
      // own arguments. `cat`/`find`/`grep` are deliberately NOT here: they
      // read file contents anywhere on the host, which is a real widening.
      { tool: "run_bash", pattern: "echo:*", action: "allow" },
      { tool: "run_bash", pattern: "ls:*", action: "allow" },
      { tool: "run_bash", pattern: "ls", action: "allow" },
      // Deny the node arg shapes that turn a test/script run into arbitrary
      // code execution — in EVERY position they can appear after the
      // allowed first tokens, because a prefix allow would otherwise extend
      // past them (deny tier always beats allow).
      // Position 1: node <flag> ...
      { tool: "run_bash", pattern: "node -e:*", action: "deny" },
      { tool: "run_bash", pattern: "node --eval:*", action: "deny" },
      { tool: "run_bash", pattern: "node -p:*", action: "deny" },
      { tool: "run_bash", pattern: "node --print:*", action: "deny" },
      { tool: "run_bash", pattern: "node -r:*", action: "deny" },
      { tool: "run_bash", pattern: "node --require:*", action: "deny" },
      // Position 2: node --test <flag> ... / node src/index.js <flag> ...
      { tool: "run_bash", pattern: "node --test -e:*", action: "deny" },
      { tool: "run_bash", pattern: "node --test --eval:*", action: "deny" },
      { tool: "run_bash", pattern: "node --test -p:*", action: "deny" },
      { tool: "run_bash", pattern: "node --test --print:*", action: "deny" },
      { tool: "run_bash", pattern: "node --test -r:*", action: "deny" },
      { tool: "run_bash", pattern: "node --test --require:*", action: "deny" },
      { tool: "run_bash", pattern: "node --test --import:*", action: "deny" },
      { tool: "run_bash", pattern: "node --test --loader:*", action: "deny" },
      { tool: "run_bash", pattern: "node --test --experimental-loader:*", action: "deny" },
      { tool: "run_bash", pattern: "node src/index.js -e:*", action: "deny" },
      { tool: "run_bash", pattern: "node src/index.js --eval:*", action: "deny" },
      { tool: "run_bash", pattern: "node src/index.js -p:*", action: "deny" },
      { tool: "run_bash", pattern: "node src/index.js --print:*", action: "deny" },
      { tool: "run_bash", pattern: "node src/index.js -r:*", action: "deny" },
      { tool: "run_bash", pattern: "node src/index.js --require:*", action: "deny" },
      { tool: "run_bash", pattern: "node src/index.js --import:*", action: "deny" },
      { tool: "run_bash", pattern: "node src/index.js --loader:*", action: "deny" },
      { tool: "run_bash", pattern: "node src/index.js --experimental-loader:*", action: "deny" },
    ],
  },
};

// Child environment: an explicit allowlist, NOT ...process.env — the eval
// agent is less trusted than the developer and must not inherit arbitrary
// credentials (GITHUB_TOKEN, AWS_*, etc.). The provider key env vars are
// included deliberately: real evals need exactly one of them to
// authenticate. HOME is pointed at the eval home so no subsystem writes to
// the developer's real ~; NIB_HOME is set to the same place so every
// state-dir path (all of which now resolve through resolveHome()) follows.
function evalChildEnv(evalHome: string): Record<string, string> {
  const env: Record<string, string> = {
    PATH: process.env.PATH || "",
    HOME: evalHome,
    SHELL: process.env.SHELL || "/bin/sh",
    NO_COLOR: "1",
    TERM: "dumb",
    TMPDIR: evalHome,
    NIB_HOME: evalHome,
  };
  for (const key of ["DEEPSEEK_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "GROQ_API_KEY", "ANTHROPIC_API_KEY", "TOGETHER_API_KEY"]) {
    if (process.env[key]) env[key] = process.env[key]!;
  }
  // Fallback: when NO provider env var is set, the isolated child resolves
  // the default provider (deepseek) and would otherwise fail with no key —
  // the developer's `nib auth` credentials are invisible to the eval
  // home by design. Forward exactly that ONE key from the real credentials
  // file (flat `provider: key` YAML), never the file itself, so `npm run
  // eval` just works with an auth-based setup without leaking every
  // stored credential.
  if (!Object.keys(env).some((k) => k.endsWith("_API_KEY"))) {
    const deepseekKey = readCredentialKey("deepseek");
    if (deepseekKey) env.DEEPSEEK_API_KEY = deepseekKey;
  }
  return env;
}

/** Read one provider's key from the state dir's credentials.yaml (flat `key: value` lines). */
function readCredentialKey(provider: string): string | undefined {
  try {
    const raw = readFileSync(join(resolveHome(), "credentials.yaml"), "utf-8");
    for (const line of raw.split("\n")) {
      const idx = line.indexOf(":");
      if (idx === -1) continue;
      const key = line.slice(0, idx).trim();
      if (key !== provider) continue;
      const value = line.slice(idx + 1).trim();
      // Strip optional quotes and inline comments (the shape `nib auth` writes).
      return value.replace(/^["']|["']$/g, "").replace(/\s+#.*$/, "") || undefined;
    }
  } catch {
    return undefined;
  }
}

interface Args {
  trials: number;
  reportPath: string;
  filters: string[];
  keep: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { trials: DEFAULT_TRIALS, reportPath: DEFAULT_REPORT, filters: [], keep: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--trials") {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value < 1) {
        process.stderr.write("--trials must be a positive integer\n");
        process.exit(2);
      }
      args.trials = value;
    } else if (arg === "--report") {
      args.reportPath = resolve(argv[++i] ?? DEFAULT_REPORT);
    } else if (arg === "--keep") {
      args.keep = true;
    } else if (arg === "--only") {
      const value = argv[++i] ?? "";
      args.filters.push(...value.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean));
    } else {
      process.stderr.write(`Unknown argument: ${arg}\n`);
      process.exit(2);
    }
  }
  return args;
}

/** One trial: copy the fixture, run nib headless, read the report, assert. */
function runTrial(testCase: EvalCase, trial: number, evalHome: string): TrialResult {
  const fixtureSrc = join(FIXTURES_DIR, testCase.fixtureDir);
  const workdir = join(EVAL_TMP, `${testCase.fixtureDir}-t${trial}`);

  cpSync(fixtureSrc, workdir, { recursive: true });

  const settingsDir = projectDirPath(workdir);
  if (!existsSync(settingsDir)) mkdirSync(settingsDir, { recursive: true });
  const settingsPath = join(settingsDir, "settings.json");
  writeFileSync(settingsPath, JSON.stringify({ ...EVAL_SETTINGS, ...testCase.settings }));
  // Headless strips the permissions of an untrusted project settings file
  // (exec-runner.ts), which would deny every run_bash. The eval wrote these
  // rules, so it records trust in the eval home, as a user would.
  const realNibHome = process.env.NIB_HOME;
  process.env.NIB_HOME = evalHome;
  trustSettings(settingsPath);
  if (realNibHome === undefined) delete process.env.NIB_HOME;
  else process.env.NIB_HOME = realNibHome;

  const baseline = hashTree(workdir);
  // The report lives OUTSIDE the fixture copy: an assertion that diffs the
  // tree (G1, G5) would otherwise report the harness's own output file as a
  // file the agent wrote.
  const reportPath = join(EVAL_TMP, `report-${testCase.fixtureDir}-t${trial}.json`);

  const start = Date.now();
  const result = spawnSync(TSX_BIN, [NIB_SRC, "-p", testCase.prompt, ...(testCase.mode ? ["--mode", testCase.mode] : [])], {
    cwd: workdir,
    encoding: "utf-8",
    timeout: 180_000,
    // input: "" closes the child's stdin immediately — headless mode reads
    // piped stdin to EOF (exec-input.ts), and an open pipe would hang the
    // spawn for the full timeout.
    input: "",
    env: { ...evalChildEnv(evalHome), NIB_EVAL_REPORT: reportPath },
  });
  const durationMs = Date.now() - start;

  const report: HeadlessReport | null = existsSync(reportPath)
    ? (JSON.parse(readFileSync(reportPath, "utf-8")) as HeadlessReport)
    : null;
  const tokens = { inputTokens: report?.inputTokens ?? 0, outputTokens: report?.outputTokens ?? 0, costUsd: report?.costUsd ?? null };

  if (result.error) return { pass: false, message: `spawn error: ${result.error.message.slice(0, 80)}`, durationMs, ...tokens };
  // Distinguish "the agent could not run" from "the agent ran and did not
  // pass": a non-zero nib exit (e.g. no provider key) must not be reported
  // as a fixture-level task failure.
  if (result.status !== 0) {
    const stderrLine = (result.stderr || "").trim().split("\n").slice(-1)[0] || "";
    return { pass: false, message: `nib exited ${result.status}: ${stderrLine.slice(0, 80)}`, durationMs, ...tokens };
  }

  const assertion = testCase.assert({
    workdir,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    report,
    baseline,
  });
  return { pass: assertion.pass, message: assertion.message, durationMs, ...tokens };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  // D2 comparison lever: NIB_EVAL_COMPLETION_GATE=1 runs every case with the
  // gate on, against the default-off baseline.
  if (process.env.NIB_EVAL_COMPLETION_GATE === "1") EVAL_SETTINGS.completionGate = true;
  const cases = args.filters.length > 0
    ? EVAL_CASES.filter((c) => args.filters.includes(c.id.toUpperCase()))
    : EVAL_CASES;

  console.log("nib eval runner\n");
  if (cases.length === 0) {
    console.error(`No cases match --only ${args.filters.join(",")}`);
    process.exit(2);
  }

  if (existsSync(EVAL_TMP)) rmSync(EVAL_TMP, { recursive: true });
  mkdirSync(EVAL_TMP, { recursive: true });
  const evalHome = join(EVAL_TMP, ".home");
  mkdirSync(evalHome, { recursive: true });

  // The eval child reads global settings from its own HOME. `enforce` is the
  // point of the risky fixture: shadow mode would label the run without
  // clamping it, and the fixture's whole claim is that nothing block-tier got
  // through (docs/command-risk-classifier.md §9 phase 2).
  writeFileSync(join(evalHome, "settings.json"), JSON.stringify({ classifier: { mode: "enforce" } }));

  console.log(`${cases.length} case(s) × ${args.trials} trial(s)\n`);

  const caseReports = [];
  let failures = 0;

  for (const testCase of cases) {
    const fixtureSrc = join(FIXTURES_DIR, testCase.fixtureDir);
    if (!existsSync(fixtureSrc)) {
      console.log(`  ${testCase.name} — SKIP (fixture not found: ${fixtureSrc})`);
      continue;
    }
    process.stdout.write(`  ${testCase.name}\n`);
    const trials: TrialResult[] = [];
    for (let trial = 1; trial <= args.trials; trial++) {
      const outcome = runTrial(testCase, trial, evalHome);
      trials.push(outcome);
      const status = outcome.pass ? "PASS" : "FAIL";
      const cost = outcome.costUsd === null ? "n/a" : `$${outcome.costUsd.toFixed(4)}`;
      process.stdout.write(
        `    trial ${trial}: ${status}  ${outcome.inputTokens}in/${outcome.outputTokens}out ${cost}  ${outcome.pass ? "" : outcome.message}\n`.replace(/ {2}\n/, "\n"),
      );
      if (!outcome.pass) failures++;
    }
    caseReports.push(summarizeCase(testCase.name, trials));
  }

  const suite: SuiteReport = {
    startedAt: new Date().toISOString(),
    provider: process.env.NIB_EVAL_PROVIDER ?? "deepseek",
    model: process.env.NIB_EVAL_MODEL ?? "default",
    trialsPerCase: args.trials,
    cases: caseReports,
  };

  console.log(`\n${formatSuiteTable(suite)}`);
  console.log(`\n  overall pass rate: ${(overallPassRate(suite) * 100).toFixed(0)}%`);
  writeFileSync(args.reportPath, JSON.stringify(suite, null, 2) + "\n");
  console.log(`  report: ${args.reportPath}`);

  // Keep the workdirs of a failing run: they are the only record of what the
  // agent tried. `--keep` keeps them even when everything passed.
  if (failures > 0 || args.keep) console.log(`  kept ${EVAL_TMP} for inspection`);
  else rmSync(EVAL_TMP, { recursive: true, force: true });

  process.exit(failures > 0 ? 1 : 0);
}

main();
