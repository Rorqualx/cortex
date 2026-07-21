/**
 * Reconciles a live `/models` fetch against the persisted discovery snapshot and
 * picks nearest-capability replacements for deprecated models.
 *
 * Deprecation is install-scoped and only applied on a successful, non-empty
 * fetch: a model previously seen active that is absent from the new live set is
 * flipped to deprecated. Replacement scoring runs on merged catalog metadata
 * (the discovery endpoint itself carries no metadata).
 */
import type { DatabaseSync } from "node:sqlite";
import {
  type DiscoveredModelRecord,
  listDiscoveredModels,
  markDiscoveredModelsDeprecated,
  upsertActiveDiscoveredModels,
} from "./discovered-store.js";
import type { FetchModelsResult } from "./model-discovery.js";

/** Result of reconciling one provider's live fetch into the discovery snapshot. */
export type ReconcileResult =
  | { ok: false; reason: string }
  | { ok: true; added: string[]; deprecated: string[]; activeCount: number };

/** Pure diff: which previously-active model ids are absent from the live set. */
export function diffVanishedModels(
  liveModelIds: readonly string[],
  existingActive: readonly DiscoveredModelRecord[],
): string[] {
  const live = new Set(liveModelIds.map((id) => id.trim().toLowerCase()));
  return existingActive
    .filter((row) => !live.has(row.modelId.trim().toLowerCase()))
    .map((row) => row.modelId);
}

/**
 * Applies a fetch result to the discovery snapshot for one provider. Skips
 * (without deprecating anything) when the fetch failed or returned no models.
 */
export function reconcileProviderModels(
  db: DatabaseSync,
  params: { provider: string; fetchResult: FetchModelsResult; nowMs: number },
): ReconcileResult {
  const { provider, fetchResult, nowMs } = params;
  if (!fetchResult.ok) {
    return { ok: false, reason: fetchResult.error };
  }
  const before = listDiscoveredModels(db, { provider });
  // Only /models-listed rows participate in vanish-deprecation; probe-sourced rows
  // (served-but-unlisted, e.g. an upgraded model id) are expected to be absent
  // from the /models list and must not be deprecated by it.
  const existingActive = before.filter((row) => row.status === "active" && row.source === "models");
  const existingIds = new Set(before.map((row) => row.modelId.trim().toLowerCase()));
  const liveIds = fetchResult.models.map((m) => m.modelId);
  const added = liveIds.filter((id) => !existingIds.has(id.trim().toLowerCase()));
  const deprecated = diffVanishedModels(liveIds, existingActive);

  upsertActiveDiscoveredModels(db, provider, fetchResult.models, nowMs);
  markDiscoveredModelsDeprecated(db, provider, deprecated, nowMs);

  return { ok: true, added, deprecated, activeCount: liveIds.length };
}

/** Minimal capability metadata used to score a replacement, from merged catalog. */
export type ReplacementCandidate = {
  provider: string;
  id: string;
  reasoning?: boolean;
  contextWindow?: number;
  costInput?: number;
};

function scoreCandidate(
  deprecated: ReplacementCandidate,
  candidate: ReplacementCandidate,
  defaultModelId: string | undefined,
): [number, number, number, number, string] {
  // Lower tuples win. Order: reasoning parity, context closeness, cost
  // closeness, default-model preference, then id for determinism.
  const reasoningMismatch =
    (candidate.reasoning ?? false) === (deprecated.reasoning ?? false) ? 0 : 1;
  const ctxDelta = Math.abs((candidate.contextWindow ?? 0) - (deprecated.contextWindow ?? 0));
  const costDelta = Math.abs((candidate.costInput ?? 0) - (deprecated.costInput ?? 0));
  const defaultPreference = defaultModelId && candidate.id === defaultModelId ? 0 : 1;
  return [reasoningMismatch, ctxDelta, costDelta, defaultPreference, candidate.id];
}

function compareScores(
  a: [number, number, number, number, string],
  b: [number, number, number, number, string],
): number {
  for (let i = 0; i < 4; i += 1) {
    const delta = (a[i] as number) - (b[i] as number);
    if (delta !== 0) {
      return delta;
    }
  }
  return a[4].localeCompare(b[4]);
}

/**
 * Picks the nearest surviving model in the same provider for a deprecated one.
 * Returns the chosen model id, or null when no active candidate exists (caller
 * then disables the cron / clears the pin / drops the alias and warns).
 */
export function pickReplacementModel(params: {
  deprecated: ReplacementCandidate;
  candidates: readonly ReplacementCandidate[];
  defaultModelId?: string;
}): string | null {
  const { deprecated, candidates, defaultModelId } = params;
  const usable = candidates.filter(
    (c) => c.provider === deprecated.provider && c.id !== deprecated.id,
  );
  if (usable.length === 0) {
    return null;
  }
  const [best] = usable
    .map((candidate) => ({
      id: candidate.id,
      score: scoreCandidate(deprecated, candidate, defaultModelId),
    }))
    .toSorted((a, b) => compareScores(a.score, b.score));
  // usable.length > 0 (checked above) and map/toSorted preserve length.
  return best!.id;
}
