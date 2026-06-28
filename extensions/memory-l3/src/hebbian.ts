/**
 * Hebbian learning — co-occurrence strengthening for facts from the same chunk.
 *
 * Facts extracted from the same L2 chunk co-occur and strengthen each other.
 * The edge map is persisted as `edges.json` in the L3 root so it survives
 * restarts. When a fact scores high in retrieval, its co-occurring neighbors
 * get a boost proportional to the edge weight × neighbor's own score.
 *
 * Inspired by ZenBrain's two-factor Hebbian learning: repeated co-occurrence
 * across chunks strengthens the edge, while single-chunk edges stay weak.
 */

import type { L2Fact } from "./types.js";

export type HebbianEdge = {
  /** First fact dedupKey (sorted so a < b). */
  a: string;
  /** Second fact dedupKey (sorted so a < b). */
  b: string;
  /** Co-occurrence count across chunks. */
  weight: number;
};

export type HebbianConfig = {
  /** Weight of neighbor score contribution. Default 0.05. */
  neighborWeight: number;
  /** Maximum edge weight to consider (capped). Default 10. */
  maxEdgeWeight: number;
  /** Enable/disable Hebbian boosting. Default true. */
  enabled: boolean;
  /**
   * Attenuation for 2-hop neighbors relative to direct ones. 0 disables the
   * second hop entirely (current default — raise after measuring recall
   * delta on real queries). A 2-hop path's strength is its weakest edge, and
   * nodes already reachable in 1 hop never double-count through hop 2.
   */
  twoHopDecay: number;
  /**
   * G4 pattern completion: number of top hits whose edge-neighbors are pulled
   * into the result set even if they didn't match the query — so a partial cue
   * can retrieve the rest of an associated memory (CA3-style completion). 0
   * (default) = pure re-ranking, no expansion.
   */
  expandTopN: number;
  /**
   * Score multiplier for a pulled neighbor relative to the hit it came from
   * (scaled further by the edge's normalized weight). Keeps completions ranked
   * below genuine matches while still able to enter top-K. Default 0.5.
   */
  expansionFactor: number;
};

export const DEFAULT_HEBBIAN_CONFIG: HebbianConfig = {
  neighborWeight: 0.05,
  maxEdgeWeight: 10,
  enabled: true,
  twoHopDecay: 0,
  expandTopN: 0,
  expansionFactor: 0.5,
};

/**
 * Create a canonical edge key from two dedupKeys (sorted so ordering is
 * deterministic regardless of which fact is "a" vs "b").
 */
export function edgeKey(a: string, b: string): string {
  return a < b ? `${a}::${b}` : `${b}::${a}`;
}

/**
 * Extract co-occurrence edges from facts in the same chunk.
 * Every pair of facts in the chunk gets a mutual edge with weight 1.
 * For N facts, produces N*(N-1)/2 edges.
 */
export function extractEdges(facts: ReadonlyArray<L2Fact>): HebbianEdge[] {
  if (facts.length < 2) {
    return [];
  }
  const edges: HebbianEdge[] = [];
  for (let i = 0; i < facts.length; i++) {
    for (let j = i + 1; j < facts.length; j++) {
      const a = facts[i].dedupKey;
      const b = facts[j].dedupKey;
      if (a === b) {
        continue;
      }
      const [sorted_a, sorted_b] = a < b ? [a, b] : [b, a];
      edges.push({ a: sorted_a, b: sorted_b, weight: 1 });
    }
  }
  return edges;
}

/**
 * Extract co-occurrence edges from retrieval results.
 * Facts that surface together in the same retrieval query strengthen
 * their associative link even when they come from different chunks.
 * Mirrors `extractEdges` but accepts a generic result shape so retrieval
 * can call it without a circular dependency on `hebbian.ts`.
 */
export function extractEdgesFromRetrieval(
  results: ReadonlyArray<{ fact: { dedupKey: string } }>,
): HebbianEdge[] {
  if (results.length < 2) {
    return [];
  }
  const edges: HebbianEdge[] = [];
  for (let i = 0; i < results.length; i++) {
    for (let j = i + 1; j < results.length; j++) {
      const a = results[i].fact.dedupKey;
      const b = results[j].fact.dedupKey;
      if (a === b) {
        continue;
      }
      const [sorted_a, sorted_b] = a < b ? [a, b] : [b, a];
      edges.push({ a: sorted_a, b: sorted_b, weight: 1 });
    }
  }
  return edges;
}

/**
 * Merge new edges into existing edge map, incrementing weight for
 * repeated co-occurrences across chunks.
 */
export function mergeEdges(
  existing: ReadonlyArray<HebbianEdge>,
  newEdges: ReadonlyArray<HebbianEdge>,
): HebbianEdge[] {
  const map = new Map<string, HebbianEdge>();
  for (const edge of existing) {
    map.set(edgeKey(edge.a, edge.b), { ...edge });
  }
  for (const edge of newEdges) {
    const key = edgeKey(edge.a, edge.b);
    const current = map.get(key);
    if (current) {
      current.weight += edge.weight;
    } else {
      map.set(key, { ...edge });
    }
  }
  return Array.from(map.values()).toSorted((a, b) =>
    edgeKey(a.a, a.b).localeCompare(edgeKey(b.a, b.b)),
  );
}

/**
 * Build a lookup map from dedupKey → list of edges touching that key.
 * Used during retrieval to find a fact's neighbors.
 */
export function buildEdgeLookup(edges: ReadonlyArray<HebbianEdge>): Map<string, HebbianEdge[]> {
  const map = new Map<string, HebbianEdge[]>();
  for (const edge of edges) {
    const listA = map.get(edge.a) ?? [];
    listA.push(edge);
    map.set(edge.a, listA);
    const listB = map.get(edge.b) ?? [];
    listB.push(edge);
    map.set(edge.b, listB);
  }
  return map;
}

/**
 * Compute the Hebbian boost for a fact based on its neighbors' scores.
 *
 * boost = Σ(neighborScore × min(edgeWeight, maxEdgeWeight) × neighborWeight)
 *
 * Only neighbors with positive base scores contribute. The boost is additive
 * to the composite score, not multiplicative, so it can't amplify noise.
 */
export function hebbianBoost(
  dedupKey: string,
  edgeLookup: Map<string, HebbianEdge[]>,
  baseScores: Map<string, number>,
  config: HebbianConfig = DEFAULT_HEBBIAN_CONFIG,
): number {
  if (!config.enabled) {
    return 0;
  }
  const edges = edgeLookup.get(dedupKey);
  if (!edges || edges.length === 0) {
    return 0;
  }
  const directNeighbors = new Map<string, number>();
  let boost = 0;
  for (const edge of edges) {
    const neighborKey = edge.a === dedupKey ? edge.b : edge.a;
    const cappedWeight = Math.min(edge.weight, config.maxEdgeWeight);
    directNeighbors.set(neighborKey, cappedWeight);
    const neighborScore = baseScores.get(neighborKey) ?? 0;
    if (neighborScore <= 0) {
      continue;
    }
    boost += neighborScore * cappedWeight * config.neighborWeight;
  }
  if (config.twoHopDecay <= 0) {
    return boost;
  }
  for (const [neighborKey, firstHopWeight] of directNeighbors) {
    const secondHopEdges = edgeLookup.get(neighborKey);
    if (!secondHopEdges) {
      continue;
    }
    for (const edge of secondHopEdges) {
      const farKey = edge.a === neighborKey ? edge.b : edge.a;
      // Skip the origin and anything already counted as a direct neighbor.
      if (farKey === dedupKey || directNeighbors.has(farKey)) {
        continue;
      }
      const farScore = baseScores.get(farKey) ?? 0;
      if (farScore <= 0) {
        continue;
      }
      const pathWeight = Math.min(firstHopWeight, Math.min(edge.weight, config.maxEdgeWeight));
      boost += farScore * pathWeight * config.neighborWeight * config.twoHopDecay;
    }
  }
  return boost;
}
