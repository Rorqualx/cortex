import type { Storage } from "./storage.js";
import type { L2Fact } from "./types.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export type ConsolidationConfig = {
  /** Minimum distinct L2 chunks that must emit a dedupKey before it can promote. */
  minRecallCount: number;
  /** Minimum span (ms) between firstSeenAt and lastConfirmedAt — proves the fact survives time. */
  minDayspanMs: number;
  /** Minimum importance (across all confirmations) for promotion. */
  minImportance: number;
  /**
   * Single-occurrence shortcut: a fact at this importance promotes immediately
   * without needing recall or dayspan. Mirrors memory-core's pattern of
   * letting high-confidence one-shots through.
   */
  highImportancePassthrough: number;
};

export const DEFAULT_CONSOLIDATION_CONFIG: ConsolidationConfig = {
  minRecallCount: 2,
  minDayspanMs: 3 * MS_PER_DAY,
  minImportance: 0.6,
  highImportancePassthrough: 0.85,
};

/**
 * The aggregated view of a single dedupKey across every L2 chunk that has
 * emitted it. This is the input to promotion decisions in `longterm.ts`.
 */
export type ConsolidationCandidate = {
  dedupKey: string;
  /** Canonical text — taken from the highest-importance occurrence; recency breaks ties. */
  text: string;
  importance: number;
  recallCount: number;
  firstSeenAt: number;
  lastConfirmedAt: number;
  /** Chunk ids that confirmed this dedupKey, in encounter order. */
  sourceChunkIds: string[];
};

/**
 * Walk every L2 chunk, group facts by dedupKey, and produce one candidate per
 * distinct key with cumulative signals. Pure function; no thresholding.
 */
export async function aggregateCandidates(storage: Storage): Promise<ConsolidationCandidate[]> {
  const candidates = new Map<string, ConsolidationCandidate>();
  const paths = await storage.listL2ChunkPaths();
  for (const filePath of paths) {
    const doc = await storage.readL2ChunkAtPath(filePath);
    if (!doc) continue;
    const chunkId = doc.frontmatter.id;
    for (const fact of doc.frontmatter.facts) {
      mergeFact(candidates, fact, chunkId);
    }
  }
  return [...candidates.values()];
}

function mergeFact(
  candidates: Map<string, ConsolidationCandidate>,
  fact: L2Fact,
  chunkId: string,
): void {
  const existing = candidates.get(fact.dedupKey);
  if (!existing) {
    candidates.set(fact.dedupKey, {
      dedupKey: fact.dedupKey,
      text: fact.text,
      importance: fact.importance,
      recallCount: 1,
      firstSeenAt: fact.createdAt,
      lastConfirmedAt: fact.createdAt,
      sourceChunkIds: [chunkId],
    });
    return;
  }
  // Capture before mutating lastConfirmedAt so the tie-break compares the
  // fact against the *previous* most-recent confirmation, not against itself.
  const prevLastConfirmedAt = existing.lastConfirmedAt;
  existing.recallCount += 1;
  existing.firstSeenAt = Math.min(existing.firstSeenAt, fact.createdAt);
  existing.lastConfirmedAt = Math.max(existing.lastConfirmedAt, fact.createdAt);
  if (
    fact.importance > existing.importance ||
    (fact.importance === existing.importance && fact.createdAt > prevLastConfirmedAt)
  ) {
    existing.text = fact.text;
    existing.importance = fact.importance;
  }
  if (!existing.sourceChunkIds.includes(chunkId)) {
    existing.sourceChunkIds.push(chunkId);
  }
}

/**
 * Predicate: should this candidate promote into the long-term tier? Returns
 * true when the candidate either (a) meets the high-importance shortcut or
 * (b) clears the recall + dayspan + importance bar.
 */
export function passesPromotionThresholds(
  candidate: ConsolidationCandidate,
  config: ConsolidationConfig = DEFAULT_CONSOLIDATION_CONFIG,
): boolean {
  if (candidate.importance >= config.highImportancePassthrough) {
    return true;
  }
  if (candidate.recallCount < config.minRecallCount) return false;
  if (candidate.lastConfirmedAt - candidate.firstSeenAt < config.minDayspanMs) return false;
  if (candidate.importance < config.minImportance) return false;
  return true;
}

/**
 * Filter helper: aggregate + threshold in one pass, returning only the
 * candidates that should actually promote.
 */
export async function selectPromotable(
  storage: Storage,
  config: ConsolidationConfig = DEFAULT_CONSOLIDATION_CONFIG,
): Promise<ConsolidationCandidate[]> {
  const candidates = await aggregateCandidates(storage);
  return candidates.filter((c) => passesPromotionThresholds(c, config));
}
