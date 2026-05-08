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

  const epochBoosts = await buildEpochBoostMap(params.storage, queryTokens);

  // Corpus-callosum: load the canonical typed-fact view first so per-chunk
  // typed hits with the same slot can be suppressed. The canonical view
  // already represents the latest value across all chunks; surfacing both
  // would just be noise.
  const longtermTyped = await params.storage.readLongTermTyped();
  const canonicalSlots = new Set(longtermTyped.facts.filter((f) => !f.archived).map((f) => f.slot));

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
        scored.push({ fact, score, signals, chunkId, tier: "l2" });
      }
    }
    // Typed-fact tier (left brain) — verbatim-grounded values surfaced
    // alongside prose facts. Suppress when a canonical entry already
    // exists for the slot: the longterm-typed tier surfaces the latest
    // value and we don't want stale per-chunk values competing.
    for (const typed of doc.frontmatter.typedFacts ?? []) {
      if (canonicalSlots.has(typed.slot)) continue;
      const fact = typedFactAsL2Fact(typed);
      const signals = scoreFact({ queryTokens, fact, now, config, l3Boost: 0 });
      const baseScore = composite(signals, config);
      const score = signals.lexical > 0 ? baseScore + config.weightTypedFactTierBoost : baseScore;
      if (score > 0) {
        scored.push({ fact, score, signals, chunkId, tier: "typed" });
      }
    }
  }

  // Long-term typed tier — canonical current-value-per-slot view. Recall
  // count and history contribute implicitly through the canonical entry's
  // confidence + lastConfirmedAt anchor. Score boost matches the prose
  // long-term tier (+0.15) so canonical typed and canonical prose compete
  // on equal footing.
  for (const ltt of longtermTyped.facts) {
    if (ltt.archived) continue;
    const fact = longTermTypedAsL2Fact(ltt);
    const signals = scoreFact({ queryTokens, fact, now, config, l3Boost: 0 });
    const baseScore = composite(signals, config);
    const score = signals.lexical > 0 ? baseScore + config.weightLongTermTierBoost : baseScore;
    if (score > 0) {
      scored.push({
        fact,
        score,
        signals,
        chunkId: "longterm-typed",
        tier: "longterm-typed",
      });
    }
  }

  // Long-term tier — promoted evergreen facts. Skip archived; treat
  // lastConfirmedAt as the recency anchor so re-affirmed facts feel fresh.
  // The fixed tier boost only applies when there's an actual topical hit;
  // lex=0 long-term facts can still compete on importance + recency, but
  // don't get the +0.15 floor that would let unrelated identity-class
  // facts out-rank stronger L2 matches on every query.
  const longterm = await params.storage.readLongTerm();
  for (const lt of longterm.facts) {
    if (lt.archived) continue;
    // Cross-brain reconciliation marker: prose fact contradicts a typed
    // fact's verbatim value, so the typed value is canonical and this
    // prose entry shouldn't surface in active retrieval.
    if (lt.supersededBy) continue;
    const fact = longTermAsL2Fact(lt);
    const signals = scoreFact({ queryTokens, fact, now, config, l3Boost: 0 });
    const baseScore = composite(signals, config);
    const score = signals.lexical > 0 ? baseScore + config.weightLongTermTierBoost : baseScore;
    if (score > 0) {
      scored.push({ fact, score, signals, chunkId: "longterm", tier: "longterm" });
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
          signals: { lexical: hit.score, importance: 0.5, recency: 1, l3Boost: 0 },
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
