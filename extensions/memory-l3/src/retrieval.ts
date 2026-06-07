import {
  buildCorpusStats,
  composite,
  DEFAULT_SCORING_CONFIG,
  type CorpusStats,
  fsrsRetrievability,
  jaccard,
  type ScoringConfig,
  scoreFact,
  type Signals,
  tokenize,
} from "./scoring.js";
import type { Storage } from "./storage.js";
import type {
  L2Fact,
  L3EpochFrontmatter,
  LongTermFact,
  LongTermTypedFact,
  TypedFact,
} from "./types.js";

export type RetrievalTier = "l2" | "longterm" | "longterm-typed" | "memory-core" | "typed";

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
}): Promise<RetrievedFact[]> {
  const topK = Math.max(0, params.topK);
  if (topK === 0) return [];
  const queryTokens = tokenize(params.query);
  if (queryTokens.size === 0) return [];

  const paths = await params.storage.listL2ChunkPaths();
  if (paths.length === 0) return [];

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
  };
  const items: ScorableItem[] = [];

  for (const filePath of candidatePaths) {
    const doc = await params.storage.readL2ChunkAtPath(filePath);
    if (!doc) continue;
    const chunkId = doc.frontmatter.id;
    const l3Boost = epochBoosts.get(chunkId) ?? 0;
    for (const fact of doc.frontmatter.facts) {
      items.push({ fact, chunkId, tier: "l2", l3Boost, tierBoost: 0 });
    }
    for (const typed of doc.frontmatter.typedFacts ?? []) {
      if (canonicalSlots.has(typed.slot)) continue;
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
    if (ltt.archived) continue;
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
    if (lt.archived) continue;
    if (lt.supersededBy) continue;
    items.push({
      fact: longTermAsL2Fact(lt),
      chunkId: "longterm",
      tier: "longterm",
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
    });
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
        if (score <= 0) continue;
        scored.push({
          fact,
          score,
          signals: { lexical: hit.score, bm25: 0, importance: 0.5, recency: 1, l3Boost: 0 },
          chunkId: hit.path,
          tier: "memory-core",
        });
      }
    } catch {
      // Memory-core unavailable or threw — skip the tier silently.
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
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
  if (allPaths.length === 0) return [];

  // Few chunks — not worth filtering, just return everything
  if (allPaths.length <= 8) return allPaths;

  // Score each epoch
  const epochPaths = await storage.listL3EpochPaths();
  if (epochPaths.length === 0) return allPaths; // No epochs yet

  const scored: Array<{ score: number; startSeq: number; endSeq: number }> = [];
  for (const epPath of epochPaths) {
    const doc = await storage.readL3EpochAtPath(epPath);
    if (!doc) continue;
    const startSeq = chunkSeq(doc.frontmatter.startChunkId);
    const endSeq = chunkSeq(doc.frontmatter.endChunkId);
    if (startSeq === null || endSeq === null) continue;
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
    if (!doc) continue;
    const seq = chunkSeq(doc.frontmatter.id);
    if (seq === null) {
      selected.add(filePath); // Include non-sequenced chunks
      continue;
    }
    const inRange = topEpochs.some((e) => seq >= e.startSeq && seq <= e.endSeq);
    if (inRange) selected.add(filePath);
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
  if (facts.length === 0) return "";
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
  if (!Number.isFinite(ageMs) || ageMs < 0) return "(now)";
  const days = ageMs / MS_PER_DAY;
  if (days < 1) return "(today)";
  if (days < 2) return "(yesterday)";
  if (days < 14) return `(${Math.round(days)}d ago)`;
  if (days < 60) return `(${Math.round(days / 7)}w ago)`;
  if (days < 365) return `(${Math.round(days / 30)}mo ago)`;
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
    case "l2":
      return "·";
  }
}
