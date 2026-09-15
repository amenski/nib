export const SUPPORTED_PROVIDERS = ["deepseek", "openai", "openrouter", "groq", "ollama"] as const;
export type SupportedProvider = (typeof SUPPORTED_PROVIDERS)[number];

export interface GeneratorOptions {
  sourceRevision: string;
  generatedAt: string;
  defaultModels?: Partial<Record<SupportedProvider, string>>;
  /**
   * Default false: a malformed model, a SUPPORTED_PROVIDERS entry absent
   * from the input, or a provider whose models object is empty is fatal —
   * correct for `npm run models:generate`, which runs against a curated
   * checked-in fixture where any of those is a real bug. Set true only for
   * upstream data we don't control (`nib models update` against the
   * live Models.dev feed), where the point of lenient mode is that data we
   * don't control must never be able to hard-fail the whole update: a model
   * that fails normalization is skipped instead of aborting the whole
   * catalog, and a required provider is skipped rather than fatal whether it
   * is absent from the feed entirely (e.g. `ollama` — local inference, never
   * hosted upstream) or present but arrives with no models (an upstream
   * glitch or a provider mid-deprecation) — both are "we got nothing usable
   * for this provider," so both are reported and carried forward rather than
   * blocking every other provider's real corrections. A present provider
   * whose configured default model vanished upstream stays fatal even in
   * lenient mode — see generateCatalogReport.
   */
  lenient?: boolean;
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

/**
 * Derive the `vision` capability flag from Models.dev's `modalities.input`
 * array. `true` when the source declares image input, `false` when it declares
 * a non-image input set (text-only, or audio/pdf-only — still not "sees
 * images"), and `undefined` when the source carries no modality data (the
 * hand-maintained `ollama` block, or a user override that omitted it). Absent
 * is deliberately distinct from false: it means "unknown, don't warn either
 * way", while false is an explicit text-only declaration.
 */
function visionFromModalities(raw: unknown): boolean | undefined {
  const modalities = object(raw);
  const input = modalities?.input;
  if (!Array.isArray(input)) return undefined;
  return input.includes("image");
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
  const vision = visionFromModalities(model.modalities);
  if (vision !== undefined) result.vision = vision;
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

/**
 * A SUPPORTED_PROVIDERS entry lenient mode dropped rather than treating as
 * fatal. `reason` distinguishes the two ways a provider can come back with
 * nothing usable — the feed simply doesn't list it ("absent") vs. it's
 * listed but its models object is empty ("empty", e.g. an upstream glitch or
 * a provider mid-deprecation) — so the caller can report which happened
 * instead of collapsing both into one unexplained line.
 */
export interface SkippedProvider {
  provider: SupportedProvider;
  reason: "absent" | "empty";
}

export interface GenerateCatalogReport {
  catalog: Record<string, unknown>;
  /** "provider/id" for each model that failed normalization and was dropped (lenient mode only). */
  skippedModels: string[];
  /** SUPPORTED_PROVIDERS entries dropped rather than fatal (lenient mode only). */
  skippedProviders: SkippedProvider[];
}

/**
 * Shared core for generateCatalog and generateCatalogReport — one
 * implementation so strict and lenient behavior can't drift apart. With
 * `options.lenient` false (the default) this is exactly the original
 * behavior: any of the throws below aborts the whole catalog.
 */
function generateCatalogCore(input: unknown, options: GeneratorOptions): GenerateCatalogReport {
  const lenient = options.lenient === true;
  const root = object(input);
  const sourceProviders = object(root?.providers) ?? root;
  if (!sourceProviders) throw new Error("Models.dev input must contain a providers object");
  const providers: Record<string, unknown> = {};
  const skippedModels: string[] = [];
  const skippedProviders: SkippedProvider[] = [];
  for (const provider of [...SUPPORTED_PROVIDERS].sort()) {
    const source = object(sourceProviders[provider]);
    if (!source) {
      if (lenient) { skippedProviders.push({ provider, reason: "absent" }); continue; }
      throw new Error(`missing supported provider: ${provider}`);
    }
    const sourceModels = object(source.models);
    if (!sourceModels || !Object.keys(sourceModels).length) {
      // Same category as "absent" on the lenient path: upstream gave us
      // nothing usable for this provider (a bad deploy, mid-deprecation),
      // not a Nib bug — the checked-in fixture failing this check IS a
      // real bug, so it stays fatal there.
      if (lenient) { skippedProviders.push({ provider, reason: "empty" }); continue; }
      throw new Error(`${provider} must contain models`);
    }
    const models: Record<string, unknown> = {};
    for (const id of Object.keys(sourceModels).sort()) {
      if (!lenient) { models[id] = normalizeModel(provider, id, sourceModels[id]); continue; }
      try { models[id] = normalizeModel(provider, id, sourceModels[id]); }
      catch { skippedModels.push(`${provider}/${id}`); }
    }
    // Fatal in both modes: a provider actually present in the feed whose
    // configured default model vanished (or never normalized) is a real
    // problem the user must see, not something lenient mode should absorb.
    const defaultModel = options.defaultModels?.[provider];
    if (defaultModel && !models[defaultModel]) throw new Error(`${provider} default model is missing: ${defaultModel}`);
    providers[provider] = { models };
  }
  return {
    catalog: { source: { provider: "models.dev", revision: options.sourceRevision, generatedAt: options.generatedAt }, providers },
    skippedModels,
    skippedProviders,
  };
}

export function generateCatalog(input: unknown, options: GeneratorOptions): Record<string, unknown> {
  return generateCatalogCore(input, options).catalog;
}

/**
 * Same normalization as generateCatalog, plus what lenient mode skipped —
 * `nib models update` needs the counts to report a skipped-models line
 * and the list of SUPPORTED_PROVIDERS that came back empty (e.g. `ollama`)
 * so it can carry those providers forward from the active snapshot instead
 * of treating them as removed.
 */
export function generateCatalogReport(input: unknown, options: GeneratorOptions): GenerateCatalogReport {
  return generateCatalogCore(input, options);
}
