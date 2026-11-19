/**
 * PROBE SPIKE (throwaway) — ARCH-1 card 42510695: Reliability-aware trajectory replay.
 *
 * Pure per-capture reliability score for Skill Forge detector candidates.
 * Probe findings (2026-11-17, real corpus 767 captures):
 *  - Q1/Q3: NO structured doom-loop / run-status / token-overrun events exist in
 *    events.jsonl (type histogram: session.*, user.message, assistant.message,
 *    tool.call only; all "doom/overrun" grep hits were incidental prose).
 *  - Q2: steer count derivable from manifests (trigger:"steering-preempt" +
 *    sessionId grouping) but ZERO steering captures exist in the corpus.
 *  ⇒ All penalty inputs default to absent; the neutral law (all-absent ⇒
 *    successScore unchanged) is the only live path on real data today.
 */

export type TrajectoryReliabilityInput = {
  /** Capture-time outcome from computeSuccessScore (1 | 0.5). */
  successScore: number;
  /** Probe Q1 — doom-loop observed. Absent ⇒ no penalty. */
  doomLoop?: boolean;
  /** Probe Q2 — steering preempts during the session. Absent ⇒ no penalty. */
  steerCount?: number;
  /** Probe Q3 — token budget overrun. Absent ⇒ no penalty. */
  tokenOverrun?: boolean;
};

const DOOM_LOOP_PENALTY = 0.3;
const STEER_PENALTY_PER = 0.05;
const STEER_PENALTY_CAP = 0.15;
const TOKEN_OVERRUN_PENALTY = 0.2;

export function computeTrajectoryReliability(input: TrajectoryReliabilityInput): number {
  let score = input.successScore;
  if (input.doomLoop === true) score -= DOOM_LOOP_PENALTY;
  if (input.steerCount !== undefined && input.steerCount > 0) {
    score -= Math.min(input.steerCount * STEER_PENALTY_PER, STEER_PENALTY_CAP);
  }
  if (input.tokenOverrun === true) score -= TOKEN_OVERRUN_PENALTY;
  if (score < 0) score = 0;
  return Math.round(score * 1000) / 1000;
}

/** Reliability-weighted mean of per-capture success scores: Σ(rᵢ·sᵢ)/Σrᵢ. */
export function weightedMean(
  members: Array<{ reliability: number; successScore: number }>,
): number {
  if (members.length === 0) return 0;
  let weighted = 0;
  let totalWeight = 0;
  for (const m of members) {
    weighted += m.reliability * m.successScore;
    totalWeight += m.reliability;
  }
  if (totalWeight <= 0) return 0;
  return Math.round((weighted / totalWeight) * 1000) / 1000;
}
