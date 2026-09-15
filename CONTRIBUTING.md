# Contributing to Nib

Thanks for your interest in Nib. Bug reports, docs fixes, new provider
presets, and features are all welcome. This guide covers how to get set up,
what's expected in a PR, and where things live.

By participating, you agree to abide by our
[Code of Conduct](./CODE_OF_CONDUCT.md).

---

## Getting set up

Requires **Node 20+**.

```bash
git clone https://github.com/amenski/nib.git
cd nib
npm install
```

The core dev commands — the same ones CI runs:

```bash
npm test              # vitest — edit strategies, permissions, registry, compaction, sessions
npm run test:watch    # watch mode while developing
npx tsc --noEmit      # type gate (no emit — just checks)
npm run build         # bundle with tsup
npm start             # run the TUI from source (tsx)
```

To run your local build as the `nib` binary:

```bash
npm run build && npm link
nib doctor            # sanity-check your setup
```

You'll need an API key for at least one provider to actually exercise the
agent — `npm start -- auth`, or export an env var like `ANTHROPIC_API_KEY`. See
the [README](./README.md#quickstart) for the provider list.

---

## Before you open a PR

1. **`npm test` and `npx tsc --noEmit` both pass.** These are the CI gates
   ([`.github/workflows/build.yml`](./.github/workflows/build.yml)); a red
   check blocks merge.
2. **New behavior comes with tests.** The existing suites (co-located
   `*.test.ts` files next to the code they cover) are the pattern to follow.
   Agent-level golden tasks live in [`fixtures/`](./fixtures/).
3. **Update the relevant spec.** Every subsystem has a doc in
   [`docs/`](./docs/), and every design decision is written down there. If you
   change how a subsystem behaves, update its spec in the same PR — keep code
   and docs in sync. New or renamed docs must be listed in
   [`docs/README.md`](./docs/README.md) (the canonical index) in the same
   change.
4. **Keep changes surgical.** Touch only what the change requires; match the
   surrounding style rather than reformatting or refactoring adjacent code.

---

## Where things live

Nib is deliberately framework-free — plain TypeScript in readable layers.
A quick map of the source tree:

| Path | What's there |
|---|---|
| `src/agent.ts` | The ReAct loop: streaming, tool dispatch, self-reflection, recovery |
| `src/providers/` | Provider adapters + presets (`presets.ts` is where you add a model/provider) |
| `src/tools/` | Built-in tools and the edit strategies with stale-file detection |
| `src/permissions/` | Rule engine, approval postures, bash normalization, destructive detection |
| `src/modes/` | Persona definitions (`builtin/*.yaml`) and the loader |
| `src/sessions/` | Append-only JSONL session store, resume, redaction |
| `src/compaction/` | Auto-compaction and token budgeting |
| `src/checkpoints/` | Shadow-Git snapshots for `/undo` |
| `src/skills/` | Agent Skills discovery and loading |
| `src/mcp/` | Model Context Protocol client/connector |
| `src/config/` | `settings.json` loader, validation, credentials |
| `src/ui/` | The Ink TUI (App, prompt input, permission prompt, views) |
| `docs/` | The reference set, indexed by [`docs/README.md`](./docs/README.md) — start there |

When in doubt about which layer to touch, the matching doc in `docs/` explains
the contract before you read the code.

---

## Good first contributions

- **Add a provider preset** in
  [`src/providers/presets.ts`](./src/providers/presets.ts) — usually a few
  lines plus a test in `presets.test.ts`.
- **Improve an edit strategy** or its stale-detection in
  [`src/tools/`](./src/tools/).
- **Sharpen a doc** in [`docs/`](./docs/), or add a golden task under
  [`fixtures/`](./fixtures/).

Not sure where to start? Open an issue describing what you'd like to do and
we'll point you at the right layer.

---

## Reporting bugs & security issues

- **Bugs / ideas:** open a GitHub issue with steps to reproduce (and the output
  of `nib doctor` if it's environment-related).
- **Security:** Nib executes LLM-chosen commands on your machine — see
  [`docs/security-spec.md`](./docs/security-spec.md) for the threat model.
  Please report security-sensitive issues privately to **amantwd@gmail.com**
  rather than filing a public issue.

---

## License

By contributing, you agree that your contributions will be licensed under the
[Apache License 2.0](./LICENSE), the same license that covers the project.
