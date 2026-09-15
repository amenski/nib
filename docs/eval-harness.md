# Eval Harness (golden tasks)

**Status:** current · verified 2026-08-13 · covers `scripts/eval.ts`, `fixtures/`

## 1. Overview

`scripts/eval.ts` is the agent-level eval runner: it spawns nib
headless against small fixture projects and checks outcomes — the "golden
tasks" story that unit tests cannot cover (mocking an LLM tests the mock).
The full golden-task table (G1–G6) lives in conventions.md §Testing.

## 2. Fixtures

Each fixture under `fixtures/` is a tiny self-contained project the agent
must modify or diagnose:

| Fixture | Task | Pass criterion |
|---------|------|----------------|
| `calc` | Fix the failing test in `src/calc.test.js` (planted bug: `mul(2,3)` expects 5, actual 6) | `node --test --test-reporter=tap` reports `# pass 3` and `# fail 0` |
| `cli` | Add a `--greeting` flag to `src/index.js` | `node src/index.js --greeting Hi --name World` prints `Hi, World!` |
| `leaky` | Identify the memory leak in `src/server.js` | Agent completes a diagnosis (no automated assertion) |

G1/G4/G6 from conventions.md are not wired into the harness yet.

## 3. Mechanics

- The runner copies each fixture into `.eval-tmp/` (cleaned before and
  after) and spawns `tsx src/cli.tsx -p "<prompt>"` with a 120 s timeout
  per case, then runs the case's `assert(workdir)`.
- **Isolation**: the spawn gets a child environment built from an
  **explicit allowlist** (PATH, HOME, SHELL, NO_COLOR, TERM, TMPDIR,
  NIB_HOME — plus only the provider-key env vars) — never
  `...process.env`, so the eval agent cannot inherit arbitrary developer
  credentials. `HOME`/`NIB_HOME` point at `.eval-tmp/.home` (no
  global settings, no MCP servers to spawn at startup, nothing written to
  the real `~`), and `input: ""` closes stdin (an open pipe would hang
  headless's stdin read).
- **Eval permissions**: the runner injects a `.nib/settings.json`
  into each copied fixture with explicit `allow` rules for the edit tools
  and **narrow `run_bash` prefixes** (`node --test:*`,
  `node src/index.js:*`) — headless fails closed, so without these the
  agent could never modify a fixture, and `run_bash` is deliberately NOT
  blanket-allowed: a prompt-injected model must not gain arbitrary
  command execution on the developer's machine.
- **Failure attribution**: a non-zero nib exit (e.g. no provider key)
  reports `nib exited N: <stderr>` — distinct from a fixture-level
  task failure, so a missing key can't masquerade as "the agent failed
  the task".
- Results print as a per-task table plus a summary line; exit 0 iff every
  case passed.
- `package.json` script: `npm run eval` (runs `tsx scripts/eval.ts`).

## 4. Security model (containment)

The eval agent is **less trusted than the developer** — it runs model-chosen
actions against throwaway fixture copies, and a prompt injection is in
scope. The controls, layered:

- **Edit tools are glob-scoped to `./**`** — paths outside the fixture
  copy resolve absolute and match no rule, so headless denies them. The
  agent cannot write anywhere on the host except inside `.eval-tmp/`.
- **`run_bash` allows only narrow command prefixes** (`node --test:*`,
  `node src/index.js:*`), and the dangerous node arg shapes (`-e`,
  `--eval`, `-p`, `--print`, `-r`, `--require`, `--import`, `--loader`,
  `--experimental-loader`) are explicitly denied **in every position they
  can appear after the allowed first tokens** — a prefix allow would
  otherwise extend past them, and the deny tier always beats allows.
- **The standard engine protections still apply**: compound commands are
  split into segments (each resolved independently, most-restrictive
  wins), command substitution/backticks resolve to a fail-closed
  unresolved-ask (denied headless), and the destructive tier
  (`rm -rf /`, `git reset --hard`, …) stays absolute.
- **The child env is an explicit allowlist** (see §3) — no developer
  credentials leak into the eval process, and `HOME` points at the eval
  home.

**Residual, stated honestly**: the deny rules enumerate flag *positions*
(`node <flag>` and `node --test <flag>` / `node src/index.js <flag>`), so a
novel flag/position combination is not covered — position-denylists are
whack-a-mole, not a boundary. `node` itself executes JavaScript, and shell
redirects ride their segment. The structural fixes would be argv-scanning
in the permission engine (deny code-exec flags anywhere) or OS isolation —
the latter is the product's documented v1 non-goal
(security-destructive-matching.md §6). If you ever run evals against
untrusted prompts or third-party fixtures, do it in a container/VM.

## 5. Running

```
npm run eval
```

Auth works out of the box either way:

- **`nib auth` key** — the runner forwards the single default
  provider's key (deepseek) from the real `credentials.yaml` into the
  child. No setup needed.
- **Env var** — exporting any provider key env var
  (`DEEPSEEK_API_KEY`, `OPENAI_API_KEY`, …) forwards that one and wins.

The eval child is still isolated from the developer's real `~/.nib`
(see §3) — exactly one provider key crosses the boundary, never the whole
credentials file, never arbitrary env. No TTY needed.
