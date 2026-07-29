/**
 * Checkpoint-preservation gate for the Improvement Lab deep pipeline.
 *
 * RSIBench-Data (arXiv:2607.25886) found that 78% of continued searches
 * after a non-improving checkpoint end up regressing. This module provides
 * the comparison logic that gates stage advancement at the probe stage:
 *
 * - If the probe metric beats the baseline by ≥ `threshold`, advance to `test`.
 * - If not, walk the card back to `design` instead of wasting pipeline
 *   cycles on a regression-prone path.
 *
 * The baseline and probe metrics are stored on the card's
 * `metadata.research` object (`probeBaseline`, `probeResult`).
 */

export type ProbeComparison = {
  /** True when the probe metric beats the baseline by at least `threshold`. */
  improved: boolean;
  /** Raw delta (probeResult − probeBaseline). Positive = improvement. */
  delta: number;
  /** Recommended next stage: "test" if improved, "design" if not. */
  recommendation: "test" | "design";
};

/**
 * Default promotion threshold delta. The probe must beat the baseline by
 * at least this much to advance. Mirrors `ParallelSamplingBaseline.promotionThresholdDelta`
 * in skill-forge (default 0.05), kept as a local constant to avoid a cross-
 * package import for a single number.
 */
export const DEFAULT_PROBE_PROMOTION_THRESHOLD = 0.05;

/**
 * Compare a probe result against a stored baseline.
 *
 * @param probeResult - Metric captured after the probe stage.
 * @param probeBaseline - Metric captured before the probe stage.
 * @param threshold - Minimum improvement delta to advance. Default 0.05.
 * @returns Comparison result with improvement status and recommendation.
 */
export function compareProbeToBaseline(
  probeResult: number,
  probeBaseline: number,
  threshold: number = DEFAULT_PROBE_PROMOTION_THRESHOLD,
): ProbeComparison {
  const delta = probeResult - probeBaseline;
  const improved = delta >= threshold;
  return {
    improved,
    delta: Math.round(delta * 1e6) / 1e6, // round to 6 decimal places
    recommendation: improved ? "test" : "design",
  };
}

/**
 * Determine whether a card at the `probe` stage should be allowed to
 * advance to `test`, or should be walked back to `design`.
 *
 * Returns `null` when the gate doesn't apply (missing baseline or result).
 * In that case the caller should allow normal advancement.
 *
 * @param probeBaseline - The card's `research.probeBaseline` value.
 * @param probeResult - The card's `research.probeResult` value.
 * @param threshold - Minimum delta to advance. Default 0.05.
 */
export function evaluateProbeGate(
  probeBaseline: number | undefined,
  probeResult: number | undefined,
  threshold?: number,
): ProbeComparison | null {
  if (probeBaseline === undefined || probeResult === undefined) {
    return null; // Gate not active — no baseline/result captured
  }
  return compareProbeToBaseline(probeResult, probeBaseline, threshold);
}
