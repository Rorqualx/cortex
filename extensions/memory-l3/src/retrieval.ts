import { readSharedFacts } from "./cross-context.js";
import { recordRetrievalSignals } from "./entities.js";
import {
  buildEdgeLookup,
  extractEdgesFromRetrieval,
  hebbianBoost,
  mergeEdges,
  type HebbianConfig,
  type HebbianEdge,
  DEFAULT_HEBBIAN_CONFIG,
} from "./hebbian.js";
import { bestHypeMatch, buildHypeLookup } from "./hype.js";
import { formatBody } from "./longterm-typed.js";
import {
  readPromotedSkills,
  proceduralFactAsL2Fact,
  fsrsProceduralRetrievability,
} from "./procedural.js";
import {
  buildCorpusStats,
  composite,
  cosineSimilarity,
  DEFAULT_SCORING_CONFIG,
  type CorpusStats,
  jaccard,
  type ScoringConfig,
  rankByScore,
  rrfFuse,
  scoreFact,
  staleDemotionMultiplier,
  type Signals,
  tokenize,
} from "./scoring.js";

// ---------------------------------------------------------------------------
// SCM Query-Intent Router (arXiv:2607.19096 — Structured Contextual Memory)
// ---------------------------------------------------------------------------
// Heuristic query-intent classifier that selects scoring presets per intent.
// Factual lookups → BM25-heavy; multi-hop → balanced + Hebbian-friendly;
// synthesis → semantic-heavy + importance-boosted.

export type QueryIntent = "factual" | "multihop" | "synthesis";

/**
 * Classify a retrieval query into one of three intents using keyword/pattern
 * heuristics. No LLM call — adds zero latency.
 *
 * - **factual**: direct lookups ("what is X", IPs, values, short specific queries)
 * - **multihop**: questions requiring connecting multiple facts (comparisons,
 *   change-over-time, relational queries with conjunctions)
 * - **synthesis**: open-ended requests ("summarize", "explain", "overview")
 *
 * Default: "factual" (the safest, most common retrieval pattern).
 */
export function classifyQueryIntent(query: string): QueryIntent {
  const q = query.toLowerCase().trim();

  // --- Synthesis signals ---
  const SYNTHESIS_PATTERNS = [
    /^\s*(summar\w+|explain|overview|tell me about|what do you know|describe|recap|review|elaborate)\b/,
    /\b(in general|overall|big picture|everything|all about)\b/,
  ];
  for (const pattern of SYNTHESIS_PATTERNS) {
    if (pattern.test(q)) return "synthesis";
  }

  // --- Multi-hop signals ---
  // Comparison or relational queries that need to connect facts
  const MULTIHOP_PATTERNS = [
    /\b(compare|comparison|vs\.?|versus|difference between|differ from)\b/,
    /\b(how .+ (relate|connect|compare|differ|depend).+)\b/,
    /\b(what changed|changes? since|since when|history of)\b/,
    /\b(which .+ (and|or) .+)/,
    // Two or more distinct entities joined by conjunction
    /\b\w+\s+(and|vs\.?)\s+\w+/,
  ];
  for (const pattern of MULTIHOP_PATTERNS) {
    if (pattern.test(q)) return "multihop";
  }

  // --- Factual signals (default) ---
  // Short, specific lookups: "what is/are X", "what's my Y", value retrieval
  return "factual";
}

/**
 * Intent-specific scoring presets tuned against APS-RAG findings
 * (arXiv:2607.19681 — query-type-adaptive reciprocal-rank fusion).
 *
 * APS-RAG's key insight: different query types benefit from different
 * dense/sparse fusion ratios. The presets below apply those ratios while
 * keeping all signals active (just re-weighted).
 *
 * Factual:  sparse:dense ≈ 4.7:1 (exact-term dominance, semantic = noise floor)
 * Multihop: sparse:dense ≈ 1.1:1 (balanced; connecting facts from both paths)
 * Synthesis: sparse:dense ≈ 0.44:1 (semantic dominance; paraphrase matters)
 */
const INTENT_SCORING_PRESETS: Record<QueryIntent, ScoringConfig> = {
  // Factual: BM25-dominant for exact term matching. Semantic kept low but
  // non-zero to catch paraphrase. Reliability boosted to surface confirmed
  // facts over tentative ones.
  factual: {
    ...DEFAULT_SCORING_CONFIG,
    weightBm25: 0.5,
    weightLexical: 0.2,
    weightSemantic: 0.15,
    weightTypedFactTierBoost: 0.2,
    weightLongTermTierBoost: 0.2,
    weightReliability: 0.15,
  },
  // Multi-hop: balanced dense/sparse fusion (~1:1). Goal-relevance and
  // information-gain boosted to surface connecting facts. Recency slightly
  // higher for temporal relationship queries.
  multihop: {
    ...DEFAULT_SCORING_CONFIG,
    weightBm25: 0.22,
    weightLexical: 0.18,
    weightSemantic: 0.35,
    weightGoalRelevance: 0.15,
    weightInformationGain: 0.08,
    weightLongTermTierBoost: 0.2,
    weightRecency: 0.08,
  },
  // Synthesis: semantic-dominant. Importance and information-gain boosted
  // to surface the most significant and novel facts. BM25 reduced to
  // near-floor since exact terms matter less for open-ended queries.
  synthesis: {
    ...DEFAULT_SCORING_CONFIG,
    weightBm25: 0.1,
    weightLexical: 0.12,
    weightSemantic: 0.5,
    weightImportance: 0.2,
    weightInformationGain: 0.08,
    weightLongTermTierBoost: 0.2,
  },
};

/**
 * Get the scoring config preset for a query intent.
 * Exported for testing and consumer inspection.
 */
export function getIntentScoringPreset(intent: QueryIntent): ScoringConfig {
  return INTENT_SCORING_PRESETS[intent];
}
import type { Storage } from "./storage.js";
import type {
  Insight,
  L2Fact,
  L3EpochFrontmatter,
  LongTermFact,
  LongTermTypedFact,
  MissingFact,
  RetrievalSignal,
  TypedFact,
} from "./types.js";

export type RetrievalTier =
  | "l2"
  | "longterm"
  | "longterm-typed"
  | "memory-core"
  | "typed"
  | "shared"
  | "procedural"
  | "insight";

/**
 * Minimal shape of memory-core's QMD search results that retrieval cares
 * about. Mirrors the public SDK type so callers can pass the SDK output
 * straight through.
 */
export type MemoryCoreSearchHit = {
  path: string;
  startLine: number;
  endLine?: number;
  score: number;
  snippet: string;
};

export type MemoryCoreLookup = (query: string) => Promise<MemoryCoreSearchHit[]>;

/**
 * Retrieval mode controls which scoring signals contribute to ranking.
 * - `'blended'` (default): BM25 + cosine semantic + other signals — current behavior.
 * - `'keyword'`: BM25 only (lexical/keyword retrieval, semantic zeroed).
 * - `'semantic'`: Cosine semantic only (embedding-based retrieval, BM25 zeroed).
 * - `'routed'`: SCM query-intent router classifies the query and selects a
 *   scoring preset (factual → BM25-heavy, multihop → balanced, synthesis →
 *   semantic-heavy). All signals stay active; only weights change.
 */
export type RetrievalMode = "blended" | "keyword" | "semantic" | "routed";

export type RetrievalConfig = {
  /**
   * When true, use epoch-first retrieval: score epoch summaries first, then
   * only expand the top N epochs for detailed scoring. Inspired by DeepSeek
   * V4's CSA (compressed sparse attention with top-k selector).
   *
   * False = full-scan all chunks (legacy behavior).
   * Default true.
   */
  useEpochFirst: boolean;
  /**
   * Number of top epochs to expand when epoch-first is enabled.
   * Default 3.
   */
  epochExpandTopN: number;
  /**
   * When true, replace greedy top-K sort+slice with a budgeted submodular
   * selector that optimises for relevance + diversity + query-token coverage.
   * Default false (gated for ablation evaluation).
   */
  useSubmodularSelect: boolean;
  /** Weight of diversity term in submodular objective (0–1). Default 0.3. */
  submodularDiversityWeight: number;
  /** Weight of coverage term in submodular objective (0–1). Default 0.3. */
  submodularCoverageWeight: number;
  /**
   * Token budget for submodular packing. When null, falls back to raw topK
   * count (legacy budget mode). Default null.
   */
  submodularTokenBudget: number | null;
  /**
   * Controls which scoring signals are active. Default 'blended' (current behavior).
   * - 'keyword': only BM25/lexical signals, semantic zeroed.
   * - 'semantic': only cosine embedding signal, BM25 zeroed.
   * - 'blended': full composite scoring.
   */
  mode: RetrievalMode;
  /**
   * When true, apply a post-retrieval critique filter that demotes
   * stale, low-reliability prose facts before context injection.
   * Typed facts (slot=value) are atomic and skip the critique.
   * Default false (opt-in). Inspired by arXiv:2607.28272.
   */
  enableMemoryCritique?: boolean;
  /**
   * Number of query-reformulation retry passes when the initial
   * retrieval top result score is below `reformulationThreshold`.
   * Each pass generates alternative queries and merges results.
   * Default 0 (disabled). Set via env or config to enable.
   *
   * Inspired by MemCon (arXiv:2607.27517) — iterative retrieval
   * with query reformulation improves recall on complex queries.
   */
  reformulationPasses?: number;
  /**
   * Certainty threshold below which reformulation is triggered.
   * If the top result's composite score is below this value,
   * alternative queries are attempted. Default 0.4.
   */
  reformulationThreshold?: number;
  /**
   * QW-1: When true, fuse BM25 and semantic signals via Reciprocal Rank
   * Fusion (RRF) instead of linear weighting. RRF is rank-based and
   * parameter-light (only k), making it robust to score-scale differences.
   * The RRF score replaces the bm25 + semantic contributions in the
   * composite. Default false.
   */
  useRRFFusion?: boolean;
  /**
   * QW-1: RRF k parameter. Smaller k gives more weight to top ranks.
   * Default 60 (standard in the literature).
   */
  rrfK?: number;
  /**
   * QW-2: Wall-clock timeout for retrieval scoring in milliseconds.
   * When set, the scoring loop checks elapsed time and bails out early
   * if exceeded, returning whatever has been scored so far (sorted).
   * This prevents retrieval from blocking on large stores or slow embeddings.
   * Default undefined (no timeout). Set to e.g. 5000 for a 5-second cap.
   */
  retrievalTimeoutMs?: number;
  /**
   * Token-budget guard for injected L3 context. When set, the retrieval
   * result is trimmed from the bottom (lowest-score facts first) so the
   * estimated formatted token cost stays within budget. Prevents context
   * flooding — the Information Abundance Paradox shows that injecting too
   * many facts degrades recall. Default undefined (no cap). Set to e.g.
   * 2000 for a 2K-token budget.
   */
  maxInjectedTokens?: number;
};

export const DEFAULT_RETRIEVAL_CONFIG: RetrievalConfig = {
  useEpochFirst: true,
  epochExpandTopN: 3,
  useSubmodularSelect: false,
  submodularDiversityWeight: 0.3,
  submodularCoverageWeight: 0.3,
  submodularTokenBudget: null,
  mode: "blended",
  enableMemoryCritique: false,
  reformulationPasses: 0,
  reformulationThreshold: 0.4,
  useRRFFusion: false,
  rrfK: 60,
};

export type RetrievedFact = {
  fact: L2Fact;
  score: number;
  signals: Signals;
  chunkId: string;
  tier: RetrievalTier;
  /** Number of messages in the buffer that produced this fact (L2 tier only).
   * Enables RaMem-style contextual reinstatement. */
  contextWindow?: number;
};

/**
 * Result from Sufficient Context Agent: includes retrieved facts plus
 * optional gap analysis and suggested follow-up queries.
 */
export type RetrievalResult = {
  facts: RetrievedFact[];
  /** Gap analysis from Sufficient Context Agent, if enabled. */
  missingInfo?: MissingFact;
  /** Whether query reformulation was triggered for this retrieval. */
  reformulated?: boolean;
};

// ---------------------------------------------------------------------------
// QW-1: Query Reformulation (MemCon-inspired)
// ---------------------------------------------------------------------------

/**
 * Stop words removed during heuristic query reformulation.
 */
const QUERY_STOP_WORDS = new Set([
  "what",
  "who",
  "where",
  "when",
  "why",
  "how",
  "is",
  "are",
  "was",
  "were",
  "the",
  "a",
  "an",
  "of",
  "in",
  "on",
  "at",
  "to",
  "for",
  "with",
  "and",
  "or",
  "not",
  "do",
  "does",
  "did",
  "can",
  "could",
  "should",
  "would",
  "will",
  "shall",
  "may",
  "might",
  "must",
  "about",
  "tell",
  "me",
]);

/**
 * Generate 2-3 heuristic query reformulations without an LLM call.
 * Strategies:
 * 1. **Core terms only** — strip stop words to get the essential content words.
 * 2. **Broader query** — use only the first 3-4 significant terms for a wider net.
 * 3. **Conjunction split** — if the query has "and"/"or", split into sub-queries.
 *
 * Returns an empty array if the heuristic can't produce useful variants
 * (e.g., the query is already a single word or all stop words).
 */
export function heuristicReformulate(query: string): string[] {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.replace(/[^\w:-]/g, ""))
    .filter(Boolean);
  const coreTerms = terms.filter((t) => !QUERY_STOP_WORDS.has(t));
  const variants: string[] = [];

  // Strategy 1: core terms only
  if (coreTerms.length > 0 && coreTerms.length < terms.length) {
    variants.push(coreTerms.join(" "));
  }

  // Strategy 2: broader query (first 3-4 significant terms)
  if (coreTerms.length > 4) {
    variants.push(coreTerms.slice(0, 3).join(" "));
  }

  // Strategy 3: conjunction split
  const conjunctionPattern = /\s+(?:and|or)\s+/i;
  if (conjunctionPattern.test(query)) {
    const parts = query
      .split(conjunctionPattern)
      .map((p) => p.trim())
      .filter(Boolean);
    // Only add parts that have core terms
    for (const part of parts) {
      const partCore = part
        .toLowerCase()
        .split(/\s+/)
        .filter((t) => !QUERY_STOP_WORDS.has(t));
      if (partCore.length > 0) {
        variants.push(partCore.join(" "));
      }
    }
  }

  // Deduplicate and limit to 3 variants
  const unique = [...new Set(variants)].filter((v) => v !== query.toLowerCase().trim());
  return unique.slice(0, 3);
}

/**
 * Generate query reformulations using an LLM caller.
 * Asks the LLM to produce 2-3 alternative phrasings of the query.
 * Returns parsed reformulations; empty array on failure.
 */
async function llmReformulate(
  query: string,
  caller: (params: { systemPrompt: string; userPrompt: string }) => Promise<string>,
): Promise<string[]> {
  const systemPrompt =
    "You are a search query reformulator. Given a user query, generate 2-3 alternative phrasings that might retrieve different relevant documents. Return ONLY the reformulations, one per line, no numbering or bullets.";
  const userPrompt = `Original query: ${query}\n\nAlternative phrasings:`;
  try {
    const response = await caller({ systemPrompt, userPrompt });
    return response
      .split("\n")
      .map((line) =>
        line
          .replace(/^\d+[.)]\s*/, "")
          .replace(/^[\-*]\s*/, "")
          .trim(),
      )
      .filter((line) => line.length > 0)
      .slice(0, 3);
  } catch {
    return [];
  }
}

export async function retrieveTopK(params: {
  query: string;
  storage: Storage;
  topK: number;
  now?: number;
  config?: ScoringConfig;
  retrievalConfig?: RetrievalConfig;
  /**
   * Optional adapter to memory-core's QMD search. When provided, results
   * participate in the unified top-K ranking alongside L2/long-term facts.
   * Inject in production (engine wires it via the plugin-sdk seam); leave
   * undefined in unit tests to focus on L3-only retrieval.
   */
  memoryCoreLookup?: MemoryCoreLookup;
  /**
   * Optional skill-forge directory path. When provided, promoted skills are
   * read and included as a procedural memory tier in retrieval.
   */
  skillForgeDir?: string;
  /**
   * Optional shared memory directory. When provided, cross-context facts
   * from other agents/sessions participate in retrieval.
   */
  sharedMemoryDir?: string;
  /**
   * Optional Hebbian config. Defaults to DEFAULT_HEBBIAN_CONFIG.
   */
  hebbianConfig?: HebbianConfig;
  /**
   * Pre-computed query embedding. When provided, facts with stored
   * embeddings get a cosine-similarity semantic signal added to their
   * composite score.
   */
  queryEmbedding?: number[];
  /**
   * When true, enables Sufficient Context Agent post-retrieval gap analysis.
   * Default true.
   */
  enableSufficientContext?: boolean;

  /**
   * When true, apply a passage-level information-density reranker to the
   * scored results before slicing top-K. Facts with higher named-entity
   * density and query novelty get a small score boost, promoting facts
   * that carry more actionable information per token. Default false.
   *
   * Inspired by RARG (arXiv:2607.24223) — passage-level signals improve
   * ranking when BM25 alone over-promotes lexically similar but
   * information-poor facts.
   */
  rerankByDensity?: boolean;

  /**
   * Weight of the density reranker adjustment (0–1). Default 0.15.
   */
  rerankDensityWeight?: number;
  /**
   * Optional LLM caller for query reformulation. When provided and
   * reformulationPasses > 0, the LLM generates alternative query phrasings
   * to improve recall. If not provided, only heuristic reformulation is used.
   */
  llmCaller?: (params: { systemPrompt: string; userPrompt: string }) => Promise<string>;
}): Promise<RetrievalResult> {
  const topK = Math.max(0, params.topK);
  if (topK === 0) {
    return { facts: [] };
  }
  const queryTokens = tokenize(params.query);
  if (queryTokens.size === 0) {
    return { facts: [] };
  }

  const paths = await params.storage.listL2ChunkPaths();
  if (paths.length === 0) {
    return { facts: [] };
  }

  const now = params.now ?? Date.now();
  const baseConfig = params.config ?? DEFAULT_SCORING_CONFIG;
  const retConfig = params.retrievalConfig ?? DEFAULT_RETRIEVAL_CONFIG;
  // SCM query-intent router: when mode is "routed", classify the query and
  // select a scoring preset. Caller-provided config still wins over presets
  // (explicit > routed > default).
  const config =
    retConfig.mode === "routed" && !params.config
      ? getIntentScoringPreset(classifyQueryIntent(params.query))
      : baseConfig;

  // -----------------------------------------------------------------
  // Epoch-first retrieval (DeepSeek V4 CSA-inspired)
  // -----------------------------------------------------------------
  // When enabled, score epoch summaries first (O(epochs), cheap), then
  // only expand facts from the top N epochs. This avoids O(all chunks)
  // file reads for mature agents with 50+ chunks.
  //
  // Long-term facts are always included (they're already promoted and
  // represent the most important tier). Epoch filtering only applies to
  // L2 chunks.
  const epochBoosts = await buildEpochBoostMap(params.storage, queryTokens);

  let candidatePaths: string[];
  if (retConfig.useEpochFirst) {
    candidatePaths = await selectEpochPaths(params.storage, queryTokens, retConfig.epochExpandTopN);
  } else {
    candidatePaths = paths;
  }

  // Corpus-callosum: load the canonical typed-fact view first so per-chunk
  // typed hits with the same slot can be suppressed. The canonical view
  // already represents the latest value across all chunks; surfacing both
  // would just be noise.
  const longtermTyped = await params.storage.readLongTermTyped();
  const canonicalSlots = new Set(longtermTyped.facts.filter((f) => !f.archived).map((f) => f.slot));

  // Phase 1: Collect all scorable items so we can compute corpus-wide BM25
  // stats before the scoring pass.
  type ScorableItem = {
    fact: L2Fact;
    chunkId: string;
    tier: RetrievalTier;
    l3Boost: number;
    /** For long-term/typed tiers: flat additive boost when lexical > 0. */
    tierBoost: number;
    /** Pre-computed embedding vector from LongTermFact.embedding, if present. */
    embedding?: number[];
    /** Source chunk's session-novelty metric (L2 tier only). */
    informationGain?: number;
    /** Number of messages in the buffer that produced this fact (L2 tier only). */
    contextWindow?: number;
    /** QW-4: Source trust for long-term typed facts. */
    sourceTrust?: import("./types.js").SourceTrust;
  };
  const items: ScorableItem[] = [];

  for (const filePath of candidatePaths) {
    const doc = await params.storage.readL2ChunkAtPath(filePath);
    if (!doc) {
      continue;
    }
    const chunkId = doc.frontmatter.id;
    const l3Boost = epochBoosts.get(chunkId) ?? 0;
    for (const fact of doc.frontmatter.facts) {
      items.push({
        fact,
        chunkId,
        tier: "l2",
        l3Boost,
        tierBoost: 0,
        informationGain: doc.frontmatter.informationGain,
        contextWindow: doc.frontmatter.contextWindow,
      });
    }
    for (const typed of doc.frontmatter.typedFacts ?? []) {
      if (canonicalSlots.has(typed.slot)) {
        continue;
      }
      items.push({
        fact: typedFactAsL2Fact(typed),
        chunkId,
        tier: "typed",
        l3Boost: 0,
        tierBoost: config.weightTypedFactTierBoost,
        contextWindow: doc.frontmatter.contextWindow,
      });
    }
  }

  // Long-term typed tier
  for (const ltt of longtermTyped.facts) {
    if (ltt.archived) {
      continue;
    }
    items.push({
      fact: longTermTypedAsL2Fact(ltt, now),
      chunkId: "longterm-typed",
      tier: "longterm-typed",
      l3Boost: 0,
      tierBoost: config.weightLongTermTierBoost,
      sourceTrust: ltt.sourceTrust,
    });
  }

  // Long-term prose tier
  const longterm = await params.storage.readLongTerm();
  for (const lt of longterm.facts) {
    if (lt.archived) {
      continue;
    }
    if (lt.supersededBy) {
      continue;
    }
    items.push({
      fact: longTermAsL2Fact(lt),
      chunkId: "longterm",
      tier: "longterm",
      l3Boost: 0,
      tierBoost: config.weightLongTermTierBoost,
      embedding: lt.embedding,
    });
  }

  // G1 reflection tier: synthesized insights participate in unified ranking like
  // any other fact (relevance-gated — an off-topic insight won't surface). Empty
  // until the reflection pass has run, so this is a no-op when reflection is off.
  const insightFm = await params.storage.readInsights();
  for (const ins of insightFm.insights) {
    items.push({
      fact: insightAsL2Fact(ins),
      chunkId: "insight",
      tier: "insight",
      l3Boost: 0,
      tierBoost: config.weightLongTermTierBoost,
    });
  }

  // Pre-load retrieval signals for stale-utility demotion (RMM-inspired).
  // Reused later for post-retrieval signal recording to avoid a second read.
  let preloadedSignals: RetrievalSignal[] = [];
  try {
    preloadedSignals = await params.storage.readRetrievalSignals();
  } catch {
    // Signal read is non-critical — demotion defaults to no-penalty when unavailable.
  }
  const retrievalSignalMap = new Map(preloadedSignals.map((s) => [s.factId, s]));

  // HyPE lookup: load hypothetical prompt embeddings once for the entire
  // retrieval pass. Used to boost semantic matching for facts that have
  // pre-generated hypothetical queries (Finding 9, 2026-08-03).
  let hypeLookup: Map<
    string,
    Array<{ factId: string; querySeq: number; queryText: string; embedding: number[] }>
  > | null = null;
  if (params.queryEmbedding) {
    try {
      const allHype = await params.storage.readAllHypeQueries();
      if (allHype.length > 0) {
        hypeLookup = buildHypeLookup(allHype);
      }
    } catch {
      // HyPE queries unavailable — semantic matching falls back to fact embeddings only.
    }
  }

  // Build corpus stats from all fact texts for BM25 IDF computation.
  const corpusStats: CorpusStats | undefined =
    config.weightBm25 > 0 ? buildCorpusStats(items.map((i) => i.fact.text)) : undefined;

  // Corpus-size-aware BM25 weight scaling (arXiv:2607.26497 — BM25 dominates
  // the Pareto frontier at scale). When the corpus exceeds a configurable
  // fact-count threshold, scale weightBm25 upward so rare-term lexical
  // matches dominate over semantic noise. Below the threshold, current
  // weights are validated and unchanged.
  let effectiveConfig = config;
  if (
    corpusStats &&
    corpusStats.total > 0 &&
    config.weightBm25 > 0 &&
    (config.corpusSizeBm25Threshold ?? 50_000) > 0 &&
    corpusStats.total >= (config.corpusSizeBm25Threshold ?? 50_000)
  ) {
    const scaleFactor = config.corpusSizeBm25ScaleFactor ?? 1.5;
    if (scaleFactor > 1.0) {
      effectiveConfig = {
        ...config,
        weightBm25: config.weightBm25 * scaleFactor,
      };
    }
  }

  // Phase 2: Score all items using composite + tier boosts.
  // Two-phase: first collect signals for all items, then optionally apply
  // RRF fusion before computing final composite scores.
  type PrescoredItem = {
    item: ScorableItem;
    signals: Signals;
  };
  const prescored: PrescoredItem[] = [];

  // QW-2: Wall-clock deadline for scoring. When set, bail out of the scoring
  // loop early if the deadline is exceeded. Items not scored are simply
  // absent from results — partial results are better than blocking.
  const scoringDeadline =
    retConfig.retrievalTimeoutMs && retConfig.retrievalTimeoutMs > 0
      ? Date.now() + retConfig.retrievalTimeoutMs
      : null;

  for (const item of items) {
    // Check deadline before scoring each item (avoids per-item timer overhead)
    if (scoringDeadline !== null && Date.now() > scoringDeadline) {
      if (process.env.OPENCLAW_MEMORY_L3_DEBUG === "1") {
        console.error(
          `[memory-l3/retrieval] scoring timeout (${retConfig.retrievalTimeoutMs}ms) reached after ${prescored.length} items`,
        );
      }
      break;
    }
    const signals = scoreFact({
      queryTokens,
      fact: item.fact,
      now,
      config: effectiveConfig,
      l3Boost: item.l3Boost,
      corpusStats,
      significant: item.fact.significant,
      informationGain: item.informationGain,
      sourceTrust: item.sourceTrust,
    });
    // Add embedding-based semantic signal when both query and fact have vectors
    if (
      params.queryEmbedding &&
      item.embedding &&
      params.queryEmbedding.length === item.embedding.length
    ) {
      signals.semantic = cosineSimilarity(params.queryEmbedding, item.embedding);
    }
    // HyPE boost: if we have a query embedding and HyPE queries for this fact,
    // take the max semantic signal across fact embedding + hypothetical queries.
    // This improves recall for phrasings that differ from how the fact was stored.
    if (params.queryEmbedding && hypeLookup) {
      const hypeQueries = hypeLookup.get(item.fact.id);
      if (hypeQueries && hypeQueries.length > 0) {
        const hypeSim = bestHypeMatch(
          params.queryEmbedding,
          hypeQueries.map((q) => ({ embedding: q.embedding })),
        );
        // Take the max of existing semantic and best HyPE match
        signals.semantic = Math.max(signals.semantic, hypeSim);
      }
    }
    // Apply retrieval mode: zero out signals not relevant to the selected mode
    if (retConfig.mode === "keyword") {
      signals.semantic = 0;
    } else if (retConfig.mode === "semantic") {
      signals.bm25 = 0;
      signals.lexical = 0;
    }
    prescored.push({ item, signals });
  }

  // QW-1: Reciprocal Rank Fusion — when enabled, fuse BM25 and semantic
  // rankings via RRF instead of linear weighting. The RRF score replaces
  // the bm25 + semantic contributions in the composite. Other signals
  // (importance, recency, reliability, etc.) still apply additively.
  let rrfScores: Map<string, number> | null = null;
  if (retConfig.useRRFFusion && prescored.length > 0) {
    const k = retConfig.rrfK ?? 60;
    // Build ranked lists from bm25 and semantic signals.
    const bm25Scores = new Map<string, number>();
    const semanticScores = new Map<string, number>();
    for (const ps of prescored) {
      bm25Scores.set(ps.item.fact.id, ps.signals.bm25);
      semanticScores.set(ps.item.fact.id, ps.signals.semantic);
    }
    const bm25Ranking = rankByScore(bm25Scores);
    const semanticRanking = rankByScore(semanticScores);
    rrfScores = rrfFuse([bm25Ranking, semanticRanking], k);
  }

  const scored: RetrievedFact[] = [];
  for (const { item, signals } of prescored) {
    let baseScore: number;
    if (rrfScores) {
      // RRF mode: replace bm25 + semantic weighted contributions with the
      // RRF fused score (normalized to 0-1 range), then add the remaining
      // signal contributions from the composite.
      const rrfScore = rrfScores.get(item.fact.id) ?? 0;
      // Compute composite with bm25 and semantic zeroed out (they're
      // replaced by RRF), then add RRF as an additive bonus scaled to
      // the same range as the zeroed contributions.
      const adjustedSignals: Signals = {
        ...signals,
        bm25: 0,
        semantic: 0,
      };
      const zeroedWeights = effectiveConfig.weightBm25 + effectiveConfig.weightSemantic;
      baseScore = composite(adjustedSignals, effectiveConfig) + rrfScore * zeroedWeights;
    } else {
      baseScore = composite(signals, effectiveConfig);
    }
    const rawScore = signals.lexical > 0 ? baseScore + item.tierBoost : baseScore;
    // Stale-utility demotion: facts never retrieved across multiple epochs
    // get their composite score multiplied down to reflect low demonstrated
    // utility (RMM — arXiv:2607.19873).
    const demotion = staleDemotionMultiplier({
      recallCount: retrievalSignalMap.get(item.fact.id)?.recallCount ?? 0,
      ageMs: now - item.fact.createdAt,
      config,
    });
    const score = rawScore * demotion;
    if (score > 0) {
      scored.push({
        fact: item.fact,
        score,
        signals,
        chunkId: item.chunkId,
        tier: item.tier,
        contextWindow: item.contextWindow,
      });
    }
  }

  // Memory-core cross-store tier — query QMD for results from MEMORY.md /
  // memory/*.md / DREAMS.md and merge into our ranking. Failures are
  // swallowed; the L3 tiers still produce a result.
  if (params.memoryCoreLookup) {
    try {
      const hits = await params.memoryCoreLookup(params.query);
      for (const hit of hits) {
        const fact: L2Fact = {
          id: `mc-${hit.path}-${hit.startLine}`,
          text: hit.snippet,
          importance: 0.5,
          createdAt: now,
          dedupKey: `memory-core:${hit.path}:${hit.startLine}`,
        };
        const score = hit.score * config.weightMemoryCoreTierMultiplier;
        if (score <= 0) {
          continue;
        }
        scored.push({
          fact,
          score,
          signals: {
            lexical: hit.score,
            bm25: 0,
            importance: 0.5,
            recency: 1,
            l3Boost: 0,
            semantic: 0,
            informationGain: 0,
            goalRelevance: 0,
            reliability: 0,
            semanticEntropy: 1,
            validity: 1,
            entityScore: 0,
            polarityMultiplier: 1,
          },
          chunkId: hit.path,
          tier: "memory-core",
        });
      }
    } catch {
      // Memory-core unavailable or threw — skip the tier silently.
    }
  }

  // Procedural memory tier (ZenBrain Layer 5) — read skill-forge promoted
  // skills and add them to the ranking. Each skill's FSRS retrievability
  // is based on usageCount with a longer 30-day half-life.
  if (params.skillForgeDir) {
    try {
      const skills = await readPromotedSkills(params.skillForgeDir);
      for (const skill of skills) {
        const fact = proceduralFactAsL2Fact(skill);
        const signals = scoreFact({
          queryTokens,
          fact,
          now,
          config: effectiveConfig,
          l3Boost: 0,
          corpusStats,
          recallCount: Math.max(1, skill.usageCount),
        });
        const baseScore = composite(signals, effectiveConfig);
        const recency = fsrsProceduralRetrievability(skill, now);
        const score =
          baseScore +
          (signals.lexical > 0 ? effectiveConfig.weightLongTermTierBoost : 0) +
          recency * effectiveConfig.weightRecency;
        if (score > 0) {
          scored.push({
            fact,
            score,
            signals,
            chunkId: `procedural:${skill.skillName}`,
            tier: "procedural",
          });
        }
      }
    } catch {
      // Skill-forge directory unavailable — skip tier.
    }
  }

  // Cross-context shared memory tier (ZenBrain Layer 7) — read shared
  // facts published by other agents/sessions and include in ranking.
  if (params.sharedMemoryDir) {
    try {
      const shared = await readSharedFacts(params.sharedMemoryDir);
      for (const sf of shared) {
        if (sf.archived) {
          continue;
        }
        const fact: L2Fact = {
          id: sf.id,
          text: sf.text,
          importance: sf.importance,
          createdAt: sf.lastConfirmedAt,
          dedupKey: sf.dedupKey,
        };
        const signals = scoreFact({
          queryTokens,
          fact,
          now,
          config: effectiveConfig,
          l3Boost: 0,
          corpusStats,
          recallCount: sf.recallCount,
        });
        const baseScore = composite(signals, effectiveConfig);
        const score =
          signals.lexical > 0 ? baseScore + effectiveConfig.weightLongTermTierBoost : baseScore;
        if (score > 0) {
          scored.push({
            fact,
            score,
            signals,
            chunkId: `shared:${sf.sourceAgentId}`,
            tier: "shared",
          });
        }
      }
    } catch {
      // Shared memory unavailable — skip tier.
    }
  }

  // -----------------------------------------------------------------
  // Retrieval signal recording (Phase 3: dynamic importance)
  // -----------------------------------------------------------------
  // Record which facts were retrieved so consolidation can adjust
  // importance based on retrieval frequency. Non-fatal — signal
  // recording failure must not block retrieval.
  scored.sort((a, b) => b.score - a.score);
  const topForSignals = scored.slice(0, topK);
  try {
    if (topForSignals.length > 0) {
      const existingMap = new Map(preloadedSignals.map((s) => [s.factId, s]));
      const updated = recordRetrievalSignals(
        existingMap,
        topForSignals.map((f) => f.fact.id),
        now,
      );
      await params.storage.writeRetrievalSignals([...updated.values()]);
    }
  } catch {
    // Signal recording is non-critical — skip silently
  }

  // Hebbian neighbor boosting — facts that co-occur frequently across chunks
  // get a small additive boost when their neighbors score high.
  const hConfig = params.hebbianConfig ?? DEFAULT_HEBBIAN_CONFIG;
  // Hoisted so both the boost (re-rank) and the post-slice expansion
  // (pattern completion) can reuse it without a second edge-map read.
  let edgeLookup: Map<string, HebbianEdge[]> | null = null;
  if (hConfig.enabled && scored.length > 0) {
    try {
      const edgeRaw = await params.storage.readEdgeMap();
      const edges = Array.isArray(edgeRaw) ? (edgeRaw as HebbianEdge[]) : [];
      if (edges.length > 0) {
        edgeLookup = buildEdgeLookup(edges);
        const baseScores = new Map<string, number>();
        for (const item of scored) {
          baseScores.set(item.fact.dedupKey, item.score);
        }
        for (const item of scored) {
          const boost = hebbianBoost(item.fact.dedupKey, edgeLookup, baseScores, hConfig);
          if (boost > 0) {
            item.score += boost;
          }
        }
      }
    } catch {
      // Edge map read failed — skip Hebbian boosting.
    }
  }

  scored.sort((a, b) => b.score - a.score);

  // -----------------------------------------------------------------
  // Passage-level information-density reranker (RARG-inspired)
  // -----------------------------------------------------------------
  // Optionally nudge rankings based on entity density and query novelty.
  // Conservative multiplicative adjustment — nudges, never inverts.
  if (params.rerankByDensity) {
    rerankByInformationDensity(scored, params.query, params.rerankDensityWeight ?? 0.15);
  }

  // -----------------------------------------------------------------
  // Post-retrieval critique filter (arXiv:2607.28272 — Reconstructive Memory)
  // -----------------------------------------------------------------
  // Demotes prose facts that are both epistemically stale (low validity)
  // and unreliable (low certainty). Typed facts (slot=value) are atomic
  // and skip the critique — their confidence is already decayed via
  // access-time decay. Only runs when enableMemoryCritique is true.
  if (retConfig.enableMemoryCritique) {
    critiqueStaleFacts(scored);
  }

  // -----------------------------------------------------------------
  // Submodular fact packing (arXiv:2607.00725 — budgeted monotone
  // submodular maximisation for RAG context packing)
  // -----------------------------------------------------------------
  // When enabled, replace greedy top-K slice with a greedy submodular
  // selector that optimises relevance + diversity + query-token coverage
  // under a token budget.  Gated behind useSubmodularSelect so it can be
  // ablated against the legacy sort+slice baseline.
  let result: RetrievedFact[];
  if (retConfig.useSubmodularSelect) {
    result = submodularSelect(
      scored,
      queryTokens,
      topK,
      retConfig.submodularDiversityWeight,
      retConfig.submodularCoverageWeight,
      retConfig.submodularTokenBudget,
    );
  } else {
    result = scored.slice(0, topK);
  }

  // -----------------------------------------------------------------
  // Message-chunk fallback (Phase 3)
  // -----------------------------------------------------------------
  // When top-K is sparse (< topK/2 results from fact tiers), expand
  // search into raw message-level chunks. This catches relevant
  // conversation context that wasn't captured as structured facts.
  if (params.queryEmbedding && result.length < Math.ceil(topK / 2)) {
    try {
      const msgChunkIds = await params.storage.listMessageChunkIds();
      for (const cid of msgChunkIds) {
        const chunks = await params.storage.readMessageChunks(cid);
        for (const chunk of chunks) {
          if (!chunk.embedding || chunk.embedding.length !== params.queryEmbedding.length) {
            continue;
          }
          const sim = cosineSimilarity(params.queryEmbedding, chunk.embedding);
          if (sim < 0.3) {
            continue;
          } // Minimum relevance threshold
          result.push({
            fact: {
              id: chunk.id,
              text: chunk.text.slice(0, 200) + (chunk.text.length > 200 ? "..." : ""),
              importance: 0.3,
              createdAt: chunk.createdAt,
              dedupKey: `msg-chunk:${chunk.id}`,
            },
            score: sim * 0.5, // Scale down — message chunks are supplementary
            signals: {
              lexical: 0,
              bm25: 0,
              importance: 0.3,
              recency: 1,
              l3Boost: 0,
              semantic: sim,
              informationGain: 0,
              goalRelevance: 0,
              reliability: 0,
              semanticEntropy: 1,
              validity: 1,
              entityScore: 0,
              polarityMultiplier: 1,
            },
            chunkId: cid,
            tier: "l2" as RetrievalTier,
          });
        }
      }
      // Re-sort after message chunk expansion
      result.sort((a, b) => b.score - a.score);
    } catch {
      // Message chunk search failed — return fact-based results as-is
    }
  }

  // -----------------------------------------------------------------
  // QW-1: Query reformulation pass (MemCon-inspired)
  // -----------------------------------------------------------------
  // When the initial retrieval has low certainty (top result score below
  // threshold), try reformulated queries to improve recall. Results from
  // reformulated queries are merged into the candidate pool — only facts
  // not already in the result set are added, and their score is discounted
  // to prioritize direct matches.
  const reformulationPasses =
    retConfig.reformulationPasses ??
    (process.env.OPENCLAW_MEMORY_L3_QUERY_REFORMULATION === "1" ? 1 : 0);
  const reformulationThreshold = retConfig.reformulationThreshold ?? 0.4;
  let reformulated = false;
  if (
    reformulationPasses > 0 &&
    result.length > 0 &&
    result[0] &&
    result[0].score < reformulationThreshold
  ) {
    // Gather reformulated queries
    const reformulations: string[] = [];
    // Heuristic reformulation (zero-cost)
    reformulations.push(...heuristicReformulate(params.query));
    // LLM-based reformulation (optional)
    if (params.llmCaller && reformulations.length < 3) {
      const llmVariants = await llmReformulate(params.query, params.llmCaller);
      for (const v of llmVariants) {
        if (reformulations.length >= 3) break;
        reformulations.push(v);
      }
    }

    // Re-score with each reformulated query and merge new facts
    if (reformulations.length > 0) {
      reformulated = true;
      const existingKeys = new Set(result.map((r) => r.fact.dedupKey));
      const newResults: RetrievedFact[] = [];

      for (const reformQuery of reformulations) {
        const reformTokens = tokenize(reformQuery);
        if (reformTokens.size === 0) continue;

        // Re-score all items with the reformulated query
        for (const item of items) {
          // Skip items already in results
          if (existingKeys.has(item.fact.dedupKey)) continue;

          const signals = scoreFact({
            queryTokens: reformTokens,
            fact: item.fact,
            now,
            config: effectiveConfig,
            l3Boost: item.l3Boost,
            corpusStats,
            significant: item.fact.significant,
            informationGain: item.informationGain,
          });

          if (
            params.queryEmbedding &&
            item.embedding &&
            params.queryEmbedding.length === item.embedding.length
          ) {
            signals.semantic = cosineSimilarity(params.queryEmbedding, item.embedding);
          }

          // Apply same mode filtering as initial pass
          if (retConfig.mode === "keyword") {
            signals.semantic = 0;
          } else if (retConfig.mode === "semantic") {
            signals.bm25 = 0;
            signals.lexical = 0;
          }

          const baseScore = composite(signals, effectiveConfig);
          const rawScore = signals.lexical > 0 ? baseScore + item.tierBoost : baseScore;
          // Discount reformulated hits — they matched an alternative phrasing,
          // not the original query. 0.7 keeps them relevant but below direct hits.
          const score = rawScore * 0.7;

          if (score > 0) {
            newResults.push({
              fact: item.fact,
              score,
              signals,
              chunkId: item.chunkId,
              tier: item.tier,
              contextWindow: item.contextWindow,
            });
            existingKeys.add(item.fact.dedupKey);
          }
        }
      }

      // Merge new results into the candidate pool and re-sort
      if (newResults.length > 0) {
        result.push(...newResults);
        result.sort((a, b) => b.score - a.score);
      }
    }
  }

  const finalFacts = result.slice(0, topK);

  // -----------------------------------------------------------------
  // Access-time tracking for typed facts (SaliMory-style decay)
  // -----------------------------------------------------------------
  // Update lastAccessedAt on retrieved typed facts so the access-time
  // decay accurately reflects recent retrieval. Non-fatal — failure must
  // not block retrieval.
  try {
    const retrievedTypedSlots = finalFacts
      .filter((r) => r.tier === "longterm-typed")
      .map((r) => r.fact.dedupKey);
    if (retrievedTypedSlots.length > 0) {
      const lttFrontmatter = await params.storage.readLongTermTyped();
      let mutated = false;
      for (const fact of lttFrontmatter.facts) {
        if (!fact.archived && retrievedTypedSlots.includes(fact.slot)) {
          fact.lastAccessedAt = now;
          mutated = true;
        }
      }
      if (mutated) {
        await params.storage.writeLongTermTyped(lttFrontmatter, formatBody(lttFrontmatter.facts));
      }
    }
  } catch {
    // Access-time update is non-critical — skip silently.
  }

  // G4 pattern completion: append edge-neighbors of the strongest results as
  // bonus "completions" — even if they ranked below top-K or didn't match the
  // query — so a partial cue surfaces the rest of an associated memory
  // (CA3-style). Off when expandTopN=0. Neighbors come from the already-
  // collected candidate set (no extra storage reads); each gets a real signal
  // set but an association-derived score so a downstream sort keeps it below
  // genuine matches.
  if (hConfig.expandTopN > 0 && edgeLookup && finalFacts.length > 0) {
    const present = new Set(finalFacts.map((r) => r.fact.dedupKey));
    const candidateByKey = new Map<string, ScorableItem>();
    for (const it of items) {
      if (!candidateByKey.has(it.fact.dedupKey)) {
        candidateByKey.set(it.fact.dedupKey, it);
      }
    }
    for (const hit of finalFacts.slice(0, hConfig.expandTopN)) {
      for (const edge of edgeLookup.get(hit.fact.dedupKey) ?? []) {
        const neighborKey = edge.a === hit.fact.dedupKey ? edge.b : edge.a;
        if (present.has(neighborKey)) {
          continue;
        }
        const cand = candidateByKey.get(neighborKey);
        if (!cand) {
          continue;
        }
        present.add(neighborKey);
        const weightNorm = Math.min(edge.weight, hConfig.maxEdgeWeight) / hConfig.maxEdgeWeight;
        const signals = scoreFact({
          queryTokens,
          fact: cand.fact,
          now,
          config,
          l3Boost: cand.l3Boost,
          corpusStats,
          significant: cand.fact.significant,
          informationGain: cand.informationGain,
        });
        finalFacts.push({
          fact: cand.fact,
          score: hit.score * weightNorm * hConfig.expansionFactor,
          signals,
          chunkId: cand.chunkId,
          tier: cand.tier,
        });
      }
    }
  }

  // -----------------------------------------------------------------
  // Retrieval-time Hebbian edge strengthening (AtomMem-style)
  // -----------------------------------------------------------------
  // Facts that surface together in the same retrieval result strengthen
  // their associative link even when they come from different chunks.
  // This bridges the gap left by same-chunk co-occurrence extraction.
  try {
    const edgeRaw = await params.storage.readEdgeMap();
    const existingEdges = Array.isArray(edgeRaw) ? (edgeRaw as HebbianEdge[]) : [];
    const newEdges = extractEdgesFromRetrieval(finalFacts);
    if (newEdges.length > 0) {
      const merged = mergeEdges(existingEdges, newEdges);
      await params.storage.writeEdgeMap(merged);
    }
  } catch {
    // Edge strengthening is non-critical — skip silently
  }

  // -----------------------------------------------------------------
  // Sufficient Context Agent (gap analysis)
  // -----------------------------------------------------------------
  // Post-retrieval sufficiency check: compare what the query asked for
  // against what we actually retrieved, trigger follow-up searches for gaps.
  const missingInfo =
    params.enableSufficientContext !== false
      ? await checkSufficientContext(params.query, finalFacts)
      : undefined;

  // -----------------------------------------------------------------
  // REFACT-style adaptive fact compression (arXiv:2507.15147)
  // -----------------------------------------------------------------
  // Adaptively compress fact text based on query intent so the caller
  // gets the right level of detail without wasting context budget:
  // - factual: typed facts are already concise; trim prose to 1st sentence
  // - multihop: keep typed facts full; condense prose to 2 sentences
  // - synthesis: keep prose full; typed facts already compact (slot=value)
  // Only routed mode carries an intent signal. Every other mode (including the
  // "blended" default) has none, so it must fall back to the LOSSLESS setting —
  // defaulting to "factual" would silently truncate every prose fact to its
  // first sentence on the default retrieval path.
  const intent: QueryIntent =
    retConfig.mode === "routed" ? classifyQueryIntent(params.query) : "synthesis";
  const compressedFacts = compressFactsForResult(finalFacts, intent);

  // Token-budget guard: trim lowest-score facts to stay within budget.
  // Prevents the Information Abundance Paradox — flooding context with too
  // many facts degrades parametric recall. Estimate ~4 chars/token, plus
  // ~20 chars overhead per fact line (marker, score, age annotation).
  const maxTokens = retConfig.maxInjectedTokens;
  const budgetedFacts =
    maxTokens !== undefined && maxTokens > 0
      ? trimToTokenBudget(compressedFacts, maxTokens)
      : compressedFacts;

  return { facts: budgetedFacts, missingInfo, reformulated };
}

/**
 * Token-budget trim: removes facts from the bottom (lowest score) until the
 * estimated formatted token cost fits within budget. Each fact contributes
 * roughly `(text.length + 20) / 4` tokens (accounting for the line marker,
 * score, and age annotation added by formatMemorySection).
 */
function trimToTokenBudget(facts: RetrievedFact[], maxTokens: number): RetrievedFact[] {
  if (facts.length === 0) {
    return facts;
  }
  // Preclude overhead from the prelude (~60 tokens).
  const PRELUDE_TOKENS = 60;
  let remaining = maxTokens - PRELUDE_TOKENS;
  if (remaining <= 0) {
    return [];
  }
  // Facts are already sorted by score descending (same order as topK slice).
  // Greedily pack from the top until we exhaust the budget.
  const result: RetrievedFact[] = [];
  for (const rf of facts) {
    const lineTokens = Math.ceil((rf.fact.text.length + 20) / 4);
    if (lineTokens > remaining && result.length > 0) {
      break; // stop when adding this fact would exceed budget
    }
    result.push(rf);
    remaining -= lineTokens;
  }
  return result;
}

/**
 * REFACT-style adaptive fact compression: trim fact text based on query
 * intent so the caller receives the appropriate level of detail.
 *
 * - **factual**: typed/longterm-typed facts are already concise
 *   ("slot = value"); trim L2 prose to the first sentence only.
 * - **multihop**: keep typed facts full (they connect entities);
 *   condense prose facts to the first 2 sentences.
 * - **synthesis**: keep prose facts full (they carry narrative context);
 *   typed facts are already one-liners — no further compression.
 *
 * This is a pure output-formatting layer. Internal processing (Hebbian
 * boosting, edge extraction, signal recording) always sees the full text.
 */
function compressFactsForResult(facts: RetrievedFact[], intent: QueryIntent): RetrievedFact[] {
  if (intent === "synthesis") {
    // Prose is the hero; typed facts are already compact. No compression needed.
    return facts;
  }

  const typedTiers = new Set<string>(["typed", "longterm-typed"]);

  return facts.map((rf) => {
    // Typed facts: already "slot = value" — keep as-is for all intents.
    if (typedTiers.has(rf.tier)) {
      return rf;
    }

    // Prose facts: compress based on intent.
    const maxSentences = intent === "factual" ? 1 : 2; // multihop → 2
    const compressedText = truncateToSentences(rf.fact.text, maxSentences);
    if (compressedText === rf.fact.text) {
      return rf; // No change — text was already short enough
    }
    return {
      ...rf,
      fact: { ...rf.fact, text: compressedText },
    };
  });
}

/**
 * Truncate a text block to the first N sentences. If the text has fewer
 * than N sentence boundaries, returns it unchanged.
 */
function truncateToSentences(text: string, maxSentences: number): string {
  if (maxSentences <= 0) return text;
  // Split on sentence boundaries: ., !, ? followed by whitespace or end.
  const sentences: string[] = [];
  let current = "";
  let truncated = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    current += char;
    const next = text[i + 1];
    if ((char === "." || char === "!" || char === "?") && (next === undefined || /\s/.test(next))) {
      sentences.push(current.trim());
      current = "";
      if (sentences.length >= maxSentences) {
        // Check if there's remaining content — if not, text was exactly N sentences.
        const remaining = text.slice(i + 1).trim();
        if (!remaining) return text;
        truncated = true;
        break;
      }
    }
  }
  if (!truncated && current.trim()) {
    sentences.push(current.trim());
  }
  if (!truncated && sentences.length <= maxSentences) {
    return text; // Already short enough
  }
  return sentences.slice(0, maxSentences).join(" ") + " …";
}

function longTermAsL2Fact(lt: LongTermFact): L2Fact {
  return {
    id: lt.id,
    text: lt.text,
    importance: lt.importance,
    createdAt: lt.lastConfirmedAt,
    dedupKey: lt.dedupKey,
    polarity: lt.polarity,
  };
}

function insightAsL2Fact(ins: Insight): L2Fact {
  return {
    id: ins.id,
    text: ins.text,
    importance: ins.importance,
    createdAt: ins.createdAt,
    dedupKey: `insight:${ins.id}`,
  };
}

/**
 * Render a typed fact as L2Fact-shaped so it flows through the existing
 * composite-score pipeline. Text combines slot + value (+ unit) so lexical
 * matching catches both "what's my pi-hole IP" (slot tokens) and
 * "192.168.50.128" (value tokens). Confidence stands in for importance.
 */
function typedFactAsL2Fact(typed: TypedFact): L2Fact {
  const text = typed.unit
    ? `${typed.slot} = ${typed.value} ${typed.unit}`
    : `${typed.slot} = ${typed.value}`;
  return {
    id: typed.id,
    text,
    importance: typed.confidence,
    createdAt: typed.lastVerifiedAt ?? typed.createdAt,
    dedupKey: typed.slot,
    // Failure-avoidance typed facts get significance for FSRS slower decay.
    significant: typed.slot.startsWith("failure:") || undefined,
    // Propagate episodic context for RaMem-style validity scoring.
    eventTime: typed.eventTime,
    sessionId: typed.sessionId,
    participants: typed.participants,
  };
}

function longTermTypedAsL2Fact(ltt: LongTermTypedFact, now: number): L2Fact {
  const text = ltt.unit ? `${ltt.slot} = ${ltt.value} ${ltt.unit}` : `${ltt.slot} = ${ltt.value}`;
  const decayedConfidence = typedFactAccessDecay(ltt.confidence, ltt.lastAccessedAt, now);
  return {
    id: ltt.id,
    text,
    importance: decayedConfidence,
    createdAt: ltt.lastVerifiedAt ?? ltt.lastConfirmedAt,
    dedupKey: ltt.slot,
    // Failure-avoidance typed facts get significance for FSRS slower decay.
    significant: ltt.slot.startsWith("failure:") || undefined,
  };
}

/** Default half-life for typed-fact access-time decay, in days.
 *  Typed facts are canonical and more stable than L2 facts, so they
 *  decay more slowly (30 days vs 7 days for L2 recency). */
const TYPED_FACT_ACCESS_HALF_LIFE_DAYS = 30;

/**
 * Apply access-time decay to a typed fact's confidence.
 * Facts that haven't been retrieved recently lose confidence over time.
 * Formula: confidence * exp(-ageDays / halfLife)
 */
function typedFactAccessDecay(
  confidence: number,
  lastAccessedAt: number | undefined,
  now: number,
): number {
  // Backward-compat: facts created before this field existed start with
  // no decay (treat as just-accessed). They begin decaying from their
  // first retrieval after this code is active.
  const effectiveLastAccess = lastAccessedAt ?? now;
  const ageMs = Math.max(0, now - effectiveLastAccess);
  const ageDays = ageMs / MS_PER_DAY;
  return confidence * Math.exp(-ageDays / TYPED_FACT_ACCESS_HALF_LIFE_DAYS);
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
  if (paths.length === 0) {
    return out;
  }
  for (const filePath of paths) {
    const doc = await storage.readL3EpochAtPath(filePath);
    if (!doc) {
      continue;
    }
    const epochScore = scoreEpochAgainstQuery(doc.frontmatter, queryTokens);
    if (epochScore <= 0) {
      continue;
    }
    const startSeq = chunkSeq(doc.frontmatter.startChunkId);
    const endSeq = chunkSeq(doc.frontmatter.endChunkId);
    if (startSeq === null || endSeq === null) {
      continue;
    }
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
  if (rangeMap.size === 0) {
    return new Map();
  }
  const ranges: Array<{ start: number; end: number; score: number }> = [];
  for (const [key, score] of rangeMap) {
    const m = /^__range__(\d+)_(\d+)$/.exec(key);
    const startStr = m?.[1];
    const endStr = m?.[2];
    if (startStr === undefined || endStr === undefined) {
      continue;
    }
    ranges.push({ start: Number.parseInt(startStr, 10), end: Number.parseInt(endStr, 10), score });
  }
  const out = new Map<string, number>();
  const paths = await storage.listL2ChunkPaths();
  for (const filePath of paths) {
    const doc = await storage.readL2ChunkAtPath(filePath);
    if (!doc) {
      continue;
    }
    const seq = chunkSeq(doc.frontmatter.id);
    if (seq === null) {
      continue;
    }
    let best = 0;
    for (const range of ranges) {
      if (seq >= range.start && seq <= range.end && range.score > best) {
        best = range.score;
      }
    }
    if (best > 0) {
      out.set(doc.frontmatter.id, best);
    }
  }
  return out;
}

function scoreEpochAgainstQuery(epoch: L3EpochFrontmatter, queryTokens: Set<string>): number {
  if (epoch.representativeFacts.length === 0) {
    return 0;
  }
  const epochText = epoch.representativeFacts.map((f) => f.text).join(" ");
  return jaccard(queryTokens, tokenize(epochText));
}

/**
 * Epoch-first path selection (DeepSeek V4 CSA-inspired).
 *
 * Score epoch summaries against the query, then return only the L2 chunk
 * paths that belong to the top N scoring epochs. This reduces the number
 * of file reads from O(all chunks) to O(top-epochs × chunks-per-epoch),
 * which is ~5-10× fewer reads for mature agents.
 *
 * Always includes the most recent EPOCH_CHUNK_THRESHOLD chunks regardless
 * of epoch scoring — recent context should never be filtered out.
 */
async function selectEpochPaths(
  storage: Storage,
  queryTokens: Set<string>,
  topN: number,
): Promise<string[]> {
  const allPaths = await storage.listL2ChunkPaths();
  if (allPaths.length === 0) {
    return [];
  }

  // Few chunks — not worth filtering, just return everything
  if (allPaths.length <= 8) {
    return allPaths;
  }

  // Score each epoch
  const epochPaths = await storage.listL3EpochPaths();
  if (epochPaths.length === 0) {
    return allPaths;
  } // No epochs yet

  const scored: Array<{ score: number; startSeq: number; endSeq: number }> = [];
  for (const epPath of epochPaths) {
    const doc = await storage.readL3EpochAtPath(epPath);
    if (!doc) {
      continue;
    }
    const startSeq = chunkSeq(doc.frontmatter.startChunkId);
    const endSeq = chunkSeq(doc.frontmatter.endChunkId);
    if (startSeq === null || endSeq === null) {
      continue;
    }
    const score = scoreEpochAgainstQuery(doc.frontmatter, queryTokens);
    scored.push({ score, startSeq, endSeq });
  }

  // Sort by score descending, take top N
  scored.sort((a, b) => b.score - a.score);
  const topEpochs = scored.slice(0, topN);

  // Also always include the last epoch's worth of chunks (recency bias)
  const lastChunk = allPaths[allPaths.length - 1];
  const lastDoc = lastChunk ? await storage.readL2ChunkAtPath(lastChunk) : null;
  const lastSeq = lastDoc ? chunkSeq(lastDoc.frontmatter.id) : null;
  if (lastSeq !== null) {
    const recentMin = Math.max(0, lastSeq - 7); // last ~8 chunks
    // Check if already covered by a top epoch
    const covered = topEpochs.some((e) => e.startSeq <= recentMin && e.endSeq >= lastSeq);
    if (!covered) {
      topEpochs.push({ score: 1, startSeq: recentMin, endSeq: lastSeq + 100 });
    }
  }

  // Collect paths whose chunk seq falls within any selected epoch range
  const selected = new Set<string>();
  for (const filePath of allPaths) {
    const doc = await storage.readL2ChunkAtPath(filePath);
    if (!doc) {
      continue;
    }
    const seq = chunkSeq(doc.frontmatter.id);
    if (seq === null) {
      selected.add(filePath); // Include non-sequenced chunks
      continue;
    }
    const inRange = topEpochs.some((e) => seq >= e.startSeq && seq <= e.endSeq);
    if (inRange) {
      selected.add(filePath);
    }
  }

  return allPaths.filter((p) => selected.has(p));
}

function chunkSeq(chunkId: string): number | null {
  const seq = /^chunk-(\d+)/.exec(chunkId)?.[1];
  return seq !== undefined ? Number.parseInt(seq, 10) : null;
}

// Greedy submodular fact selector (arXiv:2607.00725).
// Optimises a budgeted monotone submodular objective:
//   f(S) = Σ relevance(i) + λ_div * diversity(S) + λ_cov * coverage(S)
// where diversity penalises redundancy (Jaccard on tokenised text) and
// coverage rewards query tokens present in the selected set.
//
// Budget may be expressed as a token count (approx 4 chars/token) or,
// when null, falls back to a raw item-count cap.
export function submodularSelect(
  scored: RetrievedFact[],
  queryTokens: Set<string>,
  topK: number,
  diversityWeight: number,
  coverageWeight: number,
  tokenBudget: number | null,
): RetrievedFact[] {
  const selected: RetrievedFact[] = [];
  const selectedKeys = new Set<string>();
  const coveredTokens = new Set<string>();
  let usedTokens = 0;
  const budget = tokenBudget ?? topK * 20; // ~20 tokens per fact as rough default

  // Work on a copy so we can mutate safely
  const pool = scored.slice();

  while (pool.length > 0) {
    let bestIdx = -1;
    let bestGain = -Infinity;

    for (let i = 0; i < pool.length; i += 1) {
      const item = pool[i];
      if (!item || selectedKeys.has(item.fact.dedupKey)) {
        continue;
      }

      // Token cost of this fact (cheap heuristic: chars/4)
      const itemTokens = Math.ceil(item.fact.text.length / 4);

      // Budget check: when tokenBudget is explicit, enforce it strictly.
      // When null, only the topK count cap limits selection.
      if (tokenBudget !== null && usedTokens + itemTokens > budget) {
        continue;
      }

      // Relevance term (normalised 0–1)
      const relevance = item.score;

      // Diversity term: penalise max Jaccard with any already-selected item
      let maxSim = 0;
      const itemTokensSet = tokenize(item.fact.text);
      for (const sel of selected) {
        const sim = jaccard(itemTokensSet, tokenize(sel.fact.text));
        if (sim > maxSim) {
          maxSim = sim;
        }
      }
      const diversity = 1 - maxSim; // 1 = completely novel, 0 = duplicate

      // Coverage term: how many *new* query tokens does this item cover?
      const newTokens = [...queryTokens].filter(
        (t) => itemTokensSet.has(t) && !coveredTokens.has(t),
      );
      const coverage = queryTokens.size > 0 ? newTokens.length / queryTokens.size : 0;

      const gain = relevance + diversityWeight * diversity + coverageWeight * coverage;

      if (gain > bestGain) {
        bestGain = gain;
        bestIdx = i;
      }
    }

    if (bestIdx === -1) {
      break; // No beneficial item remains
    }

    const chosen = pool[bestIdx];
    if (!chosen) {
      break;
    }
    selected.push(chosen);
    selectedKeys.add(chosen.fact.dedupKey);
    const chosenTokens = tokenize(chosen.fact.text);
    for (const t of queryTokens) {
      if (chosenTokens.has(t)) {
        coveredTokens.add(t);
      }
    }
    usedTokens += Math.ceil(chosen.fact.text.length / 4);
    pool.splice(bestIdx, 1);

    // Hard stop at topK if we're already at count budget
    if (selected.length >= topK) {
      break;
    }
  }

  return selected;
}

// ---------------------------------------------------------------------------
// Passage-level information-density reranker (RARG-inspired, arXiv:2607.24223)
// ---------------------------------------------------------------------------
// After BM25 + composite scoring produces a ranked list, this reranker
// adjusts scores based on two passage-level signals:
//
// 1. **Named-entity density** — facts containing more named entities
//    (capitalized tokens, IPs, version strings) carry more actionable
//    information per token. A fact with 5 entities is more likely to be
//    useful than one with none, even at similar BM25 scores.
//
// 2. **Query novelty** — facts whose tokens barely overlap with the query
//    are more likely to add new information rather than parroting back
//    query terms. This counteracts BM25's bias toward lexical redundancy.
//
// The adjustment is multiplicative: score *= (1 + α * density * novelty)
// where α is `rerankDensityWeight` (default 0.15). This keeps the reranker
// conservative — it nudges rankings, never inverts them dramatically.

const DENSITY_ENTITY_PATTERN =
  /\b(?:[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*|\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}|v?\d+\.\d+\.\d+|[A-Z][A-Za-z0-9-]+)\b/g;

/**
 * Count named entities in a fact text using a capitalized-token heuristic.
 * No NER dependency — runs in O(text.length) with a single regex pass.
 */
export function countNamedEntities(text: string): number {
  const matches = text.match(DENSITY_ENTITY_PATTERN);
  return matches !== null ? matches.length : 0;
}

/**
 * Compute a normalized information-density score (0–1) for a fact.
 * Combines entity count and query novelty into a single scalar.
 *
 * @param factText - The fact's text.
 * @param queryTokens - Tokenized query for novelty computation.
 * @returns Density score in [0, 1].
 */
export function informationDensity(factText: string, queryTokens: Set<string>): number {
  const entityCount = countNamedEntities(factText);
  const factTokens = tokenize(factText);

  // Entity density: entities per token, clamped to [0, 1].
  // ~1 entity per 5 tokens is already very dense.
  const tokenCount = Math.max(1, factTokens.size);
  const density = Math.min(1, entityCount / (tokenCount * 0.2));

  // Novelty: fraction of fact tokens NOT in the query.
  // 1 = entirely new info, 0 = pure parroting.
  let novelCount = 0;
  for (const t of factTokens) {
    if (!queryTokens.has(t)) {
      novelCount++;
    }
  }
  const novelty = factTokens.size > 0 ? novelCount / factTokens.size : 0;

  // Geometric mean so both signals must be present for a high score.
  return Math.sqrt(density * novelty);
}

/**
 * Apply the information-density reranker to a sorted list of retrieved facts.
 * Mutates scores in-place and re-sorts.
 *
 * @param results - Scored facts sorted by composite score (descending).
 * @param query - Original query string (for tokenization).
 * @param weight - Adjustment weight (0–1). Default 0.15.
 * @returns The same array, re-sorted with adjusted scores.
 */
export function rerankByInformationDensity(
  results: RetrievedFact[],
  query: string,
  weight: number = 0.15,
): RetrievedFact[] {
  if (results.length <= 1 || weight <= 0) {
    return results;
  }
  const queryTokens = tokenize(query);
  if (queryTokens.size === 0) {
    return results;
  }

  for (const item of results) {
    const density = informationDensity(item.fact.text, queryTokens);
    item.score = item.score * (1 + weight * density);
  }

  results.sort((a, b) => b.score - a.score);
  return results;
}

// ---------------------------------------------------------------------------
// Post-retrieval critique filter (arXiv:2607.28272 — Reconstructive Memory)
// ---------------------------------------------------------------------------
// Retrieved memories can be semantically relevant yet contextually stale.
// This heuristic-only critique pass demotes prose facts that are both:
//   1. Episodically stale (validity < CRITIQUE_VALIDITY_FLOOR), AND
//   2. Epistemically unreliable (reliability < CRITIQUE_RELIABILITY_FLOOR)
// Typed facts (slot=value) are atomic and skip the critique entirely —
// their confidence already decays via access-time decay, and they represent
// canonical values that should not be filtered by heuristics.
//
// Demotion is a soft multiplicative penalty, not a hard filter: the fact
// stays in the list but with a reduced score, so genuinely critical facts
// can still surface if their composite score is high enough.

const CRITIQUE_VALIDITY_FLOOR = 0.3;
const CRITIQUE_RELIABILITY_FLOOR = 0.6;
const CRITIQUE_DEMOTION_FACTOR = 0.5;

/** Tiers that are atomic (slot=value) and skip the critique pass. */
const CRITIQUE_EXEMPT_TIERS = new Set<string>(["typed", "longterm-typed"]);

/**
 * Apply a heuristic critique filter to demote stale, unreliable prose facts.
 * Mutates scores in-place and re-sorts.
 *
 * Only applies to prose tiers (L2, longterm, insight). Typed facts and
 * memory-core hits are exempt.
 */
export function critiqueStaleFacts(results: RetrievedFact[]): RetrievedFact[] {
  if (results.length === 0) {
    return results;
  }

  let demoted = 0;
  for (const item of results) {
    if (CRITIQUE_EXEMPT_TIERS.has(item.tier)) {
      continue;
    }
    // Demote when BOTH conditions hold: stale episodic context AND low reliability.
    if (
      item.signals.validity < CRITIQUE_VALIDITY_FLOOR &&
      item.signals.reliability < CRITIQUE_RELIABILITY_FLOOR
    ) {
      item.score *= CRITIQUE_DEMOTION_FACTOR;
      demoted++;
    }
  }

  if (demoted > 0) {
    results.sort((a, b) => b.score - a.score);
  }
  return results;
}
export function formatMemorySection(
  facts: ReadonlyArray<RetrievedFact>,
  options?: { now?: number },
): string {
  if (facts.length === 0) {
    return "";
  }
  const now = options?.now;
  const lines = facts.map((r) => {
    const marker = tierMarker(r.tier);
    const age = now !== undefined ? ` ${formatRelativeAge(now - r.fact.createdAt)}` : "";
    return `- ${marker} [${r.score.toFixed(2)}]${age} ${r.fact.text}`;
  });
  // Guidance prelude: tells the agent how to use the facts. Stays passive
  // ("draw on these"), respects the agent's own answer style — no hard rules
  // about UNKNOWN handling, since live users want honest abstention.
  // The recall-vs-event clarification matters: the parenthetical age is when
  // the fact was *noted*, not when the event happened. For questions about
  // event ordering ("which came first") or durations ("how long ago"), the
  // answer lives in the fact text itself, not in the recall annotation.
  const prelude =
    "Draw on these recalled facts when relevant. The (Nd ago) annotation shows when each fact was *noted*, not when the event happened — use it only to break ties between two facts that directly contradict (e.g. balance is X vs balance is Y, prefer the more recent recall). For questions about event ordering, durations, or dates, the answer lives in the fact text itself.";
  return `## Memory (hierarchical-l3)\n${prelude}\n\n${lines.join("\n")}`;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function formatRelativeAge(ageMs: number): string {
  if (!Number.isFinite(ageMs) || ageMs < 0) {
    return "(now)";
  }
  const days = ageMs / MS_PER_DAY;
  if (days < 1) {
    return "(today)";
  }
  if (days < 2) {
    return "(yesterday)";
  }
  if (days < 14) {
    return `(${Math.round(days)}d ago)`;
  }
  if (days < 60) {
    return `(${Math.round(days / 7)}w ago)`;
  }
  if (days < 365) {
    return `(${Math.round(days / 30)}mo ago)`;
  }
  return `(${(days / 365).toFixed(1)}y ago)`;
}

function tierMarker(tier: RetrievalTier): string {
  switch (tier) {
    case "longterm":
      return "★";
    case "longterm-typed":
      return "★";
    case "memory-core":
      return "◆";
    case "typed":
      return "■";
    case "shared":
      return "◇";
    case "procedural":
      return "⬡";
    case "insight":
      return "✦";
    case "l2":
      return "·";
  }
}

/**
 * Sufficient Context Agent: performs gap analysis after retrieval.
 *
 * Parses the query for explicit requirements (entities, fields), compares
 * against retrieved facts, and outputs a structured gap analysis with
 * suggested follow-up queries for missing information.
 *
 * This is inspired by Google's multi-agent RAG framework, where a dedicated
 * agent evaluates retrieved snippets and triggers follow-up searches for
 * missing information.
 */
async function checkSufficientContext(
  query: string,
  facts: RetrievedFact[],
): Promise<MissingFact | undefined> {
  // Extract requested entities/fields from the query
  const requestedFields = extractRequestedFields(query);
  if (requestedFields.length === 0) {
    // No explicit requirements detected - no gap analysis needed
    return undefined;
  }

  // Check which requested fields are covered by retrieved facts
  const missingFields: string[] = [];

  for (const field of requestedFields) {
    const fieldLower = field.toLowerCase();
    // Simple lexical check: does the field appear in any retrieved fact?
    const found = facts.some((f) => f.fact.text.toLowerCase().includes(fieldLower));
    if (!found) {
      missingFields.push(field);
    }
  }

  if (missingFields.length === 0) {
    // All requested fields covered
    return undefined;
  }

  // Generate follow-up query suggestions
  const suggestedQueries = generateFollowUpQueries(missingFields);

  // Simple query ID hash (for deduplication across calls)
  const queryId = simpleHash(query);

  return { queryId, missingFields, suggestedQueries };
}

/**
 * Extract explicit requirements from the query string.
 *
 * Looks for patterns like:
 * - "What is X, Y, and Z?" -> ["X", "Y", "Z"]
 * - "Show me the IP and port" -> ["IP", "port"]
 * - "Username and password" -> ["username", "password"]
 *
 * Returns a list of field names that the query explicitly requests.
 */
function extractRequestedFields(query: string): string[] {
  const fields: string[] = [];

  // Pattern 1: comma-separated lists ("X, Y, and Z")
  const commaListPattern =
    /(?:what|show|tell|get|find|list)(?:\s+(?:me|us|the|all))?\s+(?:the\s+)?([a-z][a-z0-9_\-]*\s*(?:,\s*[a-z][a-z0-9_\-]*\s*)+(?:\s+and\s+[a-z][a-z0-9_\-]*)?)/gi;
  const commaMatch = commaListPattern.exec(query);
  if (commaMatch) {
    const listPart = commaMatch[1] ?? "";
    // Split by comma, clean up "and" articles
    const items = listPart
      .split(/,\s*|\s+and\s+/i)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    fields.push(...items);
  }

  // Pattern 2: "X and Y" pairs
  const andPattern =
    /(?:what|show|tell|get|find)(?:\s+(?:me|us|the))?\s+(?:the\s+)?([a-z][a-z0-9_\-]*\s+and\s+[a-z][a-z0-9_\-]*)/gi;
  const andMatch = andPattern.exec(query);
  if (andMatch && !commaMatch) {
    // Only use this if we didn't already match a comma list
    const pairPart = andMatch[1] ?? "";
    const items = pairPart.split(/\s+and\s+/i).map((s) => s.trim());
    fields.push(...items);
  }

  // Pattern 3: possessive requests ("Joe's phone", "server's IP")
  const possessivePattern = /([a-z][a-z0-9_\-]*'s\s+[a-z][a-z0-9_\-]+)/gi;
  for (const match of query.matchAll(possessivePattern)) {
    const field = match[1];
    if (field !== undefined) {
      fields.push(field);
    }
  }

  return fields;
}

/**
 * Generate follow-up queries for missing fields.
 *
 * Creates targeted queries that focus specifically on the missing
 * information, e.g., if original was "What is X, Y, and Z?" and Y is missing,
 * suggests "What is Y?" and "Tell me about Y".
 */
function generateFollowUpQueries(missingFields: string[]): string[] {
  const queries: string[] = [];

  for (const field of missingFields) {
    // Generate 2-3 variations per missing field
    queries.push(`What is ${field}?`);
    queries.push(`Tell me about ${field}`);
    queries.push(`${field} information`);
  }

  // Cap at 6 suggestions total to avoid overwhelming the caller
  return queries.slice(0, 6);
}

/**
 * Simple string hash for query deduplication.
 */
function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return Math.abs(hash).toString(16);
}
