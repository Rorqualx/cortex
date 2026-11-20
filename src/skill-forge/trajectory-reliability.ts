/**
 * ARCH-1: Reliability-aware trajectory replay for Skill Forge.
 *
 * Pure scoring helpers (no I/O, deterministic). Two concerns are kept
 * separate on purpose:
 *   - the VALUE dimension of a cluster merge is the per-capture outcome
 *     score from `computeSuccessScore` (detector.ts) — {0.5, 1} today;
 *   - the WEIGHT dimension (`computeTrajectoryReliability`) expresses how
 *     much a capture should be trusted as evidence. The outcome tier is
 *     treated as certain (base 1.0); only trajectory pathology degrades
 *     the weight: doom-loop runs, excessive steering interruptions, and
 *     token overruns. With no penalty signals — the entire real corpus
 *     today (probe 2026-11-17: no doom/steer/overrun fields in any
 *     forge-manifest) — every capture weights 1.0 and the weighted mean
 *     degenerates to the plain arithmetic mean (the "equal-weight law").
 */

export type TrajectoryReliabilityInput = {
  /** Outcome-certain base for the weight (1.0 from the detector wiring). */
  successScore: number;
  /** Run ended in a doom-loop state (probe Q1; absent ⇒ no penalty). */
  doomLoop?: boolean;
  /** Steering-preempt interruptions for the same session (probe Q2; absent ⇒ 0). */
  steerCount?: number;
  /** Token overrun beyond a lane-median multiple (probe Q3; absent ⇒ no penalty). */
  tokenOverrun?: boolean;
};

const DOOM_LOOP_PENALTY = 0.3;
const STEER_PENALTY_PER_COUNT = 0.05;
const STEER_PENALTY_CAP = 0.15;
const TOKEN_OVERRUN_PENALTY = 0.2;

/**
 * Neutral-default law: every absent signal contributes its neutral value,
 * so a signal-free input returns `successScore` unchanged. Penalties:
 * −0.3 doom-loop, −0.05 × steer count (capped at −0.15), −0.2 token
 * overrun. Clamped at 0, rounded to 3 decimal places.
 */
export function computeTrajectoryReliability(input: TrajectoryReliabilityInput): number {
  let score = input.successScore;
  if (input.doomLoop === true) {
    score -= DOOM_LOOP_PENALTY;
  }
  const steerCount = input.steerCount ?? 0;
  if (steerCount > 0) {
    score -= Math.min(STEER_PENALTY_CAP, STEER_PENALTY_PER_COUNT * steerCount);
  }
  if (input.tokenOverrun === true) {
    score -= TOKEN_OVERRUN_PENALTY;
  }
  return Math.max(0, Math.round(score * 1000) / 1000);
}

export type WeightedMeanEntry = {
  value: number;
  weight: number;
};

/**
 * Reliability-weighted mean Σ(rᵢ·sᵢ)/Σrᵢ. Empty input (or a non-positive
 * weight sum) yields 0. Rounded to 3 decimal places to keep emitted
 * candidate JSON stable.
 *
 * Back-compat: entries may alternatively use the probe-era field alias
 * `{ successScore, reliability }` (same value/weight semantics); both
 * shapes are accepted.
 */
export function weightedMean(entries: WeightedMeanEntry[]): number {
  if (entries.length === 0) {
    return 0;
  }
  let numerator = 0;
  let denominator = 0;
  for (const raw of entries) {
    const alias = raw as WeightedMeanEntry & {
      successScore?: number;
      reliability?: number;
    };
    const value = typeof alias.value === "number" ? alias.value : (alias.successScore ?? 0);
    const weight = typeof alias.weight === "number" ? alias.weight : (alias.reliability ?? 0);
    numerator += value * weight;
    denominator += weight;
  }
  if (denominator <= 0) {
    return 0;
  }
  return Math.round((numerator / denominator) * 1000) / 1000;
}
