// Copies the bundled model catalog into the dist bundle so the packaged
// binary can load it. tsup bundles JS/TS only; models.json is an asset the
// catalog loader resolves relative to its module URL (./models.json). In dev
// that URL is src/providers/catalog.ts, so it finds src/providers/models.json;
// in the bundle the module URL is dist/cli.js, so it looks for
// dist/models.json. This mirrors the source file into dist/.
import { cp } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "src", "providers", "models.json");
const dest = join(root, "dist", "models.json");

await cp(src, dest);
