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
  scoreFact,
  type Signals,
  tokenize,
} from "./scoring.js";
import type { Storage } from "./storage.js";
import type {
  Insight,
  L2Fact,
  L3EpochFrontmatter,
  LongTermFact,
  LongTermTypedFact,
  MissingFact,
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
};

export const DEFAULT_RETRIEVAL_CONFIG: RetrievalConfig = {
  useEpochFirst: true,
  epochExpandTopN: 3,
};

export type RetrievedFact = {
  fact: L2Fact;
  score: number;
  signals: Signals;
  chunkId: string;
  tier: RetrievalTier;
};

/**
 * Result from Sufficient Context Agent: includes retrieved facts plus
 * optional gap analysis and suggested follow-up queries.
 */
export type RetrievalResult = {
  facts: RetrievedFact[];
  /** Gap analysis from Sufficient Context Agent, if enabled. */
  missingInfo?: MissingFact;
};

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
  const config = params.config ?? DEFAULT_SCORING_CONFIG;
  const retConfig = params.retrievalConfig ?? DEFAULT_RETRIEVAL_CONFIG;

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
      });
    }
  }

  // Long-term typed tier
  for (const ltt of longtermTyped.facts) {
    if (ltt.archived) {
      continue;
    }
    items.push({
      fact: longTermTypedAsL2Fact(ltt),
      chunkId: "longterm-typed",
      tier: "longterm-typed",
      l3Boost: 0,
      tierBoost: config.weightLongTermTierBoost,
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

  // Build corpus stats from all fact texts for BM25 IDF computation.
  const corpusStats: CorpusStats | undefined =
    config.weightBm25 > 0 ? buildCorpusStats(items.map((i) => i.fact.text)) : undefined;

  // Phase 2: Score all items using composite + tier boosts.
  const scored: RetrievedFact[] = [];
  for (const item of items) {
    const signals = scoreFact({
      queryTokens,
      fact: item.fact,
      now,
      config,
      l3Boost: item.l3Boost,
      corpusStats,
      significant: item.fact.significant,
      informationGain: item.informationGain,
    });
    // Add embedding-based semantic signal when both query and fact have vectors
    if (
      params.queryEmbedding &&
      item.embedding &&
      params.queryEmbedding.length === item.embedding.length
    ) {
      signals.semantic = cosineSimilarity(params.queryEmbedding, item.embedding);
    }
    const baseScore = composite(signals, config);
    const score = signals.lexical > 0 ? baseScore + item.tierBoost : baseScore;
    if (score > 0) {
      scored.push({ fact: item.fact, score, signals, chunkId: item.chunkId, tier: item.tier });
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
          config,
          l3Boost: 0,
          corpusStats,
          recallCount: Math.max(1, skill.usageCount),
        });
        const baseScore = composite(signals, config);
        const recency = fsrsProceduralRetrievability(skill, now);
        const score =
          baseScore +
          (signals.lexical > 0 ? config.weightLongTermTierBoost : 0) +
          recency * config.weightRecency;
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
          config,
          l3Boost: 0,
          corpusStats,
          recallCount: sf.recallCount,
        });
        const baseScore = composite(signals, config);
        const score = signals.lexical > 0 ? baseScore + config.weightLongTermTierBoost : baseScore;
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
      const existingSignals = await params.storage.readRetrievalSignals();
      const existingMap = new Map(existingSignals.map((s) => [s.factId, s]));
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
  // Message-chunk fallback (Phase 3)
  // -----------------------------------------------------------------
  // When top-K is sparse (< topK/2 results from fact tiers), expand
  // search into raw message-level chunks. This catches relevant
  // conversation context that wasn't captured as structured facts.
  const result = scored.slice(0, topK);
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

  const finalFacts = result.slice(0, topK);

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

  return { facts: finalFacts, missingInfo };
}

function longTermAsL2Fact(lt: LongTermFact): L2Fact {
  return {
    id: lt.id,
    text: lt.text,
    importance: lt.importance,
    createdAt: lt.lastConfirmedAt,
    dedupKey: lt.dedupKey,
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
    createdAt: typed.createdAt,
    dedupKey: typed.slot,
  };
}

function longTermTypedAsL2Fact(ltt: LongTermTypedFact): L2Fact {
  const text = ltt.unit ? `${ltt.slot} = ${ltt.value} ${ltt.unit}` : `${ltt.slot} = ${ltt.value}`;
  return {
    id: ltt.id,
    text,
    importance: ltt.confidence,
    createdAt: ltt.lastConfirmedAt,
    dedupKey: ltt.slot,
  };
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
    if (!m) {
      continue;
    }
    ranges.push({ start: Number.parseInt(m[1], 10), end: Number.parseInt(m[2], 10), score });
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
  const lastDoc = await storage.readL2ChunkAtPath(lastChunk);
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
  const m = /^chunk-(\d+)/.exec(chunkId);
  return m ? Number.parseInt(m[1], 10) : null;
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
    const listPart = commaMatch[1];
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
    const pairPart = andMatch[1];
    const items = pairPart.split(/\s+and\s+/i).map((s) => s.trim());
    fields.push(...items);
  }

  // Pattern 3: possessive requests ("Joe's phone", "server's IP")
  const possessivePattern = /([a-z][a-z0-9_\-]*'s\s+[a-z][a-z0-9_\-]+)/gi;
  for (const match of query.matchAll(possessivePattern)) {
    fields.push(match[1]);
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
