// Per-kind provider+model routing for the delegation tools — config-driven.
//
// The chat picks the tool KIND; this module picks the provider+model chain.
// Models are read from the host config (cfg.models.providers[*].models), so a
// newly-configured model is automatically available as a fallback — nothing is
// hardcoded except the PRIORITY policy and the per-kind preferences.
//
// Priority policy (subscription-included first, metered APIs last):
//   primary tier : zai (GLM coding plan), kimi (kimi-for-coding subscription)
//   fallback tier: deepseek, moonshot (Kimi/Moonshot pay-as-you-go)
//
// NOTE: `kimi` (kimi-for-coding) speaks the anthropic-messages dialect and is
// served by a dedicated Anthropic client (providers/kimi-coding.ts); see
// host-config.resolveDelegationClient for the per-provider client mapping.

import type { OpenClawConfig } from "../../../config/types.openclaw.js";

export type DelegationKind =
  | "code"
  | "review"
  | "research"
  | "delegate"
  | "explore"
  | "swarm"
  | "plan"
  | "academic"
  | "vision";

/**
 * Role tier for each delegation kind.
 *
 * Research (Finding #9 — capacity asymmetry): the delegation *backbone*
 * (task decomposition, planning, research synthesis) is highly
 * capacity-sensitive — scaling the backbone improves EM by ~11pp. The
 * *execution* side (code, explore, vision) is far less sensitive (~2.6pp),
 * and a 1.7B executor can match frontier sub-agents.
 *
 * `ROLE_TIER` makes this policy explicit so routing code, tests, and future
 * injection-policy work can reason about it without re-deriving from the
 * PREFERRED table.
 */
export const ROLE_TIER = {
  // Backbone: needs the strongest configured model.
  plan: "backbone",
  research: "backbone",
  academic: "backbone",
  review: "backbone",
  // Execution: speed/cost-optimized; capacity matters less.
  code: "execution",
  explore: "execution",
  vision: "execution",
  swarm: "execution",
  delegate: "execution",
} as const satisfies Record<DelegationKind, "backbone" | "execution">;

/** Type guard / accessor for the role tier of a kind. */
export function tierForKind(kind: DelegationKind): "backbone" | "execution" {
  return ROLE_TIER[kind];
}

/**
 * Tier-default model per provider: backbone → strongest, execution → fastest.
 * Used when PREFERRED doesn't have an explicit per-kind entry (e.g. vision
 * needs the -v variant regardless of tier, so it stays explicit).
 */
const TIER_DEFAULT: Record<string, Record<"backbone" | "execution", string>> = {
  zai: { backbone: "glm-5.1", execution: "glm-4.7" },
  kimi: { backbone: "kimi-for-coding", execution: "kimi-for-coding" },
  deepseek: { backbone: "deepseek-v4-pro", execution: "deepseek-v4-pro" },
  moonshot: { backbone: "kimi-k2.6", execution: "kimi-k2.6" },
};

/** A provider+model candidate. `provider` is an OpenClaw config provider id. */
export type Candidate = { provider: string; model: string };

/** Delegation-eligible providers, in priority order (subscription → metered). */
export const PROVIDER_PRIORITY: readonly string[] = ["zai", "kimi", "deepseek", "moonshot"];

/**
 * Preferred model per provider per kind. Explicit per-kind entries override
 * the tier default (e.g. vision needs the -v variant). Entries not listed
 * here resolve via TIER_DEFAULT — backbone kinds get the strongest model,
 * execution kinds get the fastest.
 *
 * `default` is the legacy fallback when neither an explicit entry nor a
 * tier default resolves (and for providers without a TIER_DEFAULT entry).
 */
const PREFERRED: Record<string, Partial<Record<DelegationKind, string>> & { default: string }> = {
  zai: {
    default: "glm-4.7",
    // backbone kinds (plan, research, academic, review) auto-resolve to
    // glm-5.1 via TIER_DEFAULT — no need to list them explicitly.
    explore: "glm-4.7",
    swarm: "glm-4.7",
    vision: "glm-4.6v",
  },
  kimi: { default: "kimi-for-coding" },
  deepseek: { default: "deepseek-v4-pro" },
  moonshot: { default: "kimi-k2.6", vision: "moonshot-v1-128k-vision-preview" },
};

/**
 * Same-provider secondary retry for the PRIMARY provider only: tried right after
 * the primary, BEFORE crossing to other providers. Lets a transient primary
 * hiccup retry cheaply on a sibling model first. Keyed by kind (zai models).
 * The swarm experiment ranked glm-4.6 #2 behind glm-4.7, so it's the retry.
 */
const PREFERRED_SECONDARY: Partial<Record<DelegationKind, string>> = {
  swarm: "glm-4.6",
  explore: "glm-4.6",
  code: "glm-4.6",
};

/**
 * Fallback model lists used only when cfg does not enumerate a provider's
 * models (tests / pre-config). Mirrors the real configured catalog.
 */
const STATIC_MODELS: Record<string, string[]> = {
  zai: ["glm-5.1", "glm-5", "glm-5-turbo", "glm-4.7", "glm-4.6", "glm-4.6v", "glm-5v-turbo"],
  kimi: ["kimi-for-coding"],
  deepseek: ["deepseek-v4-pro", "deepseek-v4-flash"],
  moonshot: ["kimi-k2.6", "kimi-k2.5", "moonshot-v1-128k-vision-preview"],
};

export type RouteRequest = {
  kind: DelegationKind;
  cfg?: OpenClawConfig | undefined;
  /** Caller override: explicit provider id. Becomes the primary. */
  provider?: string | undefined;
  /** Caller override: explicit model id (applies to the chosen primary provider). */
  model?: string | undefined;
};

export type Route = {
  primary: Candidate;
  fallbacks: Candidate[];
};

/**
 * Models configured for a provider. When the host has a model catalog, we honor
 * it exactly (a provider absent from the catalog yields no candidates). Only
 * when no catalog is configured at all (tests / pre-config) do we fall back to
 * the static bootstrap list.
 */
function configuredModels(cfg: OpenClawConfig | undefined, providerId: string): string[] {
  const providers = cfg?.models?.providers;
  if (providers && Object.keys(providers).length > 0) {
    const entry = providers[providerId];
    if (!entry) return [];
    return (entry.models ?? [])
      .map((m) => m.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0);
  }
  return STATIC_MODELS[providerId] ?? [];
}

/** Provider order: explicit override first, then the configured priority list. */
function orderedProviders(cfg: OpenClawConfig | undefined, override?: string): string[] {
  const hasModels = (p: string) => configuredModels(cfg, p).length > 0;
  const ordered = PROVIDER_PRIORITY.filter(hasModels);
  if (!override) return ordered;
  return [override, ...ordered.filter((p) => p !== override)];
}

/**
 * Pick a provider's model for a kind. Resolution order:
 * 1. Explicit per-kind preference (PREFERRED[kind]) — e.g. vision → glm-4.6v.
 * 2. Tier default (TIER_DEFAULT[tier]) — backbone → strongest, execution → fastest.
 * 3. Provider default (PREFERRED[default]) — legacy catch-all.
 * 4. First configured model.
 */
function pickModel(providerId: string, kind: DelegationKind, models: string[]): string {
  // 1. Explicit per-kind preference
  const explicit = PREFERRED[providerId]?.[kind];
  if (explicit && models.includes(explicit)) return explicit;
  // 2. Tier-based preference (backbone → strongest, execution → fastest)
  const tier = ROLE_TIER[kind];
  const tierModel = TIER_DEFAULT[providerId]?.[tier];
  if (tierModel && models.includes(tierModel)) return tierModel;
  // 3. Provider default
  const def = PREFERRED[providerId]?.default;
  if (def && models.includes(def)) return def;
  // 4. First configured
  return models[0]!;
}

/**
 * Resolve a kind (+ optional overrides) into a primary candidate and an ordered
 * fallback chain. The chain is: one preferred model per provider (priority
 * order) — the fast path — followed by every other configured model (priority
 * order) so any configured model is reachable as a deep fallback.
 */
export function resolveRoute(req: RouteRequest): Route {
  const providers = orderedProviders(req.cfg, req.provider);
  const primaryProvider =
    req.provider && providers.includes(req.provider) ? req.provider : providers[0];

  const fast: Candidate[] = [];
  const tail: Candidate[] = [];
  const seen = new Set<string>();
  const push = (into: Candidate[], provider: string, model: string) => {
    const key = `${provider}/${model}`;
    if (seen.has(key)) return;
    seen.add(key);
    into.push({ provider, model });
  };

  for (const provider of providers) {
    const models = configuredModels(req.cfg, provider);
    if (models.length === 0) continue;
    const picked =
      provider === primaryProvider && req.model ? req.model : pickModel(provider, req.kind, models);
    push(fast, provider, picked);
    // Same-provider secondary retry, inserted right after the primary so a
    // transient primary failure retries on a sibling before crossing providers.
    if (provider === primaryProvider) {
      const secondary = PREFERRED_SECONDARY[req.kind];
      if (secondary && secondary !== picked && models.includes(secondary)) {
        push(fast, provider, secondary);
      }
    }
    for (const m of models) push(tail, provider, m);
  }

  const chain = [...fast, ...tail];
  // Fallback safety net if nothing was configured at all.
  const primary = chain[0] ?? { provider: "zai", model: PREFERRED.zai.default };
  return { primary, fallbacks: chain.slice(1) };
}
