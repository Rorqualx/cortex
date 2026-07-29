/**
 * PROBE SPIKE — Generic greedy submodular selection + context-assembly wrapper.
 * Card: ARCH-1 6e85475c (PACMS query-aware submodular selection)
 *
 * This is a feasibility spike. It extracts the core greedy algorithm from
 * retrieval.ts:submodularSelect into a generic function, then wraps it
 * for context-assembly use.
 */

export interface ContextCandidate {
  id: string;
  text: string;
  source: 'memory' | 'conversation' | 'tool-output' | 'system';
  relevanceScore: number;
  tokenEstimate: number;
  metadata?: Record<string, unknown>;
}

/**
 * Generic greedy submodular maximization with knapsack constraint.
 *
 * Extracted from retrieval.ts:submodularSelect (line 1232).
 * The core algorithm is: at each step, pick the item that maximizes
 *   relevance + diversityWeight * novelty + coverageWeight * newQueryTokenCoverage
 * subject to the token budget.
 */
export function greedySubmodularSelect<T extends {
  id: string;
  text: string;
  score: number;
  tokens: number;
}>(
  pool: T[],
  queryTokens: Set<string>,
  opts: {
    tokenBudget: number;
    diversityWeight: number;
    coverageWeight: number;
    maxItems: number;
  },
): T[] {
  const selected: T[] = [];
  const selectedIds = new Set<string>();
  const coveredTokens = new Set<string>();
  let usedTokens = 0;

  const workingPool = pool.slice();

  while (workingPool.length > 0 && selected.length < opts.maxItems) {
    let bestIdx = -1;
    let bestGain = -Infinity;

    for (let i = 0; i < workingPool.length; i += 1) {
      const item = workingPool[i];
      if (!item || selectedIds.has(item.id)) continue;

      if (usedTokens + item.tokens > opts.tokenBudget) continue;

      // Relevance (already normalized 0-1)
      const relevance = item.score;

      // Diversity: penalize max Jaccard similarity with any selected item
      let maxSim = 0;
      const itemTokens = tokenize(item.text);
      for (const sel of selected) {
        const sim = jaccard(itemTokens, tokenize(sel.text));
        if (sim > maxSim) maxSim = sim;
      }
      const diversity = 1 - maxSim;

      // Coverage: new query tokens covered
      const newCount = [...queryTokens].filter((t) => itemTokens.has(t) && !coveredTokens.has(t)).length;
      const coverage = queryTokens.size > 0 ? newCount / queryTokens.size : 0;

      const gain = relevance + opts.diversityWeight * diversity + opts.coverageWeight * coverage;

      if (gain > bestGain) {
        bestGain = gain;
        bestIdx = i;
      }
    }

    if (bestIdx === -1) break;

    const chosen = workingPool[bestIdx];
    if (!chosen) break;

    selected.push(chosen);
    selectedIds.add(chosen.id);
    usedTokens += chosen.tokens;

    const chosenTokens = tokenize(chosen.text);
    for (const t of queryTokens) {
      if (chosenTokens.has(t)) coveredTokens.add(t);
    }

    workingPool.splice(bestIdx, 1);
  }

  return selected;
}

/**
 * Context-assembly wrapper: converts mixed candidates into a unified pool
 * and runs submodular selection under a token budget.
 */
export function selectContext(
  candidates: ContextCandidate[],
  queryTokens: Set<string>,
  tokenBudget: number,
): ContextCandidate[] {
  const pool = candidates.map((c) => ({
    id: c.id,
    text: c.text,
    score: c.relevanceScore,
    tokens: c.tokenEstimate,
  }));

  const selected = greedySubmodularSelect(pool, queryTokens, {
    tokenBudget,
    diversityWeight: 0.3,
    coverageWeight: 0.2,
    maxItems: candidates.length,
  });

  const selectedIds = new Set(selected.map((s) => s.id));
  return candidates.filter((c) => selectedIds.has(c.id));
}

// --- helpers (mirrored from retrieval.ts) ---

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 1),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const t of a) {
    if (b.has(t)) intersection += 1;
  }
  return intersection / (a.size + b.size - intersection);
}
