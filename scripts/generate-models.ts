import { resolve } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { generateCatalog, generateCatalogFile } from "../src/providers/catalog-generator.js";

const root = resolve(import.meta.dirname, "..");
const input = process.argv[2] ?? resolve(root, "scripts/fixtures/models.dev.json");
const output = process.argv[3] ?? resolve(root, "src/providers/models.json");
const presets = JSON.parse(readFileSync(resolve(root, "src/providers/provider-presets.json"), "utf8"));
const defaultModels = Object.fromEntries(Object.entries(presets.providers).map(([name, value]) => [name, (value as { defaultModel: string }).defaultModel]));
const isFixture = input === resolve(root, "scripts/fixtures/models.dev.json");
const options = isFixture
  ? { sourceRevision: "fixture-2026-08-21", generatedAt: "2026-08-21", defaultModels }
  : { sourceRevision: `manual:${input}`, generatedAt: new Date().toISOString().slice(0, 10), defaultModels };
if (input.startsWith("http://") || input.startsWith("https://")) {
  const response = await fetch(input);
  if (!response.ok) throw new Error(`failed to fetch ${input}: ${response.status} ${response.statusText}`);
  writeFileSync(output, `${JSON.stringify(generateCatalog(await response.json(), options), null, 2)}\n`);
} else {
  generateCatalogFile(input, output, options);
}
