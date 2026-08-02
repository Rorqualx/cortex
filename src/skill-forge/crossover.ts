/**
 * Skill Forge crossover operator (Frontis-MA1-inspired, arXiv:2607.28568).
 *
 * The four-operator decomposition (Draft/Improve/Debug/Crossover) outperforms
 * single-lineage refinement. Crossover combines fragments from different
 * successful skill candidates to produce a merged candidate that may capture
 * a broader capability than either parent.
 *
 * The existing detect → distill → gate pipeline maps to Draft/Improve/Debug.
 * This module adds the missing Crossover operator.
 */

import crypto from "node:crypto";
import type { Candidate, RepetitionCandidate } from "./detector.js";

/** Minimum successScore for both parents to qualify for crossover. */
export const CROSSOVER_SUCCESS_THRESHOLD = 0.6;

/** Minimum tool-shape overlap (Jaccard) for two candidates to be paired. */
export const CROSSOVER_TOOL_OVERLAP_MIN = 0.3;

/** Maximum crossover candidates to generate per pipeline run. */
export const CROSSOVER_MAX_OUTPUT = 5;

/**
 * Compute tool-shape overlap (Jaccard) between two tool sequences.
 * Reuses the same algorithm from embedding-clusterer.
 */
function toolShapeOverlap(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let intersect = 0;
  for (const v of setA) {
    if (setB.has(v)) intersect++;
  }
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 0 : intersect / union;
}

/**
 * Merge two tool sequences into a single deduplicated, order-preserving list.
 * Tools from parent A come first, then any novel tools from parent B.
 */
export function mergeToolSequences(a: readonly string[], b: readonly string[]): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const tool of [...a, ...b]) {
    if (!seen.has(tool)) {
      seen.add(tool);
      merged.push(tool);
    }
  }
  return merged;
}

/**
 * Generate crossover candidates from a list of existing candidates.
 *
 * Identifies pairs where both candidates have successScore above threshold
 * and share some tool overlap. Generates merged candidates with union'd
 * tool sequences and averaged success scores.
 *
 * Gate behind `enableCrossover` in the pipeline config.
 */
export function generateCrossoverCandidates(
  candidates: readonly Candidate[],
  options?: {
    successThreshold?: number;
    toolOverlapMin?: number;
    maxOutput?: number;
  },
): RepetitionCandidate[] {
  const successThreshold = options?.successThreshold ?? CROSSOVER_SUCCESS_THRESHOLD;
  const toolOverlapMin = options?.toolOverlapMin ?? CROSSOVER_TOOL_OVERLAP_MIN;
  const maxOutput = options?.maxOutput ?? CROSSOVER_MAX_OUTPUT;

  // Filter to candidates above the success threshold and with non-empty tool sequences.
  const eligible = candidates.filter(
    (c) => c.successScore >= successThreshold && c.toolSequence.length > 0,
  );

  if (eligible.length < 2) {
    return [];
  }

  const crossover: RepetitionCandidate[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < eligible.length && crossover.length < maxOutput; i++) {
    for (let j = i + 1; j < eligible.length && crossover.length < maxOutput; j++) {
      const a = eligible[i]!;
      const b = eligible[j]!;

      const overlap = toolShapeOverlap(a.toolSequence, b.toolSequence);
      if (overlap < toolOverlapMin) continue;
      // Skip identical tool sequences (overlap = 1.0 means same tools — no crossover value).
      if (overlap >= 1.0) continue;

      const mergedTools = mergeToolSequences(
        a.candidateId <= b.candidateId ? a.toolSequence : b.toolSequence,
        a.candidateId <= b.candidateId ? b.toolSequence : a.toolSequence,
      );
      const pairKey = [a.candidateId, b.candidateId].sort().join("+");
      if (seen.has(pairKey)) continue;
      seen.add(pairKey);

      const mergedCaptureDirs = [...new Set([...(a.captureDirs ?? []), ...(b.captureDirs ?? [])])];

      const hash = crypto
        .createHash("sha256")
        .update(mergedTools.join(","))
        .digest("hex")
        .slice(0, 16);

      crossover.push({
        lane: "tool-shape",
        candidateId: `xover-${hash}`,
        toolShapeHash: hash,
        toolSequence: mergedTools,
        captureDirs: mergedCaptureDirs,
        occurrences: (a.occurrences ?? 1) + (b.occurrences ?? 1),
        // Average of parents with a small boost for combining complementary capabilities.
        successScore: Math.min(1, ((a.successScore + b.successScore) / 2) * 1.1),
      });
    }
  }

  return crossover;
}
