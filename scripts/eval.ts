#!/usr/bin/env tsx
import { execSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, cpSync, writeFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { projectDirPath } from "../src/config/paths.js";
import { resolveHome } from "../src/config/loader.js";

const FIXTURES_DIR = resolve(import.meta.dirname!, "..", "fixtures");
const EVAL_TMP = resolve(import.meta.dirname!, "..", ".eval-tmp");
const NIB_SRC = resolve(import.meta.dirname!, "..", "src", "cli.tsx");
const TSX_BIN = resolve(import.meta.dirname!, "..", "node_modules", ".bin", "tsx");

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
const EVAL_SETTINGS = JSON.stringify({
  permissions: {
    defaultMode: "askAll",
    rules: [
      { tool: "edit", pattern: "./**", action: "allow" },
      { tool: "edit_file", pattern: "./**", action: "allow" },
      { tool: "search_replace", pattern: "./**", action: "allow" },
      { tool: "apply_diff", pattern: "./**", action: "allow" },
      { tool: "apply_patch", pattern: "./**", action: "allow" },
      { tool: "write_to_file", pattern: "./**", action: "allow" },
      // G2: node --test [src/calc.test.js]
      { tool: "run_bash", pattern: "node --test:*", action: "allow" },
      // G3: node src/index.js [...]
      { tool: "run_bash", pattern: "node src/index.js:*", action: "allow" },
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
});

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

interface EvalCase {
  name: string;
  fixtureDir: string;
  prompt: string;
  assert: (workdir: string) => { pass: boolean; message: string };
}

const EVAL_CASES: EvalCase[] = [
  {
    name: "G2 — Fix failing test (calc)",
    fixtureDir: "calc",
    prompt: "fix the failing test in src/calc.test.js so all tests pass",
    assert: (workdir) => {
      try {
        // --test-reporter=tap pins the output shape across Node versions:
        // Node >=22 defaults to the spec reporter, which never emits the
        // "# pass N" lines this assertion relies on (observed on Node 26).
        const result = execSync("node --test --test-reporter=tap src/calc.test.js", {
          cwd: workdir,
          encoding: "utf-8",
          timeout: 10000,
        });
        // TAP emits "# pass 3" AND "# fail 0" — checking both is
        // reporter-agnostic (a bare "fail" substring would match "# fail 0").
        return {
          pass: result.includes("# pass 3") && result.includes("# fail 0"),
          message: result.trim().split("\n").filter((l) => l.startsWith("#")).slice(-3).join("; "),
        };
      } catch (e: any) {
        return { pass: false, message: e.stderr?.toString().slice(0, 200) || e.message };
      }
    },
  },
  {
    name: "G3 — Add greeting flag (cli)",
    fixtureDir: "cli",
    prompt:
      "add a --greeting flag to src/index.js. when passed, it should precede the name output. example: 'node src/index.js --greeting Hi --name World' should output 'Hi, World!' instead of 'Hello, World!'",
    assert: (workdir) => {
      try {
        const result = execSync("node src/index.js --greeting Hi --name World", {
          cwd: workdir,
          encoding: "utf-8",
          timeout: 5000,
        });
        return {
          pass: result.trim() === "Hi, World!",
          message: result.trim(),
        };
      } catch (e: any) {
        return { pass: false, message: e.stderr?.toString().slice(0, 200) || e.message };
      }
    },
  },
  {
    name: "G5 — Diagnose memory leak (leaky)",
    fixtureDir: "leaky",
    prompt: "identify the memory leak in src/server.js and explain the root cause",
    assert: () => {
      return { pass: true, message: "agent completed diagnosis" };
    },
  },
];

async function main() {
  console.log("nib eval runner\n");

  if (existsSync(EVAL_TMP)) rmSync(EVAL_TMP, { recursive: true });
  mkdirSync(EVAL_TMP, { recursive: true });
  const evalHome = join(EVAL_TMP, ".home");
  mkdirSync(evalHome, { recursive: true });

  const results: { name: string; pass: boolean; message: string; duration: number }[] = [];
  let passed = 0;
  let failed = 0;

  for (const testCase of EVAL_CASES) {
    const fixtureSrc = join(FIXTURES_DIR, testCase.fixtureDir);
    const evalWorkdir = join(EVAL_TMP, testCase.fixtureDir);

    if (!existsSync(fixtureSrc)) {
      console.log(`  ${testCase.name} — SKIP (fixture not found: ${fixtureSrc})`);
      continue;
    }

    cpSync(fixtureSrc, evalWorkdir, { recursive: true });

    // Inject eval permissions so headless fail-closed doesn't deny the
    // edits the task requires (see EVAL_SETTINGS above).
    const settingsDir = projectDirPath(evalWorkdir);
    if (!existsSync(settingsDir)) mkdirSync(settingsDir, { recursive: true });
    writeFileSync(join(settingsDir, "settings.json"), EVAL_SETTINGS);

    process.stdout.write(`  ${testCase.name}... `);
    const start = Date.now();

    let spawnError: string | null = null;
    let result: ReturnType<typeof spawnSync> | null = null;
    try {
      result = spawnSync(
        TSX_BIN,
        [NIB_SRC, "-p", testCase.prompt],
        {
          cwd: evalWorkdir,
          encoding: "utf-8",
          timeout: 120_000,
          // input: "" closes the child's stdin immediately — headless mode
          // reads piped stdin to EOF (exec-input.ts), and an open pipe
          // would hang the spawn for the full timeout.
          input: "",
          env: evalChildEnv(evalHome),
        },
      );

      if (result.error) {
        spawnError = result.error.message;
      }
    } catch (e: any) {
      spawnError = e.message;
    }

    const duration = Date.now() - start;

    if (spawnError) {
      failed++;
      console.log("FAIL (spawn error)");
      results.push({
        name: testCase.name,
        pass: false,
        message: spawnError.slice(0, 40),
        duration,
      });
      continue;
    }

    // Distinguish "the agent could not run" from "the agent ran and did not
    // pass": a non-zero nib exit (e.g. no provider key) must not be
    // reported as a fixture-level task failure.
    if (result!.status !== 0) {
      failed++;
      console.log("FAIL (nib exit)");
      const stderrLine = (result!.stderr || "").trim().split("\n").slice(-1)[0] || "";
      results.push({
        name: testCase.name,
        pass: false,
        message: `nib exited ${result!.status}: ${stderrLine.slice(0, 60)}`,
        duration,
      });
      continue;
    }

    const assertion = testCase.assert(evalWorkdir);

    if (assertion.pass) {
      passed++;
      console.log("PASS");
    } else {
      failed++;
      console.log("FAIL");
    }

    results.push({
      name: testCase.name,
      pass: assertion.pass,
      message: assertion.message,
      duration,
    });
  }

  console.log("\n┌─────────────────────────────────────────────────────────────┐");
  console.log("│  Eval Results                                               │");
  console.log("├────────────────────────┬────────┬───────────────────────────┤");
  console.log("│  Task                  │  Result│  Message                  │");
  console.log("├────────────────────────┼────────┼───────────────────────────┤");
  for (const r of results) {
    const status = r.pass ? "PASS" : "FAIL";
    const color = r.pass ? "\x1b[32m" : "\x1b[31m";
    const reset = "\x1b[0m";
    const name = r.name.padEnd(22).slice(0, 22);
    const msg = r.message.padEnd(25).slice(0, 25);
    console.log(`│  ${name}│  ${color}${status}${reset}  │  ${msg}│`);
  }
  console.log("└────────────────────────┴────────┴───────────────────────────┘");
  console.log(`\n  ${passed} passed, ${failed} failed, ${results.length} total`);

  rmSync(EVAL_TMP, { recursive: true, force: true });

  process.exit(failed > 0 ? 1 : 0);
}

main();
