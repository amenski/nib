import { createInterface } from "node:readline/promises";
import { existsSync } from "node:fs";
import { BUILTIN_PRESETS } from "../providers/presets.js";
import { readHiddenLine } from "./hidden-input.js";
import { credsDir, credsFile, readCredentialsFile } from "../config/credentials.js";
import { ensurePrivateDirectoryAsync, writePrivateFile } from "../config/state-permissions.js";

const WIZARD_PRESETS: { name: string; keyEnv: string }[] = [
  { name: "deepseek",   keyEnv: "DEEPSEEK_API_KEY" },
  { name: "openai",     keyEnv: "OPENAI_API_KEY" },
  { name: "openrouter", keyEnv: "OPENROUTER_API_KEY" },
  { name: "groq",       keyEnv: "GROQ_API_KEY" },
  { name: "ollama",     keyEnv: "" },
  { name: "anthropic",  keyEnv: "ANTHROPIC_API_KEY" },
  { name: "together",   keyEnv: "TOGETHER_API_KEY" },
];

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

export async function authWizard(): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  console.log("Available presets:");
  WIZARD_PRESETS.forEach((p, i) => console.log(`  ${i + 1}. ${p.name}`));
  console.log(`  ${WIZARD_PRESETS.length + 1}. custom`);

  let name: string;
  const choice = await rl.question("\nSelect a preset (1-8): ");
  const idx = parseInt(choice, 10);

  if (idx >= 1 && idx <= WIZARD_PRESETS.length) {
    name = WIZARD_PRESETS[idx - 1].name;
  } else if (idx === WIZARD_PRESETS.length + 1) {
    name = await rl.question("Provider name (e.g. my-llm): ");
    name = name.trim();
    if (!name) {
      console.log("Name cannot be empty.");
      rl.close();
      return;
    }
  } else {
    console.log("Invalid selection.");
    rl.close();
    return;
  }

  // Close the readline interface before switching stdin into raw mode for the
  // masked key prompt — the two cannot both own stdin at once.
  rl.close();

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

  await authSaveKey(name, trimmedKey);
}

export async function authList(): Promise<void> {
  const creds = readCredentialsFile();

  const allPresets = new Map<string, string>();
  for (const p of WIZARD_PRESETS) {
    allPresets.set(p.name, p.keyEnv);
  }

  for (const name of Object.keys(creds)) {
    if (!allPresets.has(name)) allPresets.set(name, "");
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
