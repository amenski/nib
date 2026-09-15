import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Single source of truth for the CLI's own package metadata. The `..` hop
// resolves to the package root both in dev (tsx runs this from src/, so
// dirname is src/) and in the tsup bundle (everything is inlined into
// dist/cli.js, so dirname is dist/) — the same trick src/cli.tsx used for its
// inline pkg read.
export const pkg = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf-8"),
) as { name: string; version: string };
