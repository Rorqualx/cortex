import type { Storage } from "./storage.js";
import type { FactCertainty, L2Fact } from "./types.js";

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
   * letting high-confidence one-shots through. Tentative facts never take
   * this shortcut — a speculative one-shot must earn promotion over time.
   */
  highImportancePassthrough: number;
  /** Recall bar for candidates whose every occurrence was tagged tentative. */
  tentativeMinRecallCount: number;
  /** Dayspan bar for tentative-only candidates. */
  tentativeMinDayspanMs: number;
};

export const DEFAULT_CONSOLIDATION_CONFIG: ConsolidationConfig = {
  minRecallCount: 2,
  minDayspanMs: 3 * MS_PER_DAY,
  minImportance: 0.6,
  highImportancePassthrough: 0.85,
  tentativeMinRecallCount: 3,
  tentativeMinDayspanMs: 5 * MS_PER_DAY,
};

/** Rank for upgrading candidate certainty: any stronger occurrence wins. */
const CERTAINTY_RANK: Record<FactCertainty, number> = {
  tentative: 0,
  confirmed: 1,
  instructional: 2,
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
  /**
   * Strongest certainty across occurrences: one confirmed/instructional
   * sighting lifts the candidate out of the tentative bar. Facts extracted
   * before PROMPT_VERSION=8 carry no tag and count as confirmed.
   */
  certainty: FactCertainty;
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
    if (!doc) {
      continue;
    }
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
      certainty: fact.certainty ?? "confirmed",
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
  const factCertainty = fact.certainty ?? "confirmed";
  if (CERTAINTY_RANK[factCertainty] > CERTAINTY_RANK[existing.certainty]) {
    existing.certainty = factCertainty;
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
  const tentative = candidate.certainty === "tentative";
  if (!tentative && candidate.importance >= config.highImportancePassthrough) {
    return true;
  }
  const minRecallCount = tentative ? config.tentativeMinRecallCount : config.minRecallCount;
  const minDayspanMs = tentative ? config.tentativeMinDayspanMs : config.minDayspanMs;
  if (candidate.recallCount < minRecallCount) {
    return false;
  }
  if (candidate.lastConfirmedAt - candidate.firstSeenAt < minDayspanMs) {
    return false;
  }
  if (candidate.importance < config.minImportance) {
    return false;
  }
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
