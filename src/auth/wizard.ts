import { createInterface } from "node:readline/promises";
import { existsSync } from "node:fs";
import { BUILTIN_PRESETS } from "../providers/presets.js";
import {
  defaultKeyEnv, featuredProviderNames, loadModelCatalog, saveUserDefaultModel, saveUserProvider, UNKNOWN_MODEL_CAPS,
  type CatalogModel, type CatalogProvider, type ModelCatalog, type UserProviderEntry,
} from "../providers/catalog.js";
import type { SearchPickerItem } from "../ui/views/SearchPicker.js";
import { pickFromList } from "./pick.js";
import { readBundledSnapshot } from "../providers/catalog-update.js";
import { readHiddenLine } from "./hidden-input.js";
import { credsDir, credsFile, readCredentialsFile } from "../config/credentials.js";
import { ensurePrivateDirectoryAsync, writePrivateFile } from "../config/state-permissions.js";

export interface CredentialEntry {
  key: string;
  source: "env" | "credentials" | "none";
}

async function writeCredentials(creds: Record<string, string>): Promise<void> {
  const dir = credsDir();
  await ensurePrivateDirectoryAsync(dir);

  const lines = Object.entries(creds).map(([k, v]) => `${k}: ${v}`);
  await writePrivateFile(credsFile(), lines.join("\n") + "\n");
}

/**
 * Persist a single provider's key to ~/.nib/credentials.yaml (0600),
 * preserving any existing entries. Shared by the interactive wizard, the
 * non-interactive (`--api-key` / piped-stdin) paths, and the in-picker
 * "Connect provider" flow.
 *
 * `silent` suppresses the success console.log — needed when calling this from
 * inside the Ink TUI, where an unexpected console.log would corrupt the
 * current frame instead of appearing in a real terminal scrollback.
 */
export async function authSaveKey(name: string, key: string, silent = false): Promise<void> {
  const existing = readCredentialsFile();
  existing[name] = key;
  await writeCredentials(existing);

  if (silent) return;
  console.log(`API key for ${name} saved to ${credsFile()}`);
  console.log("Run `nib` to start.");
}

/** `"a, b c"` → `["a", "b", "c"]`: model ids typed by hand, deduplicated, order kept. */
export function parseModelIds(raw: string): string[] {
  return [...new Set(raw.split(/[\s,]+/).filter(Boolean))];
}

/** Picker id for the "custom URL" row; never a provider id (those are kebab-case). */
const CUSTOM_ID = ":custom";

/**
 * The `nib auth` provider list: featured providers first, then every other
 * catalog provider by id, then a pinned "Custom URL…" row. One flat,
 * searchable list.
 */
export function providerPickerItems(catalog: ModelCatalog): SearchPickerItem[] {
  const featured = featuredProviderNames(catalog);
  const items: SearchPickerItem[] = featured.map((id) => ({
    id, label: catalog.providers[id].label ?? id, detail: "built-in",
  }));
  for (const id of Object.keys(catalog.providers).filter((id) => !featured.includes(id)).sort()) {
    const p = catalog.providers[id];
    let host = p.baseUrl;
    try { host = new URL(p.baseUrl).host; } catch { /* keep the raw URL */ }
    items.push({ id, label: p.label ?? id, detail: `${id} · ${host}` });
  }
  items.push({ id: CUSTOM_ID, label: "Custom URL…", detail: "any OpenAI-compatible endpoint", pinned: true });
  return items;
}

/** Ask for model ids by hand; they get UNKNOWN_MODEL_CAPS and the first is the default. null = none given. */
async function askModelIds(): Promise<{ models: Record<string, CatalogModel>; defaultModel: string } | null> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const typed = parseModelIds(await rl.question("Model ids (comma-separated, first is the default): "));
  rl.close();
  if (typed.length === 0) {
    console.log("Enter at least one model id.");
    return null;
  }
  return { models: Object.fromEntries(typed.map((id) => [id, { ...UNKNOWN_MODEL_CAPS }])), defaultModel: typed[0] };
}

/**
 * A catalog provider: pick its default model from the models nib already
 * knows (tool-capable ones, unless it has none — like ollama), starting on
 * the current default. null = cancelled.
 */
async function pickDefaultModel(provider: CatalogProvider): Promise<string | null> {
  const all = Object.keys(provider.models);
  const tools = all.filter((id) => provider.models[id].supportsTools);
  const ids = tools.length > 0 ? tools : all;
  if (ids.length <= 1) return ids[0] ?? provider.defaultModel;
  return pickFromList(
    `Default model for ${provider.label ?? "provider"}`,
    ids.map((id) => ({ id, label: id, detail: `${Math.round(provider.models[id].contextWindow / 1000)}k context` })),
    ids.includes(provider.defaultModel) ? provider.defaultModel : undefined,
  );
}

/** "Custom URL…": name, OpenAI-compatible base URL, model ids. */
async function setupCustomProvider(): Promise<{ name: string; entry: UserProviderEntry } | null> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const name = (await rl.question("Provider name (e.g. my-llm): ")).trim();
  const bundled = readBundledSnapshot().providers ?? {};
  const rawUrl = name && !bundled[name]
    ? (await rl.question("Base URL (OpenAI-compatible, e.g. https://host/v1): ")).trim()
    : "";
  rl.close();
  if (!name) {
    console.log("Name cannot be empty.");
    return null;
  }
  if (bundled[name]) {
    console.log(`"${name}" is already in the provider list — pick it there.`);
    return null;
  }
  let url: URL | undefined;
  try { url = new URL(rawUrl); } catch { /* reported below */ }
  if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) {
    console.log("Base URL must be an http(s) URL.");
    return null;
  }
  const chosen = await askModelIds();
  if (!chosen) return null;
  return {
    name,
    entry: { label: name, baseUrl: rawUrl.replace(/\/+$/, ""), keyEnv: defaultKeyEnv(name), ...chosen },
  };
}

export async function authWizard(): Promise<void> {
  if (!process.stdin.isTTY) {
    console.log("`nib auth` needs a terminal. Use `nib auth <provider> --api-key <key>` instead.");
    return;
  }
  const catalog = loadModelCatalog();

  const picked = await pickFromList("Connect a provider", providerPickerItems(catalog));
  if (picked === null) {
    console.log("Cancelled. No credentials saved.");
    return;
  }

  let name = picked;
  // Exactly one is set: a Custom URL provider's full entry, or the default
  // model chosen for a catalog provider.
  let registration: UserProviderEntry | undefined;
  let defaultModel: string | undefined;
  if (picked === CUSTOM_ID) {
    const custom = await setupCustomProvider();
    if (!custom) return;
    name = custom.name;
    registration = custom.entry;
  } else {
    const chosen = await pickDefaultModel(catalog.providers[picked]);
    if (chosen === null) {
      console.log("Cancelled. No credentials saved.");
      return;
    }
    defaultModel = chosen;
  }

  const key = await readHiddenLine(`Paste your API key for ${name}: `);
  if (key === null) {
    console.log("Cancelled. No credentials saved.");
    return;
  }
  const trimmedKey = key.trim();
  if (!trimmedKey) {
    console.log("API key cannot be empty.");
    return;
  }

  // Write models.json before the key, so a models.json we refuse to
  // overwrite leaves nothing half-saved. A catalog provider only records a
  // default that differs from the bundled one (clearing a stale override
  // otherwise) — its connection and models stay in the bundled catalog.
  let catalogPath: string | undefined;
  try {
    if (registration) catalogPath = await saveUserProvider(name, registration);
    else {
      const bundledDefault = readBundledSnapshot().providers?.[name]?.defaultModel;
      await saveUserDefaultModel(name, defaultModel === bundledDefault ? undefined : defaultModel);
    }
  } catch (err) {
    console.log((err as Error).message);
    return;
  }

  await authSaveKey(name, trimmedKey);
  if (registration && catalogPath) console.log(`Provider ${name} added to ${catalogPath}`);
  console.log(`Use it with: nib --model ${name}/${registration?.defaultModel ?? defaultModel}`);
}

export async function authList(): Promise<void> {
  const creds = readCredentialsFile();

  const allPresets = new Map<string, string>();
  for (const name of [...featuredProviderNames(), ...Object.keys(creds)]) {
    if (!allPresets.has(name)) allPresets.set(name, BUILTIN_PRESETS[name]?.keyEnv ?? "");
  }

  if (allPresets.size === 0) {
    console.log("No providers configured.");
    return;
  }

  for (const [name, keyEnv] of allPresets) {
    const envSet = keyEnv && process.env[keyEnv];
    const hasCreds = name in creds;
    let source = "none";
    if (envSet) source = "env";
    else if (hasCreds) source = "credentials";
    console.log(`  ${name.padEnd(15)} ${source}`);
  }
}

export async function authLogout(name: string): Promise<void> {
  if (!existsSync(credsFile())) {
    console.log(`No credentials file found at ${credsFile()}. Nothing to remove.`);
    return;
  }

  const creds = readCredentialsFile();
  if (!(name in creds)) {
    console.log(`No credentials saved for "${name}".`);
    return;
  }

  delete creds[name];
  await writeCredentials(creds);
  console.log(`Removed credentials for "${name}".`);
}
