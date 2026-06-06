import type { L2Fact } from "./types.js";

export type ScoringConfig = {
  weightLexical: number;
  /** BM25 lexical signal. Augments Jaccard with term-frequency/document-rarity
   * weighting so rare exact matches (IPs, paths, project names) score higher
   * than common-word overlaps. Default 0 — set to 0.2-0.4 to opt in. */
  weightBm25: number;
  weightImportance: number;
  weightRecency: number;
  /** ε-weighted L3-epoch boost. Soft additive prior; default 0.1. */
  weightL3Boost: number;
  /**
   * Flat additive bonus applied to any long-term tier hit that has a
   * positive lexical match. Lets evergreen facts edge out fresh L2 facts
   * at similar scoring without dominating unrelated queries. Default 0.15.
   */
  weightLongTermTierBoost: number;
  /**
   * Multiplier applied to memory-core QMD result scores to bring them into
   * the same 0-0.7 range as our composite, so the cross-store tier
   * participates in unified top-K ranking instead of competing on a
   * different scale. Default 0.7.
   */
  weightMemoryCoreTierMultiplier: number;
  /**
   * Flat additive bonus applied to typed-fact hits (left brain) that have a
   * positive lexical match. Smaller than the long-term boost because typed
   * facts already get a strong signal from confidence + the slot:value text
   * matching the query directly. Default 0.1.
   */
  weightTypedFactTierBoost: number;
  recencyHalfLifeDays: number;
};

export const DEFAULT_SCORING_CONFIG: ScoringConfig = {
  weightLexical: 0.6,
  weightBm25: 0,
  weightImportance: 0.2,
  weightRecency: 0.1,
  weightL3Boost: 0.1,
  weightLongTermTierBoost: 0.15,
  weightMemoryCoreTierMultiplier: 0.7,
  weightTypedFactTierBoost: 0.1,
  recencyHalfLifeDays: 7,
};

export type Signals = {
  lexical: number;
  bm25: number;
  importance: number;
  recency: number;
  l3Boost: number;
};

// Match alphabetic words, multi-char numeric runs (preserving internal . and ,
// so "$1,234.56" and "192.168.50.128" survive as single tokens), and single
// digits. Anything else is treated as a separator.
const TOKEN_PATTERN = /[a-z]+|\d[\d.,]*\d|\d/g;

export function tokenize(text: string): Set<string> {
  const matches = text.toLowerCase().match(TOKEN_PATTERN) ?? [];
  // Drop single-letter alphabetic tokens ("a", "i") as noise; keep single
  // digits ("port 5", "v3") since they often carry signal.
  return new Set(matches.filter((t) => t.length > 1 || /^\d$/.test(t)));
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersect = 0;
  for (const t of a) {
    if (b.has(t)) intersect += 1;
  }
  const union = a.size + b.size - intersect;
  return union === 0 ? 0 : intersect / union;
}

const MS_PER_DAY = 1000 * 60 * 60 * 24;

export function recencyScore(ageMs: number, halfLifeDays: number): number {
  if (halfLifeDays <= 0) return 1;
  const ageDays = Math.max(0, ageMs) / MS_PER_DAY;
  return Math.exp((-Math.LN2 * ageDays) / halfLifeDays);
}

export type CorpusStats = {
  /** Per-term document frequency: how many facts contain each token. */
  df: Map<string, number>;
  /** Total number of facts in the corpus. */
  total: number;
  /** Average fact text length in tokens. */
  avgLen: number;
};

export function bm25Score(
  queryTokens: Set<string>,
  factText: string,
  corpusStats: CorpusStats,
  k1 = 1.2,
  b = 0.75,
): number {
  const factTokens = tokenize(factText);
  const docLen = factTokens.size;
  let score = 0;
  for (const term of queryTokens) {
    if (!factTokens.has(term)) continue;
    const df = corpusStats.df.get(term) ?? 0;
    const idf = Math.log(1 + (corpusStats.total - df + 0.5) / (df + 0.5));
    // Presence-based tf=1: facts are short, so counting occurrences within
    // a single fact adds noise. The signal comes from IDF — rare terms
    // that match should dominate.
    const tf = 1;
    const norm = (tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * docLen) / (corpusStats.avgLen || 1)));
    score += idf * norm;
  }
  return score;
}

/** Build corpus-level document frequencies from a collection of fact texts.
 * One-pass: counts how many facts contain each token and computes average
 * fact length. */
export function buildCorpusStats(factTexts: ReadonlyArray<string>): CorpusStats {
  const df = new Map<string, number>();
  let totalTokens = 0;
  for (const text of factTexts) {
    const tokens = tokenize(text);
    totalTokens += tokens.size;
    for (const token of tokens) {
      df.set(token, (df.get(token) ?? 0) + 1);
    }
  }
  return {
    df,
    total: factTexts.length,
    avgLen: factTexts.length > 0 ? totalTokens / factTexts.length : 0,
  };
}

export function scoreFact(params: {
  queryTokens: Set<string>;
  fact: L2Fact;
  now: number;
  config: ScoringConfig;
  l3Boost?: number;
  /** Corpus stats for BM25 scoring. When omitted, bm25 signal is 0. */
  corpusStats?: CorpusStats;
}): Signals {
  const factTokens = tokenize(params.fact.text);
  const lexical = jaccard(params.queryTokens, factTokens);
  const bm25 =
    params.corpusStats && params.config.weightBm25 > 0
      ? bm25Score(params.queryTokens, params.fact.text, params.corpusStats)
      : 0;
  const importance = params.fact.importance;
  const recency = recencyScore(
    params.now - params.fact.createdAt,
    params.config.recencyHalfLifeDays,
  );
  return { lexical, bm25, importance, recency, l3Boost: params.l3Boost ?? 0 };
}

export function composite(signals: Signals, config: ScoringConfig): number {
  return (
    signals.lexical * config.weightLexical +
    signals.bm25 * config.weightBm25 +
    signals.importance * config.weightImportance +
    signals.recency * config.weightRecency +
    signals.l3Boost * config.weightL3Boost
  );
}
