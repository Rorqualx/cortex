/**
 * NFA-inspired near/far scoring split (QW3, 2026-11-27).
 *
 * Research premise (NFA — near/far attention profiles for memory): a single
 * flat ranker applies one recency policy to every candidate, but candidates
 * come from two structurally different pools:
 *
 * - **near** — recent session-archive material (L2/typed/memory-core tiers
 *   inside the near window). Within this pool freshness IS a relevance
 *   signal: the live task state outranks stale phrasing of the same fact.
 * - **far** — consolidated memory (longterm / longterm-typed / insight /
 *   procedural / shared tiers, plus session-archive items older than the
 *   window). Within this pool age is NOT evidence against a fact — old is
 *   the defining property. Penalizing age just suppresses the entire far
 *   pool relative to near, and adds noise inside it.
 *
 * The split therefore re-weights `weightRecency` per zone, composing with
 * whatever base config the item already resolved to (default, intent
 * preset, or MemoType category preset — explicit caller config still wins
 * over all presets):
 *
 * - near: `weightRecency × NEAR_RECENCY_MULTIPLIER` (2.0) — recency
 *   discriminates harder inside the recent pool.
 * - far: `weightRecency × FAR_RECENCY_MULTIPLIER` (0.2) — age-insensitive
 *   ranking for the far pool. The recency term stops discriminating far
 *   facts by age (a 90-day-old consolidated fact no longer loses to a
 *   40-day-old one on freshness); content, importance, and reliability
 *   signals decide. Note the absolute recency contribution of a far fact
 *   is small (its age-decayed signal is already low), so the profile's
 *   effect is concentrated within-pool, while the near profile carries
 *   the cross-pool freshness signal.
 *
 * Multipliers (not absolute overrides) so category presets keep their
 * deliberate recency choices — a "keyword-first" IP fact that set
 * weightRecency near zero stays near zero in both zones; a
 * "recency-weighted" open task keeps its 5× boost. Calibration: the
 * multipliers are the two sweepable knobs (`scripts/sweep-weights.mjs` /
 * `optimize-weights.ts` against the LongMemEval harness).
 */
import type { ScoringConfig } from "./scoring.js";

export type NearFarZone = "near" | "far";

/**
 * Consolidated / promoted / cross-context memory tiers: far by definition,
 * regardless of wall-clock age (a reconfirmed long-term fact is still
 * consolidated memory, not session context).
 */
const FAR_TIERS = new Set<string>([
  "longterm",
  "longterm-typed",
  "insight",
  "procedural",
  "shared",
]);

/**
 * Resolve an item's near/far zone from its tier and creation time.
 * Session-archive tiers (l2 / typed / memory-core) are near only while
 * recent; once older than the window they receive far (age-neutral)
 * treatment — an old session fact suffers the same flat-ranker age penalty
 * problem as a long-term fact.
 */
export function resolveNearFarZone(
  tier: string,
  factCreatedAt: number,
  now: number,
  windowMs: number,
): NearFarZone {
  if (FAR_TIERS.has(tier)) {
    return "far";
  }
  return now - factCreatedAt <= windowMs ? "near" : "far";
}

/** Recency multiplier for near-zone items. Default 2.0. */
export const NEAR_RECENCY_MULTIPLIER = 2.0;

/** Recency multiplier for far-zone items. Default 0.2. */
export const FAR_RECENCY_MULTIPLIER = 0.2;

/**
 * Apply the zone's recency re-weighting on top of a resolved base config.
 * Multiplies `weightRecency` so preset recency choices are preserved
 * proportionally. Returns the base config unchanged (same reference) when
 * the multiplier is exactly 1.
 */
export function applyNearFarProfile(config: ScoringConfig, zone: NearFarZone): ScoringConfig {
  const multiplier = zone === "near" ? NEAR_RECENCY_MULTIPLIER : FAR_RECENCY_MULTIPLIER;
  if (multiplier === 1) {
    return config;
  }
  return { ...config, weightRecency: config.weightRecency * multiplier };
}

/** Default near window: 7 days of wall-clock age. */
export const DEFAULT_NEAR_FAR_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
