/**
 * Hand-owned facts layered over a feed provider at generation time. Any field
 * given wins over the feed. A `featured` provider is generated even when the
 * feed's record is not openai-compatible (or absent, like ollama), its
 * `defaultModel` must exist, and it is listed first.
 */
export interface ProviderOverlay {
  featured?: boolean;
  label?: string;
  api?: string;
  baseUrl?: string;
  keyEnv?: string;
  defaultModel?: string;
}

export interface GeneratorOptions {
  sourceRevision: string;
  generatedAt: string;
  overlay?: Record<string, ProviderOverlay>;
  /**
   * Generate exactly these providers instead of every openai-compatible feed
   * provider plus the featured ones. `nib models update` passes the active
   * snapshot's providers, so a live fetch can refresh models but never adds a
   * provider (and with it a new host a key could be sent to).
   */
  only?: string[];
  /**
   * Default false: a malformed model, a featured provider absent
   * from the input, or a featured provider whose models object is empty is fatal —
   * correct for `npm run models:generate`, which runs against a curated
   * checked-in fixture where any of those is a real bug. Set true only for
   * upstream data we don't control (`nib models update` against the
   * live Models.dev feed), where the point of lenient mode is that data we
   * don't control must never be able to hard-fail the whole update: a model
   * that fails normalization is skipped instead of aborting the whole
   * catalog, and a featured provider is skipped rather than fatal whether it
   * is absent from the feed entirely (e.g. `ollama` — local inference, never
   * hosted upstream) or present but arrives with no models (an upstream
   * glitch or a provider mid-deprecation) — both are "we got nothing usable
   * for this provider," so both are reported and carried forward rather than
   * blocking every other provider's real corrections. A present featured
   * provider whose configured default model vanished upstream stays fatal even in
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

/** https anywhere; plain http only to this machine (e.g. LM Studio). */
export function isAllowedBaseUrl(raw: string): boolean {
  let url: URL;
  try { url = new URL(raw); } catch { return false; }
  if (url.protocol === "https:") return true;
  return isLocalHttp(url);
}

function isLocalHttp(url: URL): boolean {
  return url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
}

/** `my-llm` → `MY_LLM_API_KEY`: the key variable for a provider without one. */
export function defaultKeyEnv(name: string): string {
  return `${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;
}

/** A feed provider nib can drive without an overlay: openai-compatible at an allowed URL. */
function isOpenAICompatible(entry: Record<string, unknown> | null): boolean {
  return entry?.npm === "@ai-sdk/openai-compatible" && typeof entry.api === "string" && isAllowedBaseUrl(entry.api);
}

/** The tool-capable model with the newest `release_date`; ties go to the lowest id. */
function newestToolModel(models: Record<string, Record<string, unknown>>, raw: Record<string, unknown>): string | undefined {
  let best: { id: string; date: string } | undefined;
  for (const id of Object.keys(models).sort()) {
    if (models[id].supportsTools !== true) continue;
    const date = typeof object(raw[id])?.release_date === "string" ? String(object(raw[id])!.release_date) : "";
    if (!best || date > best.date) best = { id, date };
  }
  return best?.id;
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
    if (input !== undefined && output !== undefined) result.pricing = { inputPerM: Number(input.toPrecision(10)), outputPerM: Number(output.toPrecision(10)) };
  }
  const efforts = effortValues(model.reasoning_options);
  if (efforts.length) {
    result.effort = { values: efforts, default: efforts.includes("medium") ? "medium" : efforts.includes("high") ? "high" : efforts[0] };
  }
  return result;
}

/**
 * A provider lenient mode dropped rather than treating as fatal. `reason`
 * distinguishes the two ways a provider can come back with nothing usable —
 * the feed simply doesn't list it ("absent") vs. it's listed but has no
 * usable models ("empty", e.g. an upstream glitch or a provider
 * mid-deprecation) — so the caller can report which happened instead of
 * collapsing both into one unexplained line.
 */
export interface SkippedProvider {
  provider: string;
  reason: "absent" | "empty";
}

export interface GenerateCatalogReport {
  catalog: Record<string, unknown>;
  /** "provider/id" for each model that failed normalization and was dropped (lenient mode only). */
  skippedModels: string[];
  /** Providers dropped rather than fatal (lenient mode only). */
  skippedProviders: SkippedProvider[];
}

/**
 * Featured providers first (overlay order), then every other candidate
 * sorted. Candidates are `only` when given, else the featured overlay entries
 * plus every openai-compatible feed provider.
 */
function candidateProviders(source: Record<string, unknown>, options: GeneratorOptions): string[] {
  const overlay = options.overlay ?? {};
  const featured = Object.keys(overlay).filter((id) => overlay[id].featured);
  const pool = options.only ?? [...featured, ...Object.keys(source).filter((id) => isOpenAICompatible(object(source[id])))];
  const rest = [...new Set(pool)].filter((id) => !featured.includes(id)).sort();
  return [...featured.filter((id) => pool.includes(id)), ...rest];
}

/**
 * Shared core for generateCatalog and generateCatalogReport — one
 * implementation so strict and lenient behavior can't drift apart. With
 * `options.lenient` false (the default) any of the throws below aborts the
 * whole catalog.
 */
function generateCatalogCore(input: unknown, options: GeneratorOptions): GenerateCatalogReport {
  const lenient = options.lenient === true;
  const root = object(input);
  const sourceProviders = object(root?.providers) ?? root;
  if (!sourceProviders) throw new Error("Models.dev input must contain a providers object");
  const providers: Record<string, unknown> = {};
  const skippedModels: string[] = [];
  const skippedProviders: SkippedProvider[] = [];
  for (const provider of candidateProviders(sourceProviders, options)) {
    const overlay = options.overlay?.[provider] ?? {};
    const featured = overlay.featured === true;
    const source = object(sourceProviders[provider]);
    if (!source) {
      if (lenient || !featured) { skippedProviders.push({ provider, reason: "absent" }); continue; }
      throw new Error(`missing featured provider: ${provider}`);
    }
    const sourceModels = object(source.models) ?? {};
    const models: Record<string, Record<string, unknown>> = {};
    for (const id of Object.keys(sourceModels).sort()) {
      if (!lenient) { models[id] = normalizeModel(provider, id, sourceModels[id]); continue; }
      try { models[id] = normalizeModel(provider, id, sourceModels[id]); }
      catch { skippedModels.push(`${provider}/${id}`); }
    }
    // nib always sends tools, so a provider with no tool-capable model is
    // unusable. A featured provider is exempt (ollama's hand-kept model has
    // no tool flag) but must still have models.
    const usable = featured ? Object.keys(models).length > 0 : newestToolModel(models, sourceModels) !== undefined;
    if (!usable) {
      // Same category as "absent" on the lenient path: upstream gave us
      // nothing usable for this provider (a bad deploy, mid-deprecation).
      // For a featured provider in the checked-in fixture it IS a real bug.
      if (lenient || !featured) { skippedProviders.push({ provider, reason: "empty" }); continue; }
      throw new Error(`${provider} must contain models`);
    }
    // Fatal in both modes: a featured provider whose configured default model
    // vanished (or never normalized) is a real problem the user must see, not
    // something lenient mode should absorb. Any other provider keeps its
    // preferred default while it exists, else falls back to its newest model.
    let defaultModel = overlay.defaultModel;
    if (defaultModel && !models[defaultModel]) {
      if (featured) throw new Error(`${provider} default model is missing: ${defaultModel}`);
      defaultModel = undefined;
    }
    defaultModel ??= newestToolModel(models, sourceModels)!;
    const baseUrl = (overlay.baseUrl ?? (typeof source.api === "string" ? source.api : "")).replace(/\/+$/, "");
    if (!isAllowedBaseUrl(baseUrl)) throw new Error(`${provider} has no allowed base URL: ${baseUrl || "(none)"}`);
    const env = Array.isArray(source.env) && typeof source.env[0] === "string" ? source.env[0] : defaultKeyEnv(provider);
    providers[provider] = {
      label: overlay.label ?? (typeof source.name === "string" && source.name.trim() ? source.name : provider),
      api: overlay.api ?? "openai-compatible",
      baseUrl,
      // A local server (LM Studio and friends) takes no key.
      keyEnv: overlay.keyEnv ?? (isLocalHttp(new URL(baseUrl)) ? "" : env),
      defaultModel,
      ...(featured ? { featured: true } : {}),
      models,
    };
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
 * and the providers that came back absent or empty (e.g. `ollama`)
 * so it can carry those providers forward from the active snapshot instead
 * of treating them as removed.
 */
export function generateCatalogReport(input: unknown, options: GeneratorOptions): GenerateCatalogReport {
  return generateCatalogCore(input, options);
}
