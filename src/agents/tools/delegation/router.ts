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
// Adaptive latency balancing: when a provider has ≥3 latency samples,
// fallbacks (not the primary) are reordered so faster/healthier providers
// float to the front. This avoids waiting on a slow-but-responding provider
// when a faster alternative is available. No data (tests/fresh start) →
// original priority order preserved (deterministic).
//
// NOTE: `kimi` (kimi-for-coding) speaks the anthropic-messages dialect and is
// served by a dedicated Anthropic client (providers/kimi-coding.ts); see
// host-config.resolveDelegationClient for the per-provider client mapping.

import type { OpenClawConfig } from "../../../config/types.openclaw.js";

// ---------------------------------------------------------------------------
// Latency tracker — per-provider rolling stats for adaptive fallback ordering
// ---------------------------------------------------------------------------

const LATENCY_WINDOW_SIZE = 10;
const LATENCY_MIN_SAMPLES = 3;
const ERROR_PENALTY_MS = 30_000; // 30s penalty per recent transient error
// Failure-class weights (strategy-aware delegation, Finding #12): deterministic
// failures demote harder than transient ones, and silent duds hardest — a dud
// output looks "fast" to the latency EWMA, so without an extra weight a
// fast-but-useless provider would float to the front of the fallback chain.
const PERSISTENT_ERROR_PENALTY_MS = 60_000;
const SILENT_ERROR_PENALTY_MS = 90_000;

const _latencyHistory = new Map<string, number[]>();
const _errorCounts = new Map<string, number>();
const _errorPenaltyMs = new Map<string, number>();

/** Failure class used to weight the per-provider error penalty. */
export type ProviderFailureClass = "transient" | "persistent" | "silent";

/** Record a successful call latency for a provider. Resets error state. */
export function recordProviderLatency(provider: string, latencyMs: number): void {
  const history = _latencyHistory.get(provider) ?? [];
  history.push(latencyMs);
  while (history.length > LATENCY_WINDOW_SIZE) history.shift();
  _latencyHistory.set(provider, history);
  _errorCounts.set(provider, 0);
  _errorPenaltyMs.set(provider, 0);
}

/**
 * Record a failed call for a provider. Increments the class-weighted error
 * penalty (transient < persistent < silent); defaults to the historical
 * transient weight so existing callers keep their behavior.
 */
export function recordProviderError(
  provider: string,
  opts?: { failureClass?: ProviderFailureClass },
): void {
  const failureClass = opts?.failureClass ?? "transient";
  const penalty =
    failureClass === "silent"
      ? SILENT_ERROR_PENALTY_MS
      : failureClass === "persistent"
        ? PERSISTENT_ERROR_PENALTY_MS
        : ERROR_PENALTY_MS;
  _errorCounts.set(provider, (_errorCounts.get(provider) ?? 0) + 1);
  _errorPenaltyMs.set(provider, (_errorPenaltyMs.get(provider) ?? 0) + penalty);
}

/**
 * EWMA latency + error penalty in ms, or undefined when we have no opinion.
 *
 * Returning 0 for an unmeasured provider would rank it ahead of every measured
 * healthy one — the inverse of this mechanism's purpose, and of the ordering
 * contract in resolveRoute. Errors count even with no successful samples, so a
 * provider that only ever fails is demoted rather than treated as pristine.
 */
function providerLatencyPenalty(provider: string): number | undefined {
  const history = _latencyHistory.get(provider);
  const errors = _errorCounts.get(provider) ?? 0;
  // Class-weighted total when present; legacy fallback keeps the historical
  // uniform weight for state written before the class split.
  const penalty = _errorPenaltyMs.get(provider) ?? errors * ERROR_PENALTY_MS;
  const hasLatency = (history?.length ?? 0) >= LATENCY_MIN_SAMPLES;
  if (!hasLatency && errors === 0) return undefined;
  if (!hasLatency) return penalty;

  // EWMA with alpha=0.3 — recent samples weighted more
  let ewma = history![0]!;
  for (let i = 1; i < history!.length; i++) {
    ewma = 0.3 * history![i]! + 0.7 * ewma;
  }
  return ewma + penalty;
}

/** Clear all latency state (test-only). */
export function resetLatencyState(): void {
  _latencyHistory.clear();
  _errorCounts.clear();
  _errorPenaltyMs.clear();
}

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

/**
 * Delegation-eligible providers, in priority order (subscription → metered).
 *
 * ⚠️ Do NOT collapse or dedup providers that appear capability-similar.
 * arXiv:2607.28308 (MoE coherent overlap) proves that geometrically similar
 * experts still differ in actual per-query routing: the selected candidate
 * explains more residual than the strongest unselected rival in every tested
 * cell. Apparent similarity (e.g. two providers serving the same model family)
 * does not imply redundancy — routing decisions are context-dependent and the
 * query prefix narrows the advantage per-query. Every configured provider must
 * remain reachable in the fallback chain so the router can discover the
 * per-query winner empirically, not by pre-filtering on apparent overlap.
 */
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
const PREFERRED = {
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
} satisfies Record<string, Partial<Record<DelegationKind, string>> & { default: string }>;

// String-keyed view for dynamic provider lookups; PREFERRED keeps literal keys
// so known providers (e.g. the zai fallback) stay non-optional.
const PREFERRED_BY_PROVIDER: Record<
  string,
  Partial<Record<DelegationKind, string>> & { default: string }
> = PREFERRED;

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
  /**
   * Optional: recent effective cost per 1M tokens per provider, factoring in
   * cache-hit savings. When provided, the router prefers cheaper providers
   * within the same priority tier. Absence falls back to the static priority
   * order (zai → kimi → deepseek → moonshot).
   */
  effectiveCostPerMtok?: Record<string, number> | undefined;
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

/**
 * Provider order: explicit override first, then the configured priority list.
 * When `costMap` is provided, providers within the same priority tier are
 * re-ordered by effective cost (cheapest first), with subscription providers
 * (zai, kimi) always ahead of metered (deepseek, moonshot) regardless of cost.
 *
 * NOTE: This function must never pre-filter or collapse providers that appear
 * capability-similar (see PROVIDER_PRIORITY doc for the MoE finding). Every
 * configured provider stays in the chain; empirical per-query routing — not
 * geometric similarity — determines the winner (arXiv:2607.28308).
 */
function orderedProviders(
  cfg: OpenClawConfig | undefined,
  override?: string,
  costMap?: Record<string, number>,
): string[] {
  const hasModels = (p: string) => configuredModels(cfg, p).length > 0;
  const ordered = costMap
    ? PROVIDER_PRIORITY.filter(hasModels).toSorted((a, b) => {
        const costA = costMap[a];
        const costB = costMap[b];
        // Keep subscription-tier providers ahead of metered.
        const aSub = a === "zai" || a === "kimi";
        const bSub = b === "zai" || b === "kimi";
        if (aSub !== bSub) return aSub ? -1 : 1;
        // Within the same tier, prefer cheaper.
        if (costA !== undefined && costB !== undefined && costA !== costB) {
          return costA < costB ? -1 : 1;
        }
        // Fall back to static priority when cost data is missing.
        return PROVIDER_PRIORITY.indexOf(a) - PROVIDER_PRIORITY.indexOf(b);
      })
    : PROVIDER_PRIORITY.filter(hasModels);
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
  // providerId is a dynamic string, so go through the string-keyed view rather
  // than PREFERRED's literal-keyed table.
  const providerPrefs = PREFERRED_BY_PROVIDER[providerId];
  // 1. Explicit per-kind preference
  const explicit = providerPrefs?.[kind];
  if (explicit && models.includes(explicit)) return explicit;
  // 2. Tier-based preference (backbone → strongest, execution → fastest)
  const tierModel = TIER_DEFAULT[providerId]?.[ROLE_TIER[kind]];
  if (tierModel && models.includes(tierModel)) return tierModel;
  // 3. Provider default
  const def = providerPrefs?.default;
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
  const costMap = req.effectiveCostPerMtok;
  const providers = orderedProviders(req.cfg, req.provider, costMap);
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
  let fallbacks = chain.slice(1);

  // Adaptive latency balancing: when we have ≥3 latency samples for any
  // provider in the fallback chain, reorder so faster/healthier providers
  // float to the front. The primary is never reordered — it always goes
  // first. No data → original priority order preserved (deterministic).
  const hasLatencyData = fallbacks.some(
    (c) =>
      _latencyHistory.has(c.provider) &&
      (_latencyHistory.get(c.provider)?.length ?? 0) >= LATENCY_MIN_SAMPLES,
  );
  if (hasLatencyData) {
    // Reorder ONLY the measured entries, in place, leaving every unmeasured slot
    // untouched. A comparator that returns 0 against unmeasured providers is
    // non-transitive (slow > fast, yet each ties with the unmeasured one between
    // them), so the result would depend on where V8's sort happens to compare —
    // a slow provider could keep its lead over a fast one.
    const measuredSlots: number[] = [];
    for (const [index, candidate] of fallbacks.entries()) {
      if (providerLatencyPenalty(candidate.provider) !== undefined) {
        measuredSlots.push(index);
      }
    }
    const reordered = measuredSlots
      .map((index) => fallbacks[index]!)
      .sort((a, b) => providerLatencyPenalty(a.provider)! - providerLatencyPenalty(b.provider)!);
    fallbacks = [...fallbacks];
    for (const [slot, index] of measuredSlots.entries()) {
      fallbacks[index] = reordered[slot]!;
    }
  }

  return { primary, fallbacks };
}
