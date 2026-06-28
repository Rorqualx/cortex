import type { L2Fact } from "./types.js";

export type ScoringConfig = {
  weightLexical: number;
  /** BM25 lexical signal. Augments Jaccard with term-frequency/document-rarity
   * weighting so rare exact matches (IPs, paths, project names) score higher
   * than common-word overlaps. Default 0 — set to 0.2-0.4 to opt in. */
  weightBm25: number;
  weightImportance: number;
  /**
   * Recency/forgetting signal weight. When `useFsrs` is true, this weight
   * applies to the FSRS retrievability score instead of simple exponential
   * decay. Default 0.1.
   */
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
  /** Base half-life in days for FSRS recency scoring. Default 7. */
  recencyHalfLifeDays: number;
  /**
   * When true, use FSRS-based per-fact forgetting instead of simple
   * exponential decay. Facts with higher recallCount get longer half-lives.
   * Default true.
   */
  useFsrs: boolean;
  /**
   * Weight for embedding-based semantic similarity signal. Only applies when
   * both the query and the fact have pre-computed embeddings. When 0 or when
   * embeddings are unavailable, this signal is skipped entirely.
   * Default 0.15.
   */
  weightSemantic: number;
  /**
   * Weight for the source chunk's information-gain (session novelty) signal.
   * Small by design: novel L2 facts (high 1−cosine to long-term) get a slight
   * lift so genuinely new session content surfaces over rehashed evergreen
   * facts, without letting novelty override lexical/semantic relevance.
   * Only L2 facts carry an informationGain; other tiers score it as 0.
   */
  weightInformationGain: number;
  /**
   * Weight for goal-relevance signal. When a query-goal embedding is
   * available, facts semantically aligned with the current task/goal get
   * a boost. Default 0.1.
   */
  weightGoalRelevance: number;
  /**
   * Weight for source-reliability signal. Facts with higher certainty
   * (confirmed > instructional > tentative) score higher. Default 0.1.
   */
  weightReliability: number;
  /**
   * Weight for semantic-entropy confidence signal. Facts with higher
   * semantic-entropy scores (more confident / lower entropy) get a slight
   * boost. Default 0.1. Set to 0 to disable.
   */
  weightSemanticEntropy: number;
};

export const DEFAULT_SCORING_CONFIG: ScoringConfig = {
  // Phase 1 rebalance: with semantic embeddings now active, reduce lexical
  // dominance and give BM25 + semantic their proper weight. This moves us
  // from keyword-matching-over-compressed-summaries to true hybrid retrieval.
  weightLexical: 0.25,
  weightBm25: 0.3,
  weightImportance: 0.15,
  weightRecency: 0.05,
  weightL3Boost: 0.1,
  weightLongTermTierBoost: 0.15,
  weightMemoryCoreTierMultiplier: 0.7,
  weightTypedFactTierBoost: 0.1,
  recencyHalfLifeDays: 7,
  useFsrs: true,
  weightSemantic: 0.35,
  weightInformationGain: 0.05,
  weightGoalRelevance: 0.1,
  weightReliability: 0.1,
  weightSemanticEntropy: 0.1,
};

// ---------------------------------------------------------------------------
// FSRS-inspired per-fact forgetting (ZenBrain / FSFM research)
// ---------------------------------------------------------------------------

/**
 * FSRS (Free Spaced Repetition Scheduler) parameters for per-fact stability.
 * Unlike the one-size-fits-all recencyScore(), FSRS models each fact's
 * retrievability based on how often it's been recalled and how stable it is.
 *
 * Inspired by:
 * - ZenBrain: FSRS scheduling with Hebbian learning and Ebbinghaus curves
 * - FSFM: per-fact stability × difficulty × retrievability
 * - Microsoft "Forgetting Is the Fix": exponential decay with per-fact rates
 *
 * The key insight: a fact recalled 20 times (like an IP address) should have
 * a MUCH longer half-life than a fact recalled once (a one-off conversation).
 */

/** FSRS parameters that control the forgetting curve shape. */
export type FsrsParams = {
  /** Difficulty parameter (0..1). Higher = harder to remember. Default 0.3. */
  w0: number;
  /** Stability growth on successful recall. Default 1.3. */
  w1: number;
  /**
   * Global decay-rate multiplier on the forgetting curve. 1.0 = neutral
   * Ebbinghaus (half-life = stability·ln2); >1 forgets faster, <1 slower.
   * Default 1.0.
   */
  w2: number;
  /** Significance multiplier — "remember this" facts decay 2.7× slower. Default 2.7. */
  significanceBoost: number;
};

export const DEFAULT_FSRS_PARAMS: FsrsParams = {
  w0: 0.3,
  w1: 1.3,
  w2: 1.0,
  significanceBoost: 2.7,
};

/**
 * Compute FSRS-based retrievability for a fact.
 *
 * R(t) = e^(-(w2 · t) / S)   (w2 = global decay-rate multiplier, default 1.0)
 *
 * Where S (stability) grows with recallCount:
 *   S = baseHalfLifeDays × w1^(recallCount - 1) × (1 + difficulty)
 *
 * And for significant facts:
 *   S *= significanceBoost
 *
 * This means:
 * - First recall (recallCount=1): S = baseHalfLifeDays × (1 + difficulty)
 * - Each subsequent recall multiplies S by w1 (1.3×)
 * - "Remember this" facts get 2.7× longer stability
 * - Result: infrastructure facts (recalled 20×) have ~190 day half-life
 *   vs one-off facts at ~7 days
 */
export function fsrsRetrievability(params: {
  ageMs: number;
  recallCount: number;
  halfLifeDays: number;
  significant?: boolean;
  fsrs?: FsrsParams;
}): number {
  const fsrs = params.fsrs ?? DEFAULT_FSRS_PARAMS;
  const ageDays = Math.max(0, params.ageMs) / MS_PER_DAY;
  if (params.halfLifeDays <= 0) {
    return 1;
  }

  // Compute per-fact stability based on recall history
  let stability = params.halfLifeDays * fsrs.w1 ** Math.max(0, params.recallCount - 1);
  stability *= 1 + fsrs.w0; // difficulty adjustment

  // Significance boost (emotional tagging from ZenBrain)
  if (params.significant) {
    stability *= fsrs.significanceBoost;
  }

  // R(t) = e^(-(w2 · t) / S) — Ebbinghaus curve with per-fact stability, where
  // w2 scales global forgetting speed (1.0 = neutral). Kept separate from
  // stability so it tunes the curve uniformly without distorting per-fact
  // recall growth.
  return Math.exp(-(fsrs.w2 * ageDays) / stability);
}

export type Signals = {
  lexical: number;
  bm25: number;
  importance: number;
  recency: number;
  l3Boost: number;
  /** Embedding-based cosine similarity. 0 when embeddings unavailable. */
  semantic: number;
  /** Source chunk's session-novelty metric. 0 when the chunk predates it. */
  informationGain: number;
  /** Goal-relevance score from query-goal embedding alignment. 0 when unavailable. */
  goalRelevance: number;
  /** Source reliability derived from fact certainty (confirmed=1, instructional=0.85, tentative=0.5). */
  reliability: number;
  /** Semantic-entropy confidence score (0–1). Higher = more confident / lower entropy. */
  semanticEntropy: number;
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
  if (a.size === 0 || b.size === 0) {
    return 0;
  }
  let intersect = 0;
  for (const t of a) {
    if (b.has(t)) {
      intersect += 1;
    }
  }
  const union = a.size + b.size - intersect;
  return union === 0 ? 0 : intersect / union;
}

const MS_PER_DAY = 1000 * 60 * 60 * 24;

export function recencyScore(ageMs: number, halfLifeDays: number): number {
  if (halfLifeDays <= 0) {
    return 1;
  }
  const ageDays = Math.max(0, ageMs) / MS_PER_DAY;
  return Math.exp((-Math.LN2 * ageDays) / halfLifeDays);
}

// ---------------------------------------------------------------------------
// Cosine similarity for pre-computed embedding vectors
// ---------------------------------------------------------------------------

/**
 * Cosine similarity between two embedding vectors.
 * Returns 0 if either vector is empty or lengths mismatch.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) {
    return 0;
  }
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Near-duplicate similarity for two short prose facts. Prefers embedding
 * cosine (semantic — catches paraphrase like "balance ~$500" vs "account
 * holds 500 dollars") when both facts carry comparable vectors; falls back to
 * lexical jaccard otherwise.
 *
 * Returns the chosen `metric` alongside the score so callers apply the
 * metric-appropriate threshold: cosine and jaccard are different scales, and a
 * single shared threshold mis-fires on whichever metric it was not calibrated
 * for. Shared by long-term dedup and prose-interference so the two stay in sync.
 */
export function nearDuplicateSimilarity(
  a: { embedding?: number[]; tokens: Set<string> },
  b: { embedding?: number[]; tokens: Set<string> },
): { metric: "cosine" | "jaccard"; sim: number } {
  if (
    a.embedding &&
    b.embedding &&
    a.embedding.length > 0 &&
    a.embedding.length === b.embedding.length
  ) {
    return { metric: "cosine", sim: cosineSimilarity(a.embedding, b.embedding) };
  }
  return { metric: "jaccard", sim: jaccard(a.tokens, b.tokens) };
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
    if (!factTokens.has(term)) {
      continue;
    }
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
  /**
   * Number of times this fact has been recalled across L2 chunks.
   * When > 1 and useFsrs is true, FSRS-based forgetting is used instead
   * of simple exponential decay — giving high-recall facts longer half-lives.
   */
  recallCount?: number;
  /** Whether this fact was flagged as significant by the user ("remember this"). */
  significant?: boolean;
  /** Source chunk's information-gain metric, when known. */
  informationGain?: number;
  /** Goal-relevance score, when computed externally. */
  goalRelevance?: number;
  /** Explicit reliability override; otherwise derived from fact.certainty. */
  reliability?: number;
  /** Semantic-entropy confidence score (0–1). Higher = more confident. Defaults to fact.semanticEntropy or 1.0. */
  semanticEntropy?: number;
  /**
   * Grounding confidence from the CALIBER dual-confidence verifier (0–1).
   * When present, scales the reliability signal to reflect model uncertainty
   * about the turn from which this fact was extracted.
   */
  groundingConfidence?: number;
}): Signals {
  const factTokens = tokenize(params.fact.text);
  const lexical = jaccard(params.queryTokens, factTokens);
  const bm25 =
    params.corpusStats && params.config.weightBm25 > 0
      ? bm25Score(params.queryTokens, params.fact.text, params.corpusStats)
      : 0;
  const importance = params.fact.importance;
  const ageMs = params.now - params.fact.createdAt;
  const recency =
    params.config.useFsrs && (params.recallCount ?? 0) > 0
      ? fsrsRetrievability({
          ageMs,
          recallCount: params.recallCount ?? 1,
          halfLifeDays: params.config.recencyHalfLifeDays,
          significant: params.significant,
        })
      : recencyScore(ageMs, params.config.recencyHalfLifeDays);
  const signals: Signals = {
    lexical,
    bm25,
    importance,
    recency,
    l3Boost: params.l3Boost ?? 0,
    semantic: 0,
    informationGain: params.informationGain ?? 0,
    goalRelevance: params.goalRelevance ?? 0,
    reliability: params.reliability ?? certaintyToReliability(params.fact.certainty),
    semanticEntropy: params.semanticEntropy ?? params.fact.semanticEntropy ?? 1.0,
  };
  if (params.groundingConfidence !== undefined && params.groundingConfidence >= 0) {
    signals.reliability = signals.reliability * params.groundingConfidence;
  }
  return signals;
}

export function composite(signals: Signals, config: ScoringConfig): number {
  return (
    signals.lexical * config.weightLexical +
    signals.bm25 * config.weightBm25 +
    signals.importance * config.weightImportance +
    signals.recency * config.weightRecency +
    signals.l3Boost * config.weightL3Boost +
    signals.semantic * config.weightSemantic +
    signals.informationGain * config.weightInformationGain +
    signals.goalRelevance * config.weightGoalRelevance +
    signals.reliability * config.weightReliability +
    signals.semanticEntropy * config.weightSemanticEntropy
  );
}

/** Map fact certainty to a reliability score. */
function certaintyToReliability(certainty: import("./types.js").FactCertainty | undefined): number {
  switch (certainty) {
    case "tentative":
      return 0.5;
    case "instructional":
      return 0.85;
    case "confirmed":
    default:
      return 1.0;
  }
}
