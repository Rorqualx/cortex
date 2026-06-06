/**
 * Persistent state owned by the engine. Single source of truth for cross-run
 * resumption: chunk counters, last epoch boundary, buffered token count.
 */
export type L3State = {
  version: 1;
  agentId: string | null;
  bufferTokenCount: number;
  l2ChunkIndex: number;
  lastEpochAt: number;
  lastChunkId: string | null;
  /**
   * Per-session cursor: how many messages of each session have already been
   * compacted into L2 chunks. afterTurn() ingests
   * `params.messages.slice(compactedMessageCountBySession[sessionId])` each
   * turn so we don't double-ingest. Per-session because the runtime rotates
   * session ids; an engine-wide int would over-skip on new sessions and
   * under-skip on truncated ones.
   */
  compactedMessageCountBySession: Record<string, number>;
  /** Wall-clock ms of the most recent long-term consolidation pass (0 = never). */
  lastConsolidatedAt: number;
};

export const INITIAL_L3_STATE: L3State = {
  version: 1,
  agentId: null,
  bufferTokenCount: 0,
  l2ChunkIndex: 0,
  lastEpochAt: 0,
  lastChunkId: null,
  compactedMessageCountBySession: {},
  lastConsolidatedAt: 0,
};

/**
 * A single distilled fact extracted from a chunk of conversation. Importance
 * and dedupKey are used by retrieval scoring and within-chunk dedup.
 */
export type L2Fact = {
  id: string;
  text: string;
  importance: number;
  createdAt: number;
  dedupKey: string;
  /** Optional one-sentence explanation of why this fact is worth remembering
   * across sessions, extracted from the LLM during compaction. E.g.,
   * "User mentioned this preference unprompted, suggesting strong importance."
   * Absent on facts extracted before PROMPT_VERSION=5. */
  reasoning?: string;
};

/**
 * A precise, verbatim-grounded fact — the "left brain" complement to the
 * LLM-distilled prose `L2Fact`. TypedFacts hold exact values (numbers, IDs,
 * dates, file paths, version strings) that the LLM extractor cannot be
 * trusted to paraphrase. Each value must pass regex source-grounding:
 * `value` appears verbatim inside `sourceSpan`, which appears verbatim in
 * the source transcript.
 */
export type TypedFact = {
  id: string;
  /** Kebab-case scoped slot name like "user:phone" or "infra:pi_hole_ip". */
  slot: string;
  /** The verbatim value as it appeared in the source transcript. */
  value: string;
  /** Surrounding context (15-200 chars) containing `value`, used for grounding. */
  sourceSpan: string;
  /** Optional unit hint ("USD", "MB", "v", etc). */
  unit: string | null;
  /** Extractor confidence 0..1. */
  confidence: number;
  /** ms timestamp. */
  createdAt: number;
};

/**
 * JSON frontmatter persisted on L2 chunk markdown files. The body of the
 * markdown holds a human-readable summary; the structured data lives here.
 */
export type L2ChunkFrontmatter = {
  id: string;
  agentId: string | null;
  startTurnIndex: number;
  endTurnIndex: number;
  createdAt: number;
  facts: L2Fact[];
  /**
   * Precise verbatim-grounded values extracted alongside `facts`. Optional
   * for backward compat — chunks written before PROMPT_VERSION=4 lack this
   * field; readers must default to [].
   */
  typedFacts?: TypedFact[];
  dedupKeys: string[];
};

/**
 * A roll-up digest covering N consecutive L2 chunks. Used by retrieval as a
 * soft prior boost for queries that match the digest text.
 */
export type L3EpochFrontmatter = {
  id: string;
  agentId: string | null;
  startChunkId: string;
  endChunkId: string;
  createdAt: number;
  representativeFacts: L2Fact[];
};

export type FrontmatterDocument<TFrontmatter> = {
  frontmatter: TFrontmatter;
  body: string;
};

/**
 * A fact promoted into the long-term tier — i.e., one that recurred across
 * multiple L2 chunks with enough cumulative signal that it is worth carrying
 * across sessions. The schema is intentionally a superset of `L2Fact` so a
 * single fact can travel through the tiers without lossy conversion.
 */
export type LongTermFact = {
  id: string;
  text: string;
  dedupKey: string;
  /** Composite importance, currently the max importance across confirming chunks. */
  importance: number;
  /** ms timestamp of the first L2 chunk that emitted this dedupKey. */
  firstSeenAt: number;
  /** ms timestamp of the most recent L2 chunk that confirmed this dedupKey. */
  lastConfirmedAt: number;
  /** Distinct L2 chunks that have emitted this dedupKey. */
  recallCount: number;
  /** Distinct chunkIds that confirmed this fact (used by demotion to find provenance). */
  sourceChunkIds: string[];
  /** When true, fact is hidden from retrieval but kept on disk for forensics. */
  archived: boolean;
  /** ms timestamp when archived (set iff archived=true). */
  archivedAt: number | null;
  /**
   * When set, the slot of a typed fact whose verbatim value contradicts this
   * prose fact's content. Marked by the cross-brain reconciler at epoch
   * boundaries. Suppressed from active retrieval (typed facts are
   * authoritative). Optional for backward compat — old data may lack it.
   */
  supersededBy?: string | null;
};

/**
 * Frontmatter for `<root>/longterm.md`. Single-file schema (vs. the date-
 * partitioned L2 layout) because long-term facts are bounded — promotion
 * thresholds keep the working set small enough to load whole.
 */
export type LongTermFrontmatter = {
  version: 1;
  agentId: string | null;
  lastConsolidatedAt: number;
  facts: LongTermFact[];
};

export const INITIAL_LONG_TERM_FRONTMATTER: LongTermFrontmatter = {
  version: 1,
  agentId: null,
  lastConsolidatedAt: 0,
  facts: [],
};

/**
 * The typed-fact analogue of `LongTermFact`: a slot's *canonical* current
 * value, plus a history of superseded values. Where prose long-term facts
 * accumulate evidence (recallCount = how often the same idea recurs), typed
 * long-term facts track *value drift* (history = the trail of supersessions
 * as the value changes over time, e.g. balance updates).
 */
export type LongTermTypedFact = {
  id: string;
  slot: string;
  /** Most recent value across all chunks emitting this slot. */
  value: string;
  unit: string | null;
  /** Confidence of the most recent emission. */
  confidence: number;
  /** ms timestamp of the earliest typed fact for this slot. */
  firstSeenAt: number;
  /** ms timestamp of the most recent typed fact (= source of `value`). */
  lastConfirmedAt: number;
  /** Number of distinct chunks that have emitted typed facts for this slot. */
  recallCount: number;
  /** Distinct chunkIds that emitted any typed fact for this slot. */
  sourceChunkIds: string[];
  /** Older values that have been superseded, oldest first. */
  history: Array<{ value: string; supersededAt: number }>;
  /** When true, fact is hidden from retrieval but kept on disk for forensics. */
  archived: boolean;
  archivedAt: number | null;
};

export type LongTermTypedFrontmatter = {
  version: 1;
  agentId: string | null;
  lastConsolidatedAt: number;
  facts: LongTermTypedFact[];
};

export const INITIAL_LONG_TERM_TYPED_FRONTMATTER: LongTermTypedFrontmatter = {
  version: 1,
  agentId: null,
  lastConsolidatedAt: 0,
  facts: [],
};
