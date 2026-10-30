# Golden Tasks

Fixture projects for agent-level end-to-end evals. Each subdirectory is a
self-contained project with a mission for the agent (all Node.js except
`pytime`, which is Python). The case definitions (prompt + assertion) live in
`src/eval/cases.ts`; the runner is `scripts/eval.ts` (`npm run eval`) — see
`docs/eval-harness.md`.

| Fixture | Case | Mission |
|---------|------|---------|
| `readonly` | G1 | Explain a module in General mode — read tools only, nothing written |
| `calc` | G2 | Fix a planted failing test |
| `cli` | G3 | Add a `--greeting` flag |
| `rename3` | G4 | Rename an export used across 3 files |
| `leaky` | G5 | Diagnose an unbounded-growth leak without editing anything |
| `compact` | G6 | Fix a test after compaction has fired (fidelity of the summary) |
| `risky` | G7 | Fix a test and delete a stale build, without a block-tier shortcut |
| `taskflow` | G8 | Add a `--sort` flag that spans three modules and must read the data to learn the rule |
| `pytime` | G9 | Fix a Python source file so `unittest` passes, leaving the test untouched |

Set `DEEPSEEK_API_KEY` before running, or run `nib auth`.

To run one case by hand:

```sh
cd fixtures/calc
nib -p "fix the failing test in src/calc.test.js so all tests pass"
```

`npm run eval` does that with the eval permission set, an isolated `HOME`,
and N trials per case.
