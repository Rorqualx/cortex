import {
  composite,
  DEFAULT_SCORING_CONFIG,
  jaccard,
  type ScoringConfig,
  scoreFact,
  type Signals,
  tokenize,
} from "./scoring.js";
import type { Storage } from "./storage.js";
import type { L2Fact, L3EpochFrontmatter } from "./types.js";

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

  const epochBoosts = await buildEpochBoostMap(params.storage, queryTokens);

  const scored: RetrievedFact[] = [];
  for (const filePath of paths) {
    const doc = await params.storage.readL2ChunkAtPath(filePath);
    if (!doc) continue;
    const chunkId = doc.frontmatter.id;
    const l3Boost = epochBoosts.get(chunkId) ?? 0;
    for (const fact of doc.frontmatter.facts) {
      const signals = scoreFact({ queryTokens, fact, now, config, l3Boost });
      const score = composite(signals, config);
      if (score > 0) {
        scored.push({ fact, score, signals, chunkId });
      }
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}

/**
 * Build a lookup of `chunkId → epoch lexical score` so retrieval can apply a
 * soft additive prior to facts whose epoch is thematically relevant. The
 * epoch's "thematic text" is the concatenation of its representative facts
 * — a coarse but cheap proxy.
 */
async function buildEpochBoostMap(
  storage: Storage,
  queryTokens: Set<string>,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const paths = await storage.listL3EpochPaths();
  if (paths.length === 0) return out;
  for (const filePath of paths) {
    const doc = await storage.readL3EpochAtPath(filePath);
    if (!doc) continue;
    const epochScore = scoreEpochAgainstQuery(doc.frontmatter, queryTokens);
    if (epochScore <= 0) continue;
    const startSeq = chunkSeq(doc.frontmatter.startChunkId);
    const endSeq = chunkSeq(doc.frontmatter.endChunkId);
    if (startSeq === null || endSeq === null) continue;
    // Mark the boost by the (startSeq..endSeq) range; chunk lookup happens
    // through chunkSeqInRange when we apply the map back to facts. For O(1)
    // application we eagerly resolve via a per-seq marker since chunk ids
    // include random suffixes.
    out.set(`__range__${startSeq}_${endSeq}`, epochScore);
  }
  return resolveBoostMap(storage, out);
}

async function resolveBoostMap(
  storage: Storage,
  rangeMap: Map<string, number>,
): Promise<Map<string, number>> {
  if (rangeMap.size === 0) return new Map();
  const ranges: Array<{ start: number; end: number; score: number }> = [];
  for (const [key, score] of rangeMap) {
    const m = /^__range__(\d+)_(\d+)$/.exec(key);
    if (!m) continue;
    ranges.push({ start: Number.parseInt(m[1], 10), end: Number.parseInt(m[2], 10), score });
  }
  const out = new Map<string, number>();
  const paths = await storage.listL2ChunkPaths();
  for (const filePath of paths) {
    const doc = await storage.readL2ChunkAtPath(filePath);
    if (!doc) continue;
    const seq = chunkSeq(doc.frontmatter.id);
    if (seq === null) continue;
    let best = 0;
    for (const range of ranges) {
      if (seq >= range.start && seq <= range.end && range.score > best) {
        best = range.score;
      }
    }
    if (best > 0) out.set(doc.frontmatter.id, best);
  }
  return out;
}

function scoreEpochAgainstQuery(epoch: L3EpochFrontmatter, queryTokens: Set<string>): number {
  if (epoch.representativeFacts.length === 0) return 0;
  const epochText = epoch.representativeFacts.map((f) => f.text).join(" ");
  return jaccard(queryTokens, tokenize(epochText));
}

function chunkSeq(chunkId: string): number | null {
  const m = /^chunk-(\d+)/.exec(chunkId);
  return m ? Number.parseInt(m[1], 10) : null;
}

export function formatMemorySection(facts: ReadonlyArray<RetrievedFact>): string {
  if (facts.length === 0) return "";
  const lines = facts.map((r) => `- [${r.score.toFixed(2)}] ${r.fact.text}`);
  return `## Memory (hierarchical-l3)\n${lines.join("\n")}`;
}
