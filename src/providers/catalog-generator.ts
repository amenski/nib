import { readFileSync, writeFileSync } from "node:fs";

export const SUPPORTED_PROVIDERS = ["deepseek", "openai", "openrouter", "groq", "ollama"] as const;
type SupportedProvider = (typeof SUPPORTED_PROVIDERS)[number];

export interface GeneratorOptions {
  sourceRevision: string;
  generatedAt: string;
  defaultModels?: Partial<Record<SupportedProvider, string>>;
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function positive(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new Error(`${label} must be a positive number`);
  return value;
}

function nonNegative(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`${label} must be a non-negative number`);
  return value;
}

function effortValues(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const values: string[] = [];
  for (const option of raw) {
    if (typeof option === "string") {
      values.push(option);
      continue;
    }
    const entry = object(option);
    if (entry?.type === "effort" && Array.isArray(entry.values)) {
      values.push(...entry.values.filter((value): value is string => typeof value === "string"));
    }
  }
  return [...new Set(values)].sort();
}

function normalizeModel(provider: string, id: string, raw: unknown): Record<string, unknown> {
  const model = object(raw);
  if (!model) throw new Error(`${provider}/${id} must be an object`);
  const limit = object(model.limit);
  const contextWindow = positive(limit?.context, `${provider}/${id}.limit.context`);
  const result: Record<string, unknown> = {
    displayName: typeof model.name === "string" && model.name.trim() ? model.name : id,
    supportsTools: model.tool_call === true,
    contextWindow,
  };
  const cost = object(model.cost);
  if (cost) {
    const input = cost.input === undefined ? undefined : nonNegative(cost.input, `${provider}/${id}.cost.input`);
    const output = cost.output === undefined ? undefined : nonNegative(cost.output, `${provider}/${id}.cost.output`);
    if ((input === undefined) !== (output === undefined)) throw new Error(`${provider}/${id} must include both cost.input and cost.output`);
    if (input !== undefined && output !== undefined) result.pricing = { inputPerM: input, outputPerM: output };
  }
  const efforts = effortValues(model.reasoning_options);
  if (efforts.length) {
    result.effort = { values: efforts, default: efforts.includes("medium") ? "medium" : efforts.includes("high") ? "high" : efforts[0] };
  }
  return result;
}

export function generateCatalog(input: unknown, options: GeneratorOptions): Record<string, unknown> {
  const root = object(input);
  const sourceProviders = object(root?.providers) ?? root;
  if (!sourceProviders) throw new Error("Models.dev input must contain a providers object");
  const providers: Record<string, unknown> = {};
  for (const provider of [...SUPPORTED_PROVIDERS].sort()) {
    const source = object(sourceProviders[provider]);
    if (!source) throw new Error(`missing supported provider: ${provider}`);
    const sourceModels = object(source.models);
    if (!sourceModels || !Object.keys(sourceModels).length) throw new Error(`${provider} must contain models`);
    const models: Record<string, unknown> = {};
    for (const id of Object.keys(sourceModels).sort()) models[id] = normalizeModel(provider, id, sourceModels[id]);
    const defaultModel = options.defaultModels?.[provider];
    if (defaultModel && !models[defaultModel]) throw new Error(`${provider} default model is missing: ${defaultModel}`);
    providers[provider] = { models };
  }
  return { source: { provider: "models.dev", revision: options.sourceRevision, generatedAt: options.generatedAt }, providers };
}

export function generateCatalogFile(inputPath: string, outputPath: string, options: GeneratorOptions): void {
  const input = JSON.parse(readFileSync(inputPath, "utf8"));
  writeFileSync(outputPath, `${JSON.stringify(generateCatalog(input, options), null, 2)}\n`);
}
