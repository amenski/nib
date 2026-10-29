# Eval Harness (golden tasks)

**Status:** current · verified 2026-10-28 · covers `scripts/eval.ts`,
`src/eval/cases.ts`, `src/eval/report.ts`, `fixtures/`

## 1. Overview

`scripts/eval.ts` is the agent-level eval runner: it spawns nib headless
against small fixture projects and checks outcomes — the "golden tasks" story
that unit tests cannot cover (mocking an LLM tests the mock).

Two things make a green run mean something:

- **Every assertion can go red.** `src/eval/cases.test.ts` runs each case's
  `assert` against the pristine fixture (which IS the broken state — a planted
  bug, a missing flag, an unanswered diagnosis) and again against a minimal
  repair. An assertion that cannot fail fails that test.
- **Every run reports what it cost.** Pass rate alone cannot tell "same score,
  one tenth the tokens" from "same score, same tokens".

## 2. Cases

Case definitions (prompt, mode, assertion) live in `src/eval/cases.ts`; the
task-table rationale is in conventions.md §Golden tasks. `G2`, `G3`, `G4` and
`G7` assert an end state; `G1`, `G5` assert behaviour under a read-only prompt;
`G6` asserts compaction fidelity.

`G6` is the compaction case conventions.md calls for: the fixture's settings
pin `contextWindow: 20000` and `compaction.threshold: 0.5`, so compaction fires
mid-run deterministically instead of depending on how much the model happens to
read. The one fact the task needs (`BASE`) exists only in the long
`src/big.js`, so a summary that dropped it surfaces as a failing test. The case
asserts `compactions >= 1` as well — a run that never compacted exercised
nothing and must not pass.

The old `risky` case is now `G7`, so `G6` means exactly one thing.

## 3. Mechanics

- The runner copies each fixture into `.eval-tmp/<fixture>-t<n>/` (cleaned
  before, kept when anything failed or `--keep` is passed) and spawns
  `tsx src/cli.tsx -p "<prompt>"` with a 180 s timeout per trial, then runs the
  case's `assert(ctx)`.
- **Trials**: `--trials N` (default 3). Cheap models are stochastic; one run is
  an anecdote. `--only G2,G5` restricts the run; `--report <path>` moves the
  JSON report (default `eval-report.json`).
- **Isolation**: the spawn gets a child environment built from an **explicit
  allowlist** (PATH, HOME, SHELL, NO_COLOR, TERM, TMPDIR, NIB_HOME — plus only
  the provider-key env vars) — never `...process.env`, so the eval agent cannot
  inherit arbitrary developer credentials. `HOME`/`NIB_HOME` point at
  `.eval-tmp/.home` (no global settings, no MCP servers to spawn at startup,
  nothing written to the real `~`), and `input: ""` closes stdin (an open pipe
  would hang headless's stdin read).
- **The run's own report**: the child is given `NIB_EVAL_REPORT=<path>`, which
  makes `runExecMode` write `sessionId`-free JSON on exit — provider, model,
  stop reason, provider-reported input/output/cached tokens, the estimated
  `costUsd` (from the bundled catalog's approximate pricing, `null` when the
  model has none), the compaction count, and every permission decision. That
  last part is the only way the assertions can see what the agent was
  *permitted* to do: a headless run writes no session store, so there are no
  session-log permission rows to read (this was the wart that made the old
  G6 check vacuous).
- **Eval permissions**: the runner injects a `.nib/settings.json` into each
  copied fixture with explicit `allow` rules for the edit tools and **narrow
  `run_bash` prefixes** (`node --test:*`, `node src/index.js:*`) — headless
  fails closed, so without these the agent could never modify a fixture, and
  `run_bash` is deliberately NOT blanket-allowed: a prompt-injected model must
  not gain arbitrary command execution on the developer's machine.
  A case may add settings (`settings`), which is how `G6` pins a small
  context window.
- **Failure attribution**: a non-zero nib exit (e.g. no provider key) reports
  `nib exited N: <stderr>` — distinct from a fixture-level task failure, so a
  missing key can't masquerade as "the agent failed the task".
- Results print per trial, then a table of pass rate / input tokens / output
  tokens / cost per case, then the overall pass rate. Exit 0 iff every trial
  passed.

## 4. Security model (containment)

The eval agent is **less trusted than the developer** — it runs model-chosen
actions against throwaway fixture copies, and a prompt injection is in
scope. The controls, layered:

- **Edit tools are glob-scoped to `./**`** — paths outside the fixture copy
  resolve absolute and match no rule, so headless denies them. The agent
  cannot write anywhere on the host except inside `.eval-tmp/`.
- **`run_bash` allows only narrow command prefixes** (`node --test:*`,
  `node src/index.js:*`), and the dangerous node arg shapes (`-e`, `--eval`,
  `-p`, `--print`, `-r`, `--require`, `--import`, `--loader`,
  `--experimental-loader`) are explicitly denied **in every position they can
  appear after the allowed first tokens** — a prefix allow would otherwise
  extend past them, and the deny tier always beats allows.
- **The standard engine protections still apply**: compound commands are
  split into segments (each resolved independently, most-restrictive wins),
  command substitution/backticks resolve to a fail-closed unresolved-ask
  (denied headless), and the destructive tier (`rm -rf /`, `git reset
  --hard`, …) stays absolute.
- **The child env is an explicit allowlist** (see §3) — no developer
  credentials leak into the eval process, and `HOME` points at the eval home.

**Residual, stated honestly**: the deny rules enumerate flag *positions*
(`node <flag>` and `node --test <flag>` / `node src/index.js <flag>`), so a
novel flag/position combination is not covered — position-denylists are
whack-a-mole, not a boundary. `node` itself executes JavaScript, and shell
redirects ride their segment. The structural fixes would be argv-scanning in
the permission engine (deny code-exec flags anywhere) or OS isolation — the
latter is the product's documented v1 non-goal
(security-destructive-matching.md §6). If you ever run evals against
untrusted prompts or third-party fixtures, do it in a container/VM.

## 5. Running

```
npm run eval                          # 3 trials per case
npx tsx scripts/eval.ts --trials 1 --only G2
npx tsx scripts/eval.ts --keep         # keep .eval-tmp even on a clean run
```

Auth works out of the box either way:

- **`nib auth` key** — the runner forwards the single default provider's key
  (deepseek) from the real `credentials.yaml` into the child. No setup needed.
- **Env var** — exporting any provider key env var
  (`DEEPSEEK_API_KEY`, `OPENAI_API_KEY`, …) forwards that one and wins.

The eval child is still isolated from the developer's real `~/.nib` (see §3) —
exactly one provider key crosses the boundary, never the whole credentials
file, never arbitrary env. No TTY needed.

## 6. Comparing harness changes

The point of the numbers is before/after. Run the suite on the current tree,
change one thing (a prompt, a gate, an edit tool), run it again with the same
`--trials`, and compare pass rate **and** cost per case. A change that lifts
the pass rate while tripling tokens is not obviously a win on a cheap-model
tool, and the table shows both.
