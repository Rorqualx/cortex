import {
  composite,
  DEFAULT_SCORING_CONFIG,
  type ScoringConfig,
  scoreFact,
  type Signals,
  tokenize,
} from "./scoring.js";
import type { Storage } from "./storage.js";
import type { L2Fact } from "./types.js";

export type RetrievedFact = {
  fact: L2Fact;
  score: number;
  signals: Signals;
  chunkId: string;
};

export async function retrieveTopK(params: {
  query: string;
  storage: Storage;
  topK: number;
  now?: number;
  config?: ScoringConfig;
}): Promise<RetrievedFact[]> {
  const topK = Math.max(0, params.topK);
  if (topK === 0) return [];
  const queryTokens = tokenize(params.query);
  if (queryTokens.size === 0) return [];

  const paths = await params.storage.listL2ChunkPaths();
  if (paths.length === 0) return [];

  const now = params.now ?? Date.now();
  const config = params.config ?? DEFAULT_SCORING_CONFIG;
  const scored: RetrievedFact[] = [];

  for (const filePath of paths) {
    const doc = await params.storage.readL2ChunkAtPath(filePath);
    if (!doc) continue;
    const chunkId = doc.frontmatter.id;
    for (const fact of doc.frontmatter.facts) {
      const signals = scoreFact({ queryTokens, fact, now, config });
      const score = composite(signals, config);
      if (score > 0) {
        scored.push({ fact, score, signals, chunkId });
      }
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}

export function formatMemorySection(facts: ReadonlyArray<RetrievedFact>): string {
  if (facts.length === 0) return "";
  const lines = facts.map((r) => `- [${r.score.toFixed(2)}] ${r.fact.text}`);
  return `## Memory (hierarchical-l3)\n${lines.join("\n")}`;
}
