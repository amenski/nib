import { resolve } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { generateCatalog } from "../src/providers/catalog-generator.js";

const root = resolve(import.meta.dirname, "..");
const input = process.argv[2] ?? resolve(root, "scripts/fixtures/models.dev.json");
const output = process.argv[3] ?? resolve(root, "src/providers/models.json");
const presets = JSON.parse(readFileSync(resolve(root, "src/providers/provider-presets.json"), "utf8"));
const defaultModels = Object.fromEntries(Object.entries(presets.providers).map(([name, value]) => [name, (value as { defaultModel: string }).defaultModel]));
const isFixture = input === resolve(root, "scripts/fixtures/models.dev.json");

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// scripts/capture-models-fixture.ts stamps a `capture: { source, capturedAt }`
// block into the fixture it writes, alongside `providers`. Read it back so
// the generated snapshot's source.revision/generatedAt honestly describe the
// real captured data — otherwise this would have to guess or hardcode a
// value, which is exactly what made the old fixture branch lie once the
// fixture stopped being a static hand-authored file and started being a
// dated upstream capture. Falls back to the pre-capture placeholder only for
// an input with no such block: a legacy fixture, or an arbitrary URL/local
// file passed directly to this script (never asserted idempotent, so the
// wall-clock fallback there is unchanged from before).
function provenanceOptions(parsedInput: unknown): { sourceRevision: string; generatedAt: string } {
  const capture = isObject(parsedInput) && isObject(parsedInput.capture) ? parsedInput.capture : null;
  if (typeof capture?.source === "string" && typeof capture?.capturedAt === "string") {
    return { sourceRevision: `models.dev:${capture.source}`, generatedAt: capture.capturedAt };
  }
  return isFixture
    ? { sourceRevision: "fixture-2026-08-21", generatedAt: "2026-08-21" }
    : { sourceRevision: `manual:${input}`, generatedAt: new Date().toISOString().slice(0, 10) };
}

const parsed = input.startsWith("http://") || input.startsWith("https://")
  ? await (async () => {
      const response = await fetch(input);
      if (!response.ok) throw new Error(`failed to fetch ${input}: ${response.status} ${response.statusText}`);
      return response.json();
    })()
  : JSON.parse(readFileSync(input, "utf8"));

const options = { ...provenanceOptions(parsed), defaultModels };
writeFileSync(output, `${JSON.stringify(generateCatalog(parsed, options), null, 2)}\n`);
