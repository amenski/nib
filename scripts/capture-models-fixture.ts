// Maintainer-only capture step (tier 1 of 3 — see docs/model-catalog-plan.md
// §4.D). Fetches the live Models.dev feed (or reads a local capture for
// offline/testable re-runs), keeps the providers the generator would emit
// (featured ones from scripts/provider-overlay.ts plus every openai-compatible
// provider with a tool-capable model), drops any model
// the strict generator could not normalize, hand-merges the `ollama` block
// (Models.dev has no such provider — it catalogs hosted APIs, Ollama is local
// inference), and writes scripts/fixtures/models.dev.json with sorted keys so
// re-running on unchanged upstream data produces a byte-identical file.
//
// This is never run by `npm run models:generate` (offline/strict/deterministic)
// or by `nib models update` (online/lenient/user-facing) — it is the
// explicit, network-touching step a maintainer runs to refresh the checked-in
// fixture itself. Never run in tests.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { generateCatalogReport } from "../src/providers/catalog-generator.js";
import { PROVIDER_OVERLAY } from "../src/providers/provider-overlay.js";

const DEFAULT_URL = "https://models.dev/api.json";

const root = resolve(import.meta.dirname, "..");
const outputPath = resolve(root, "scripts/fixtures/models.dev.json");
const source = process.argv[2] ?? DEFAULT_URL;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

async function loadFeed(input: string): Promise<unknown> {
  if (input.startsWith("http://") || input.startsWith("https://")) {
    const response = await fetch(input);
    if (!response.ok) throw new Error(`failed to fetch ${input}: ${response.status} ${response.statusText}`);
    return response.json();
  }
  return JSON.parse(readFileSync(input, "utf8"));
}

// Sort object keys (recursively) so a re-run against unchanged upstream data
// produces a byte-identical file. Numbers are trimmed to 10 significant digits
// to drop float noise in the feed (0.7999999999 -> 0.8). Array element
// order is left untouched — order is meaningful there (e.g. reasoning_options
// values).
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (isObject(value)) {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) sorted[key] = sortKeysDeep(value[key]);
    return sorted;
  }
  return typeof value === "number" ? Number(value.toPrecision(10)) : value;
}

// The fields catalog-generator.ts reads; everything else in the feed is
// dropped so the checked-in fixture stays reviewable.
const PROVIDER_FIELDS = ["api", "env", "name", "npm"];
const MODEL_FIELDS = ["cost", "limit", "modalities", "name", "reasoning_options", "release_date", "tool_call"];

function pick(value: Record<string, unknown>, fields: string[]): Record<string, unknown> {
  return Object.fromEntries(fields.filter((f) => value[f] !== undefined).map((f) => [f, value[f]]));
}

const feed = await loadFeed(source);
const feedProviders = isObject(feed) ? (isObject(feed.providers) ? (feed.providers as Record<string, unknown>) : feed) : null;
if (!feedProviders) throw new Error(`captured input from ${source} must contain a providers object`);

// Preserve today's hand-authored ollama block verbatim, read out of the
// current checked-in fixture (not retyped) before it gets overwritten below.
const existingFixture = JSON.parse(readFileSync(outputPath, "utf8"));
const ollamaBlock = isObject(existingFixture.providers) ? existingFixture.providers.ollama : undefined;
if (!isObject(ollamaBlock)) throw new Error(`expected an existing ollama block in ${outputPath} to preserve`);

// Reuse the real generator (lenient mode) to learn which models it could not
// normalize — no positive limit.context, or a half-specified cost pair — so
// the fixture is clean by construction and `models:generate` never has to
// reject anything from it, and which providers it would emit at all (a
// provider with no tool-capable model is reported as skipped). `ollama`
// reports as skipped ("absent") since Models.dev never lists it, which
// capture handles separately below.
const report = generateCatalogReport(feed, { sourceRevision: "capture-check", generatedAt: "capture-check", lenient: true, overlay: PROVIDER_OVERLAY });
const skippedModelIds = new Set(report.skippedModels); // "provider/id"

// Stamp provenance into the fixture itself, alongside `providers` — a sibling
// key generateCatalogCore never looks at (it only reads root.providers, see
// catalog-generator.ts's `object(root?.providers) ?? root`), so this is inert
// to normalization. scripts/generate-models.ts reads it back to give the
// generated snapshot's source.revision/generatedAt honest values instead of
// a hardcoded placeholder that used to lie about the fixture's real age once
// the fixture became a dated capture instead of a static hand-authored file.
const capture = {
  source: source.startsWith("http://") || source.startsWith("https://") ? source : `local:${source}`,
  capturedAt: new Date().toISOString().slice(0, 10),
};

const kept = new Set(Object.keys(report.catalog.providers as Record<string, unknown>));
const providers: Record<string, unknown> = {};
for (const provider of ["ollama", ...kept]) {
  if (provider === "ollama") {
    providers.ollama = ollamaBlock;
    console.log("ollama: 1 model kept (hand-maintained — Models.dev has no ollama provider)");
    continue;
  }
  const providerSource = feedProviders[provider];
  if (!isObject(providerSource) || !isObject(providerSource.models)) {
    throw new Error(`captured feed from ${source} is missing provider: ${provider}`);
  }
  const models = providerSource.models as Record<string, unknown>;
  const keptModels: Record<string, unknown> = {};
  const dropped: string[] = [];
  for (const id of Object.keys(models)) {
    if (skippedModelIds.has(`${provider}/${id}`)) { dropped.push(id); continue; }
    keptModels[id] = isObject(models[id]) ? pick(models[id] as Record<string, unknown>, MODEL_FIELDS) : models[id];
  }
  providers[provider] = { ...pick(providerSource, PROVIDER_FIELDS), models: keptModels };
  if (dropped.length) console.log(`${provider}: kept ${Object.keys(keptModels).length}, dropped (no usable context limit or half-specified cost): ${dropped.join(", ")}`);
}

const skipped = report.skippedProviders.filter((p) => p.provider !== "ollama").map((p) => p.provider);
if (skipped.length) console.log(`skipped (no tool-capable model): ${skipped.join(", ")}`);
writeFileSync(outputPath, `${JSON.stringify(sortKeysDeep({ capture, providers }), null, 2)}\n`);
console.log(`wrote ${outputPath}: ${Object.keys(providers).length} providers (source: ${capture.source}, capturedAt: ${capture.capturedAt})`);
