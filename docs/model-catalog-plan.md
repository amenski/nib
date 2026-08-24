# Models.dev Catalog Plan

**Status:** implemented · verified 2026-08-23 · slices A/B/C/D shipped. Covers
the provider model catalog, capability lookup, model picker, compaction
limits, and cost estimate.

## 1. Goal

Replace the small hand-maintained model metadata list with a reproducible
Models.dev-derived snapshot for the providers Heirloom already supports.
The catalog must remain available offline at startup, and local configuration
must remain able to add or correct entries.

This work changes metadata only. It neither adds provider integrations nor
changes model routing, credential resolution, permissions, or billing.

## 2. Decisions

1. **Models.dev is the upstream metadata source.** Its provider-model entries
   supply display name, context/output limits, tool and reasoning capability,
   modalities, and USD-per-million-token costs. The checked-in snapshot is
   generated from a Models.dev-shaped fixture; a maintainer can explicitly
   refresh that fixture from the official API (`npm run models:capture`, tier
   1) and then regenerate the snapshot from it (`npm run models:generate`,
   tier 2) — see §4.D. The three tiers (capture / generate / update) each
   carry the strictness their audience needs: capture is the only one that
   touches the network and is maintainer-only; generate is offline and strict
   against the curated fixture; `heirloom models update` (§4.C) is online and
   lenient against the live feed.
2. **The shipped snapshot is authoritative at runtime.** Heirloom must never
   contact Models.dev at startup or while selecting a model. A network outage
   or catalog change cannot make a previously working installation unusable.
3. **Only implemented providers are shipped.** Initially: DeepSeek, OpenAI,
   OpenRouter, Groq, and Ollama. Models.dev records for other providers are
   not selectable until Heirloom supports their API/authentication contract.
4. **Provider configuration remains hand-owned.** Base URL, API shape, key
   environment variable, and default model are integration facts, not model
   catalog data. Keep them in a compact checked-in provider-preset source.
5. **User overrides win.** `~/.heirloom/models.json` stays the last merge
   layer. It can add a model or override any generated value without copying
   the full provider catalog.
6. **Costs are estimates, never billing truth.** A resolved catalog cost is
   shown only when `showCost` is enabled. It never affects routing, limits, or
   account balance. Provider-specific entries are used: for example,
   `openrouter/qwen/qwen3.7-flash`, not the generic Qwen entry.

## 3. Catalog shape

Normalize Models.dev data at generation time into Heirloom's internal shape;
do not make runtime code interpret a third-party schema.

| Models.dev | Heirloom catalog | Consumer |
|---|---|---|
| `name` | `displayName` | model picker |
| `limit.context` | `contextWindow` | compaction |
| `limit.output` | `maxOutputTokens` (new, optional) | provider request cap when wired |
| `tool_call` | `supportsTools` | picker/tool gating |
| `reasoning_options` | `effort` | `/effort` picker |
| `modalities` | `modalities` (new, optional) | attachment eligibility |
| `cost.input`, `cost.output` | `pricing.inputPerM`, `pricing.outputPerM` | cost estimate |
| `cost.cache_read`, `cost.cache_write`, `cost.reasoning` | optional extended pricing | future precise estimates |

The first implementation must preserve existing `pricing` consumers. Extended
rates are stored but not displayed until usage events distinguish the matching
token categories.

## 4. Delivery slices

### A. Contract and generator

**✅ Shipped 2026-08-21.** Static provider presets are separate from the
generated metadata snapshot. `npm run models:generate` consumes a local
fixture by default, or an explicitly supplied Models.dev API URL; it is never
called at startup, in builds, or in tests.

- Split the current combined `src/providers/models.json` into stable provider
  presets and a generated model snapshot.
- Add a deterministic generator which consumes a local fixture or an
  explicitly supplied Models.dev JSON URL, filters to supported providers,
  normalizes the fields above, sorts keys, and writes the checked-in snapshot
  plus source revision/date metadata.
- Validate fetched data before writing: object shape, supported API mapping,
  non-negative costs, positive context limits, and a usable default model for
  every shipped provider.
- Add a fixture-driven generator test; no test should rely on the network.

### B. Runtime merge and capability consumers

**✅ Shipped 2026-08-21.** The loader composes presets and the bundled
snapshot before applying the unchanged `~/.heirloom/models.json` override.
Qwen3.7 Flash is included as an OpenRouter model.

- Load stable provider presets + generated snapshot, then preserve today's
  deep merge of `~/.heirloom/models.json`.
- Extend `ModelCapabilities` only for normalized metadata that has a present
  consumer. Keep unknown/malformed user fields non-fatal and warn as today.
- Regression-test default resolution, `/model` completion, context-window
  lookup, effort choices, cost-estimate lookup, and the Qwen OpenRouter
  override.

### C. Explicit update command

**✅ Shipped 2026-08-23.** `heirloom models update` downloads the Models.dev
feed (10 s timeout, injectable fetch for tests), validates it by running it
through `generateCatalogReport` (the same normalization `generateCatalog`
uses, wrapping the shared core), diffs it against the active snapshot, and
only writes `HEIRLOOM_HOME/models-catalog.json` (atomically, via
temp-file-then-rename) after confirmation. `heirloom models status` reports
whether the active snapshot is bundled or an updated cache, its source
revision/date, and provider/model counts.

- `heirloom models update` downloads the official Models.dev feed with a
  timeout and schema validation; regenerates in memory; shows added, removed,
  and changed models and prices; requires confirmation before replacing the
  local cached snapshot (`--yes` skips the prompt; a non-TTY without `--yes`
  refuses outright rather than writing unprompted).
- The bundled snapshot is preserved as fallback and never overwritten. A
  failed download, a non-object/malformed feed, or a declined diff leaves the
  active catalog untouched.
- `heirloom models status` shows source revision/date and whether a local
  updated snapshot is active.
- **Lenient validation against the live feed (added 2026-08-23).** The real
  Models.dev feed (measured: 193 providers) is not the curated fixture
  `npm run models:generate` runs against — strict validation against it fails
  100% of the time. `generateCatalog` (used by `models:generate`) keeps
  throwing on any malformed entry or missing
  SUPPORTED_PROVIDERS provider, unchanged. `models update` alone opts into
  `GeneratorOptions.lenient`, which: (1) skips an individual model that fails
  normalization instead of aborting the whole catalog — the live feed
  legitimately carries models with no context limit (image/audio, e.g. Groq
  Whisper, OpenAI's `gpt-image-*`), which Heirloom can't use anyway; (2) skips
  a SUPPORTED_PROVIDERS entry rather than treating it as fatal whether the
  feed doesn't list it at all (`ollama` — local inference, never a Models.dev
  provider) or lists it with an empty models object (an upstream glitch or a
  provider mid-deprecation), since one bad provider must not block every
  other provider's real corrections. A provider actually present in the feed
  but missing its configured default model stays fatal in both modes.
  `models update` carries each skipped provider forward from the active
  snapshot before diffing/writing, so it keeps its bundled entry instead of
  showing up as a spurious removal on every update, and reports it in the
  pre-confirmation output distinguishing "absent from the feed" from
  "feed listed no models," alongside a skipped-model count ("skipped 7 models
  with no usable context limit (image/audio)").

### D. Maintainer capture step

**✅ Shipped 2026-08-23.** `npm run models:capture` (`scripts/capture-models-fixture.ts`)
is tier 1 of the three-tier shape: it is the only step that touches the
network, is never run by a test, and its whole job is to keep the checked-in
fixture holding real upstream data while `npm run models:generate` (tier 2)
stays offline, strict, and deterministic against that fixture — the earlier
hand-authored fixture matched Models.dev's *schema* but not its *data*; a
live-feed comparison found 8 of the 12 bundled models measurably wrong
(understated context windows, an OpenAI output price off by 3×).

- Fetches `https://models.dev/api.json` by default; an argv override accepts
  either an alternate URL or a local file path, so a capture is testable and
  re-runnable fully offline against a saved copy of the feed.
- Keeps only `SUPPORTED_PROVIDERS`, dropping the other ~189 providers the live
  feed carries — the four hosted providers are ~270 KB of the 4.2 MB feed,
  which is the honest cost of a deterministic checked-in fixture.
- Drops any individual model the strict generator could not normalize (no
  positive `limit.context`, or a half-specified cost pair) by running the
  feed through `generateCatalogReport(..., { lenient: true })` and excluding
  whatever it reports as skipped — capture time is what keeps
  `models:generate` strict: the fixture is clean by construction, so
  `models:generate` never has to reject anything from it. On the feed
  captured 2026-08-23 this drops 5 OpenAI image models and 2 Groq Whisper
  models.
- **`ollama` is deliberately hand-maintained, not captured.** Models.dev
  catalogs hosted APIs; Ollama is local inference, so it has no `ollama`
  provider and never will. Capture reads today's hand-authored `ollama` block
  out of the fixture it is about to overwrite and carries it forward verbatim
  rather than retyping it, so the entry survives every future capture without
  manual upkeep.
- Sorts object keys recursively (array order is left alone — order is
  meaningful there, e.g. `reasoning_options` values) so re-running capture
  against unchanged upstream data produces a byte-identical fixture; a capture
  step that reshuffled keys on every run would make future diffs unreadable.
- Prints a per-provider summary (models kept, models dropped and why).
- **The fixture carries its own provenance.** Capture stamps a `capture: {
  source, capturedAt }` block at the fixture's top level, alongside
  `providers` (a sibling key `generateCatalog` never reads — it only ever
  looks at `root.providers`, so this is inert to normalization). `source` is
  the upstream URL, or `local:<path>` when capture was pointed at a local
  file. `scripts/generate-models.ts` reads this block back and uses it
  verbatim for the generated snapshot's `source.revision`/`source.generatedAt`
  instead of hardcoding a placeholder — the earlier hardcoded
  `fixture-2026-08-21`/`2026-08-21` was accurate only while the fixture was a
  static hand-authored file; once it became a dated upstream capture, that
  hardcoding made `heirloom models status` actively lie about how fresh the
  bundled catalog was. A fixture with no `capture` block (a legacy fixture
  predating this, or an arbitrary URL/file passed directly to
  `models:generate`) falls back to that same placeholder/wall-clock behavior
  unchanged, so neither script gains a new required input.

## 5. Explicit non-goals

- Supporting all Models.dev providers automatically.
- Silent background catalog updates.
- Treating catalog prices as invoices or reconciling them with provider bills.
- Replacing OpenRouter's live credits query.
- Automatically changing the user's selected/default model after an update.

## 6. Acceptance criteria

1. A packaged binary starts with no network and presents the bundled catalog.
2. An entry such as `openrouter/qwen/qwen3.7-flash` is available through the
   picker and `--model`, with a 1M context limit and its provider-specific
   cost estimate.
3. A user override can change only that entry's price or add a new model,
   while all generated siblings remain visible.
4. Invalid downloaded data cannot replace the current snapshot.
5. Catalog generation is deterministic from a checked-in fixture; the test
   suite has no external network dependency.
