import type { Message } from "../types.js";
import type { ModelCapabilities, Provider } from "./types.js";
import { createProvider, getConfiguredProviders, getPreset, getProviderModels } from "./presets.js";
import { STAGE2_TIMEOUT_MS, type RiskJudge, type Stage2Options } from "../permissions/risk/model.js";

/**
 * Builds the risk classifier's model stage (docs/command-risk-classifier.md §6)
 * out of nib's provider catalog.
 *
 * This lives in `providers/` rather than in `permissions/risk/` on purpose: the
 * classifier takes a {@link RiskJudge} callback and knows nothing about
 * providers, models or keys, so it stays a pure, deterministic module that a
 * test can drive with a one-line stub. Everything that needs to know how nib
 * talks to a model is here.
 */

/**
 * Model ids that name a small, cheap member of a family, by convention rather
 * than by price. §6.1 asks for the cheapest available, but the catalog's
 * `pricing` field is documented as approximate and as never feeding a routing
 * decision (`providers/types.ts`), so ranking by it would contradict the field
 * it reads. A name pattern is honest about what it is: a preference for the
 * class of model a judge wants, not a price comparison.
 */
const CHEAP_MODEL_PATTERN = /(haiku|flash|mini|nano|small|lite|tiny)/i;

/**
 * The judge's model as "provider/model", or undefined when nothing suitable is
 * configured. `preferProvider` (the session's own provider) wins when it has a
 * cheap-class model, so the judge usually shares the connection the session
 * already has.
 */
export function findJudgeModel(preferProvider?: string): string | undefined {
  const configured = getConfiguredProviders();
  const candidates = Object.keys(configured).filter((name) => configured[name]);
  if (candidates.length === 0) return undefined;

  const modelsFor = (name: string): string[] => {
    const fromConfig = getProviderModels(name);
    if (fromConfig) return Object.keys(fromConfig);
    const preset = getPreset(name);
    return preset ? Object.keys(preset.models) : [];
  };

  const ordered = preferProvider !== undefined && candidates.includes(preferProvider)
    ? [preferProvider, ...candidates.filter((n) => n !== preferProvider)]
    : candidates;

  for (const provider of ordered) {
    const match = modelsFor(provider).find((id) => CHEAP_MODEL_PATTERN.test(id));
    if (match) return `${provider}/${match}`;
  }
  return undefined;
}

/**
 * §6.1's judge: one non-streaming completion, no tools, no thinking, and a
 * token budget that only fits the one-word answer plus a line of reason.
 *
 * Returns undefined when the stage is off or no judge model can be resolved —
 * in which case the classifier is rules-only, exactly as before. Never throws
 * for a missing model: `classifier.model.enabled` with nothing usable is a
 * configuration the caller should degrade out of, not a startup failure.
 */
export function createRiskJudge(opts: {
  enabled: boolean;
  id?: string;
  preferProvider?: string;
  timeoutMs?: number;
}): Stage2Options | undefined {
  if (!opts.enabled) return undefined;
  const target = opts.id ?? findJudgeModel(opts.preferProvider);
  if (target === undefined) return undefined;

  const slash = target.indexOf("/");
  if (slash <= 0 || slash === target.length - 1) return undefined;

  const provider = createProvider(target.slice(0, slash), { modelOverride: target.slice(slash + 1) });

  const judge: RiskJudge = async (prompt, signal) => {
    const messages: Message[] = [
      { role: "system", content: prompt.system },
      { role: "user", content: prompt.user },
    ];
    let text = "";
    for await (const event of provider.streamChat(messages, [], {
      temperature: 0,
      // Enough for `OK`/`FLAG` plus one line of reason; a cheap model asked for
      // a single word does not need room to think out loud.
      maxTokens: 80,
      ...(signal !== undefined ? { signal } : {}),
    })) {
      if (event.type === "text_delta") text += event.content;
      if (event.type === "done") break;
    }
    return text;
  };

  return { judge, timeoutMs: opts.timeoutMs ?? STAGE2_TIMEOUT_MS };
}

/** Effort levels from least to most thinking; a listed value outside this scale is never picked. */
const EFFORT_ORDER = ["none", "minimal", "low", "medium", "high", "max"];

/**
 * The least thinking the model offers, or undefined when it lists no effort
 * levels (nothing to send). A model that cannot turn thinking off still gets its
 * lowest level, because at its default the reasoning can eat the whole answer
 * budget: deepseek-flash lists only low/high/max and returned empty text at 256
 * tokens with the default.
 */
function lowestEffort(caps: ModelCapabilities | undefined): string | undefined {
  const listed = caps?.effort?.values ?? [];
  return EFFORT_ORDER.find((level) => listed.includes(level));
}

/**
 * Auto mode's judge (permissions/risk/auto.ts): the same non-streaming,
 * tool-less collection as above, but over a provider resolved *per request*
 * rather than fixed at construction, so a model switch in the picker applies to
 * the very next judgement and the judge needs no teardown.
 *
 * Thinking is minimised using only levels the model's own effort list offers
 * (sending an unsupported one is the failure): `none` if listed, else the lowest.
 * A model with no effort list gets none sent. Note that aisdk drops
 * `temperature` whenever an effort level is set. `maxTokens` comes from the caller because
 * the two stages need very different budgets (a token vs. room to reason).
 */
export function createAutoJudge(resolve: () => { provider: Provider; caps?: ModelCapabilities }): RiskJudge {
  return async (prompt, signal, opts) => {
    const { provider, caps } = resolve();
    const messages: Message[] = [
      { role: "system", content: prompt.system },
      { role: "user", content: prompt.user },
    ];
    let text = "";
    for await (const event of provider.streamChat(messages, [], {
      temperature: 0,
      ...(opts?.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}),
      ...(lowestEffort(caps) !== undefined ? { effort: lowestEffort(caps) } : {}),
      ...(signal !== undefined ? { signal } : {}),
    })) {
      if (event.type === "text_delta") text += event.content;
      if (event.type === "done") break;
    }
    return text;
  };
}
