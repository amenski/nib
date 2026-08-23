import { createInterface } from "node:readline/promises";
import { loadProviderPresets } from "./catalog.js";
import { generateCatalogReport, type GeneratorOptions } from "./catalog-generator.js";
import {
  DEFAULT_MODELS_DEV_URL,
  fetchModelsDevFeed,
  diffCatalogs,
  formatDiff,
  isDiffEmpty,
  readActiveSnapshot,
  writeCachedSnapshot,
  type GeneratedSnapshot,
} from "./catalog-update.js";

/**
 * Test seams: real network/TTY/clock swapped for injected fakes, same
 * fetchImpl-injection pattern as update-check.ts and probeSearXngHealth
 * (cli.tsx) — no test may touch the network or a real TTY.
 */
export interface ModelsCommandDeps {
  fetchImpl?: typeof fetch;
  homeDir?: string;
  now?: Date;
  isTTY?: boolean;
  confirm?: (question: string) => Promise<boolean>;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function usage(): void {
  console.error("Usage: heirloom models <update|status>");
  console.error("  heirloom models update [--url <url>] [--yes]");
  console.error("  heirloom models status");
}

export async function runModels(argv: string[], deps: ModelsCommandDeps = {}): Promise<number> {
  const sub = argv[0];
  if (sub === "update") return runUpdate(argv.slice(1), deps);
  if (sub === "status") return runStatus(argv.slice(1), deps);
  usage();
  return 1;
}

// Mirrors scripts/generate-models.ts's defaultModels construction exactly,
// reading through catalog.ts's loadProviderPresets() (see D2 in the slice
// brief) instead of re-deriving PRESETS_PATH here.
function buildDefaultModels(): GeneratorOptions["defaultModels"] {
  const presets = loadProviderPresets();
  const presetProviders = isObject(presets.providers) ? (presets.providers as Record<string, unknown>) : {};
  const defaultModels: Record<string, string> = {};
  for (const [name, value] of Object.entries(presetProviders)) {
    const defaultModel = isObject(value) ? value.defaultModel : undefined;
    if (typeof defaultModel === "string") defaultModels[name] = defaultModel;
  }
  return defaultModels;
}

async function runUpdate(args: string[], deps: ModelsCommandDeps): Promise<number> {
  let url = DEFAULT_MODELS_DEV_URL;
  let yes = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--url") {
      const value = args[++i];
      if (!value) { console.error("--url requires a value"); usage(); return 1; }
      url = value;
    }
    else if (a.startsWith("--url=")) {
      const value = a.slice("--url=".length);
      if (!value) { console.error("--url requires a value"); usage(); return 1; }
      url = value;
    }
    else if (a === "--yes") { yes = true; }
    else { console.error(`Unknown argument: ${a}`); usage(); return 1; }
  }

  let feed: unknown;
  try {
    feed = await fetchModelsDevFeed({ url, fetchImpl: deps.fetchImpl });
  } catch (err) {
    console.error(`error: ${(err as Error).message}`);
    return 1;
  }

  // Validation = reuse generateCatalog's core (D2), in lenient mode: it still
  // throws on non-object root or a present provider missing its configured
  // default (AC4 — invalid data can't replace the snapshot), but tolerates
  // upstream data strict mode would reject outright — individual models with
  // no usable context limit (the live feed's image/audio entries), and a
  // SUPPORTED_PROVIDERS entry that comes back with nothing usable whether
  // the feed doesn't list it at all (`ollama`, local inference, never hosted
  // upstream) or lists it with an empty models object (upstream glitch or a
  // provider mid-deprecation) — one bad provider must not block every other
  // provider's real corrections. Strict mode stays the default for npm run
  // models:generate — see catalog-generator.ts.
  const now = deps.now ?? new Date();
  const day = now.toISOString().slice(0, 10);
  let report: ReturnType<typeof generateCatalogReport>;
  try {
    report = generateCatalogReport(feed, {
      sourceRevision: `models.dev:${day}`,
      generatedAt: day,
      defaultModels: buildDefaultModels(),
      lenient: true,
    });
  } catch (err) {
    console.error(`error: invalid catalog data from ${url}: ${(err as Error).message}`);
    return 1;
  }

  const { snapshot: active } = readActiveSnapshot(deps.homeDir);

  // Carry forward each provider lenient mode skipped — feed doesn't list it,
  // or lists it with nothing usable — from the active snapshot BEFORE
  // diffing/writing, so it keeps its bundled entry instead of showing up as
  // a spurious removal in every single diff.
  const updated = report.catalog as { providers: Record<string, unknown> };
  for (const { provider } of report.skippedProviders) {
    const carried = active.providers?.[provider];
    if (carried) updated.providers[provider] = carried;
  }

  const diff = diffCatalogs(active, report.catalog as GeneratedSnapshot);
  console.log(formatDiff(diff));
  if (report.skippedModels.length > 0) {
    console.log(`skipped ${report.skippedModels.length} models with no usable context limit (image/audio)`);
  }
  if (report.skippedProviders.length > 0) {
    // Not refreshed is not silent: name which providers kept their bundled
    // entry, and distinguish why (the feed didn't list it at all vs. listed
    // it with nothing usable) since that costs nothing once generateCatalogReport
    // already knows the reason.
    const absent = report.skippedProviders.filter((p) => p.reason === "absent").map((p) => p.provider);
    const empty = report.skippedProviders.filter((p) => p.reason === "empty").map((p) => p.provider);
    if (absent.length) console.log(`not refreshed — absent from the feed: ${absent.join(", ")}`);
    if (empty.length) console.log(`not refreshed — feed listed no models: ${empty.join(", ")}`);
  }
  if (isDiffEmpty(diff)) return 0;

  const confirmed = await confirmUpdate(yes, deps);
  if (confirmed === null) {
    console.error("refusing to update without confirmation: not a TTY and --yes was not given");
    return 1;
  }
  if (!confirmed) {
    console.log("update declined; catalog unchanged");
    return 0;
  }

  writeCachedSnapshot(updated, deps.homeDir);
  console.log("catalog updated");
  return 0;
}

// Returns true/false for an explicit answer, or null to signal "refuse
// outright" — not a TTY and no --yes is a hard failure (D5: never write
// unprompted), distinct from a human declining the prompt (exit 0).
async function confirmUpdate(yes: boolean, deps: ModelsCommandDeps): Promise<boolean | null> {
  if (yes) return true;
  const isTTY = deps.isTTY ?? !!process.stdin.isTTY;
  if (!isTTY) return null;
  if (deps.confirm) return deps.confirm("Apply this update? (y/N) ");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question("Apply this update? (y/N) ");
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

function runStatus(args: string[], deps: ModelsCommandDeps): number {
  if (args.length > 0) {
    console.error(`Unknown argument: ${args[0]}`);
    usage();
    return 1;
  }
  const { origin, snapshot } = readActiveSnapshot(deps.homeDir);
  const providers = snapshot.providers ?? {};
  const providerCount = Object.keys(providers).length;
  const modelCount = Object.values(providers).reduce((sum, p) => sum + Object.keys(p.models ?? {}).length, 0);
  console.log(`snapshot: ${origin === "cached" ? "updated (cached)" : "bundled"}`);
  console.log(`source revision: ${snapshot.source?.revision ?? "unknown"}`);
  console.log(`generated at: ${snapshot.source?.generatedAt ?? "unknown"}`);
  console.log(`providers: ${providerCount}`);
  console.log(`models: ${modelCount}`);
  return 0;
}
