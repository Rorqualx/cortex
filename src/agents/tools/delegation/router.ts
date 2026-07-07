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
const ERROR_PENALTY_MS = 30_000; // 30s penalty per recent error

const _latencyHistory = new Map<string, number[]>();
const _errorCounts = new Map<string, number>();

/** Record a successful call latency for a provider. Resets error count. */
export function recordProviderLatency(provider: string, latencyMs: number): void {
  const history = _latencyHistory.get(provider) ?? [];
  history.push(latencyMs);
  while (history.length > LATENCY_WINDOW_SIZE) history.shift();
  _latencyHistory.set(provider, history);
  _errorCounts.set(provider, 0);
}

/** Record a failed call for a provider. Increments error penalty. */
export function recordProviderError(provider: string): void {
  _errorCounts.set(provider, (_errorCounts.get(provider) ?? 0) + 1);
}

/** Compute an EWMA latency + error penalty for a provider. Returns ms. */
function providerLatencyPenalty(provider: string): number {
  const history = _latencyHistory.get(provider);
  if (!history || history.length < LATENCY_MIN_SAMPLES) return 0;

  // EWMA with alpha=0.3 — recent samples weighted more
  let ewma = history[0]!;
  for (let i = 1; i < history.length; i++) {
    ewma = 0.3 * history[i]! + 0.7 * ewma;
  }

  const errors = _errorCounts.get(provider) ?? 0;
  return ewma + errors * ERROR_PENALTY_MS;
}

/** Clear all latency state (test-only). */
export function resetLatencyState(): void {
  _latencyHistory.clear();
  _errorCounts.clear();
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

/** A provider+model candidate. `provider` is an OpenClaw config provider id. */
export type Candidate = { provider: string; model: string };

/** Delegation-eligible providers, in priority order (subscription → metered). */
export const PROVIDER_PRIORITY: readonly string[] = ["zai", "kimi", "deepseek", "moonshot"];

/**
 * Preferred model per provider per kind. Used only when the model is actually
 * configured; otherwise the first configured model of that provider is used.
 * `default` applies to any kind without a specific entry.
 */
const PREFERRED: Record<string, Partial<Record<DelegationKind, string>> & { default: string }> = {
  zai: {
    default: "glm-4.7",
    review: "glm-5.1",
    research: "glm-5.1",
    plan: "glm-5.1",
    academic: "glm-5.1",
    // glm-4.7 won the swarm tie-break (both judges) over glm-4.6 — most
    // file-specific findings + genuine cross-area synthesis, and reliable.
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

/** Pick a provider's model for a kind: preferred-if-configured, else first configured. */
function pickModel(providerId: string, kind: DelegationKind, models: string[]): string {
  const pref = PREFERRED[providerId]?.[kind] ?? PREFERRED[providerId]?.default;
  if (pref && models.includes(pref)) return pref;
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
    fallbacks = [...fallbacks].sort(
      (a, b) => providerLatencyPenalty(a.provider) - providerLatencyPenalty(b.provider),
    );
  }

  return { primary, fallbacks };
}
