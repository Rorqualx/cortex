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
 * How firmly a prose fact is grounded. "confirmed" = user stated/verified it;
 * "tentative" = inferred or speculative; "instructional" = explicit directive
 * about future behavior. Consolidation holds tentative facts to higher
 * promotion bars so a passing observation cannot become firm L3 memory.
 */
export type FactCertainty = "tentative" | "confirmed" | "instructional";

/**
 * Outcome polarity for a fact — MERIT-inspired dual-polarity memory.
 *
 * - `positive` = this approach worked, was validated, or succeeded.
 * - `negative` = this approach failed, was rejected, or caused errors.
 * - `neutral` = no outcome associated (default for all pre-existing facts).
 *
 * During retrieval, negative-polarity facts receive a demotion multiplier
 * when the query context matches the same task/domain, down-ranking "what
 * didn't work" unless explicitly querying for past failures. This improves
 * repair accuracy by avoiding repeating known-bad approaches.
 */
export type FactPolarity = "positive" | "negative" | "neutral";

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
  /** When true, this fact was flagged as emotionally significant (user said
   * "remember this", the fact involves a correction, or is safety-critical).
   * Significant facts get a 2.7× slower FSRS decay rate. Absent on facts
   * extracted before PROMPT_VERSION=6. */
  significant?: boolean;
  /** Grounding strength used by consolidation thresholds. Absent on facts
   * extracted before PROMPT_VERSION=8; readers treat absent as "confirmed". */
  certainty?: FactCertainty;
  /** Semantic-entropy confidence score (0–1) from the LLM extractor.
   * Higher = more confident / lower entropy. Absent on facts extracted
   * before PROMPT_VERSION=9; readers treat absent as 1.0 (neutral). */
  semanticEntropy?: number;
  /** Epoch ms when this fact was last explicitly verified / reaffirmed.
   * Used for temporal-currency scoring in retrieval and archival.
   * Absent on facts extracted before PROMPT_VERSION=10; readers treat
   * absent as `createdAt`. */
  lastVerifiedAt?: number;
  /** Episodic annotation: wall-clock time of the source event (ms).
   * When present, enables RaMem-style validity scoring during retrieval —
   * facts tied to stale episodic contexts receive a soft penalty. */
  eventTime?: number;
  /** Session that produced this fact. */
  sessionId?: string;
  /** Distinct participant roles present in the source chunk. */
  participants?: string[];
  /**
   * MERIT-inspired outcome polarity (positive/negative/neutral).
   * Negative facts represent approaches that failed or were rejected.
   * Absent on facts extracted before this feature; readers treat absent
   * as `neutral`.
   */
  polarity?: FactPolarity;
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
  /** Epoch ms when this typed value was last explicitly verified / reaffirmed.
   * Threaded into `LongTermTypedFact.lastVerifiedAt` at consolidation for
   * temporal-currency scoring. Absent on facts extracted before this feature;
   * readers treat absent as `createdAt`. */
  lastVerifiedAt?: number;
  /** Episodic annotation: wall-clock time of the source event (ms). */
  eventTime?: number;
  /** Session that produced this fact. */
  sessionId?: string;
  /** Distinct participant roles present in the source chunk. */
  participants?: string[];
  /** Time the fact was mentioned / extracted (ms). */
  mentionTime?: number;
  /**
   * QW-2: Participant who stated this fact, used to infer sourceTrust.
   * Typically derived from which role said the source span. Absent on
   * facts extracted before this feature.
   */
  statedBy?: string;
};

/**
 * Zero-model deterministic facts extracted directly from message metadata.
 * No LLM call needed — these are measured from the raw conversation buffer.
 * Serves as cache keys (skip LLM re-extraction when inputs unchanged) and
 * as an auditable complement to the inference-tier extraction.
 *
 * Added in PROMPT_VERSION=12; absent on chunks written before then.
 */
export type L2DeterministicExtraction = {
  /** Distinct tool names invoked in this chunk's messages. */
  toolNames: string[];
  /** File paths referenced in message content (best-effort regex extraction). */
  filePaths: string[];
  /** Number of conversation turns (messages) in the compacted slice. */
  turnCount: number;
  /** Wall-clock span of the messages in this chunk. */
  timeSpan: { start: number; end: number };
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
  /**
   * Structured decisions extracted from this chunk via LLM. Optional for
   * backward compat — chunks written before PROMPT_VERSION=7 lack this.
   */
  decisions?: ExtractedDecision[];
  /**
   * Action items extracted from this chunk via LLM. Optional for backward
   * compat.
   */
  actionItems?: ExtractedActionItem[];
  /**
   * Session novelty at compaction time: 1 - max cosine similarity between
   * this chunk's combined fact text and existing long-term fact embeddings.
   * 1 = entirely new ground; 0 = fully covered by long-term memory. Absent
   * when no embedding provider was available. Consumed by scoring via
   * `ScoringConfig.weightInformationGain` (zero until calibrated).
   */
  informationGain?: number;
  /**
   * Number of messages in the buffer that produced this chunk. Enables
   * RaMem-style contextual reinstatement: retrieval can look up how much
   * context was present when a fact was noted. Absent on chunks written
   * before PROMPT_VERSION=11; readers treat absent as `endTurnIndex`.
   */
  contextWindow?: number;
  /**
   * Message ranges used for per-topic extraction when segmented compaction
   * was active (OPENCLAW_MEMORY_L3_SEGMENTED_COMPACTION=1). Absent for
   * monolithic extraction. Indexes are into the compacted message slice.
   */
  topicSegments?: Array<{ startMsgIndex: number; endMsgIndex: number }>;
  /**
   * AREX-style active constraints extracted from this chunk (PROMPT_VERSION=11).
   * Unresolved problem constraints, open questions, or verified evidence
   * that must persist across compaction boundaries. Absent on chunks
   * written before v11.
   */
  activeConstraints?: ActiveConstraint[];
  /**
   * Zero-model deterministic extraction (tool names, file paths, turn count,
   * time span). Added in PROMPT_VERSION=12; absent on older chunks.
   */
  deterministic?: L2DeterministicExtraction;
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
  /** Emotional significance flag propagated from L2 extraction. */
  significant?: boolean;
  /**
   * Pre-computed embedding vector for semantic dedup and retrieval.
   * Computed at promotion time (or reaffirmation) via the embedding provider.
   * Absent for facts promoted before this feature was added — fallback to
   * jaccard for those. Stored as number array (768-dim for nomic-embed-text).
   */
  embedding?: number[];
  /**
   * Superseded prior texts, oldest first — the prose analogue of
   * `LongTermTypedFact.history` (same `{value, supersededAt}` shape, keyed
   * `text` here). Written by reaffirm() only when the canonical text actually
   * changes; capped so revision-happy facts cannot grow unbounded. Absent on
   * facts that never changed.
   */
  history?: Array<{ text: string; supersededAt: number }>;
  /**
   * MERIT-inspired outcome polarity, propagated from L2 extraction.
   * See {@link FactPolarity}.
   */
  polarity?: FactPolarity;
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
 * Volatility class for L3 typed facts — controls the decay rate in
 * FSRS forgetting curves. Stable facts (personal preferences, names,
 * relationships) decay 3× slower; volatile facts (API endpoints, config
 * values, version strings) decay 2.5× faster.
 */
export type VolatilityClass = "stable" | "semi-volatile" | "volatile";

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
  /** When this value became canonical (ms). Backfills `firstSeenAt` for existing facts. */
  validFrom: number;
  /** When this value was superseded (ms). `null` = currently active / canonical. */
  validUntil: number | null;
  /** The value that replaced this one, if superseded. `null` = currently active. */
  supersededBy: string | null;
  /** When true, fact is hidden from retrieval but kept on disk for forensics. */
  archived: boolean;
  archivedAt: number | null;
  /** Epoch ms when this fact was last explicitly verified / reaffirmed.
   * Used for temporal-currency scoring in retrieval and archival.
   * Absent on facts created before PROMPT_VERSION=10; readers treat
   * absent as `lastConfirmedAt`. */
  lastVerifiedAt?: number;
  /** ms timestamp of the most recent retrieval that included this fact.
   * Used for access-time decay: facts that haven't been retrieved recently
   * lose confidence over time. Defaults to lastConfirmedAt on creation. */
  lastAccessedAt?: number;
  /**
   * Volatility class controlling per-fact decay rate.
   * stable = personal preferences, names, relationships (0.3× decay)
   * semi-volatile = default (1.0× decay)
   * volatile = API endpoints, config values, versions, paths (2.5× decay)
   * Absent on facts created before this feature; readers treat absent as semi-volatile.
   */
  volatilityClass?: VolatilityClass;
  /**
   * The session ID that contributed the most recent evidence for this fact.
   * Enables traceability: which conversation produced this fact?
   * Absent on facts created before this feature.
   */
  sourceSessionId?: string;
  /**
   * The model/provider that extracted or confirmed this fact (e.g. "deepseek/deepseek-v4-pro").
   * Enables auditing: which model produced this fact?
   * Absent on facts created before this feature; null when the model was unknown.
   */
  sourceModel?: string | null;

  /**
   * Evidence trail: the verbatim source text, chunk, and session that
   * produced the current `value`. Updated on promotion, reaffirmation, and
   * supersession to reflect the most recent source. Absent on facts created
   * before this feature; the `sourceSpan` from the originating `TypedFact`
   * is the quote.
   *
   * Inspired by AskChem's claim-centered retrieval: every atomic fact must
   * be traceable to its evidence.
   */
  provenance?: {
    /** The verbatim source span from which `value` was extracted. */
    quote: string;
    /** The L2 chunk ID containing the source typed fact. */
    chunkId: string;
    /** The session ID of the source conversation. */
    sessionId: string;
  };

  /**
   * QW-2 (Memory Provenance Laundering-inspired): Trust level of the
   * original information source. Distinguishes user-stated facts from
   * web-scraped or agent-inferred ones. Absent on facts created before
   * this feature; readers treat absent as "user" (most facts originate
   * from user conversation).
   */
  sourceTrust?: SourceTrust;

  /**
   * QW-1 (ScrubJay-MEM-inspired): Per-fact perishability coefficient
   * (0..1). Auto-classified at insertion from slot/value keywords and
   * source-trust. Applied as a per-fact decay multiplier alongside the
   * existing class-level volatility multiplier in FSRS retrievability.
   * Lower values = more perishable (faster decay). Default 1.0 (neutral).
   * Absent on facts created before this feature; readers treat absent as 1.0.
   */
  perishability?: number;

  /**
   * QW-3 (Semantica-inspired conflict detection): When this fact's value
   * replaced a contradictory prior value during supersession, this field
   * records the prior fact's ID. Absent on facts that were promoted fresh
   * or reaffirmed with the same value. Readers treat absent as "no conflict".
   * Surfaced in memory_insights for cross-agent audit.
   */
  conflictWith?: string;
};

/**
 * QW-2: Trust classification for L3 typed fact provenance.
 * - `user`: Stated directly by the user in conversation (highest authority)
 * - `web`: Extracted from web/tool output (medium authority)
 * - `agent-inferred`: Synthesized by the agent from context (lower authority)
 * - `untrusted`: Untrusted source, unknown or explicitly flagged as uncertain
 */
export type SourceTrust = "user" | "web" | "agent-inferred" | "untrusted";

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

// -----------------------------------------------------------------
// Phase 2 types: LLM-driven decisions/actions + message-level index
// -----------------------------------------------------------------

/**
 * A structured decision extracted from conversation by the LLM.
 * Replaces the regex-based DECISION_PATTERNS matching in summary.ts.
 */
export type ExtractedDecision = {
  /** The decision or conclusion reached. */
  text: string;
  /** Who made the decision ("user", "agent", or "both"). */
  maker: string;
  /** Confidence 0..1. */
  confidence: number;
  /** Verbatim source span from the conversation. */
  sourceSpan: string;
};

/**
 * A structured action item extracted from conversation by the LLM.
 * Replaces the regex-based ACTION_PATTERNS matching in summary.ts.
 */
export type ExtractedActionItem = {
  /** What needs to be done. */
  text: string;
  /** Who is responsible ("user", "agent", "unassigned"). */
  owner: string;
  /** Optional deadline or time context; null when none was extracted. */
  deadline: string | null;
  /** Confidence 0..1. */
  confidence: number;
  /** Verbatim source span from the conversation. */
  sourceSpan: string;
};

/**
 * AREX-style active constraint — an unresolved problem constraint, open
 * question, or verified evidence that must persist across compaction.
 * (PROMPT_VERSION=11)
 */
export type ActiveConstraint = {
  /** The constraint or evidence statement. */
  text: string;
  /** Whether the constraint is still open, resolved, or verified. */
  status: "open" | "resolved" | "verified";
  /** Verbatim source span from the conversation. */
  sourceSpan: string;
};

/**
 * A sliding-window chunk of raw messages with a pre-computed embedding.
 * Stored alongside L2 chunks so retrieval can fall through from
 * fact-based search to raw conversation when facts miss.
 *
 * Window size: ~10 messages, overlapping by 2 for continuity.
 */
export type MessageChunk = {
  id: string;
  /** Sequential index for ordering. */
  seq: number;
  /** Index of the first message in the source array. */
  startMsgIndex: number;
  /** Index of the last message (exclusive). */
  endMsgIndex: number;
  /** Concatenated text of the messages in this window. */
  text: string;
  /** Pre-computed embedding vector. */
  embedding: number[];
  /** ms timestamp. */
  createdAt: number;
  /** Parent chunk ID this window belongs to. */
  chunkId: string;
};

/**
 * Topic boundary detected via embedding similarity between consecutive
 * message windows. Used for semantic epoch segmentation.
 */
export type TopicBoundary = {
  /** Index in the message array where the topic shifts. */
  messageIndex: number;
  /** Cosine similarity between the windows before and after this point. */
  similarity: number;
  /** Embedding distance threshold that triggered this boundary. */
  threshold: number;
};

// -----------------------------------------------------------------
// Phase 3 types: Entity extraction, topic linking, dynamic importance
// -----------------------------------------------------------------

/**
 * A named entity extracted from L2 facts and typed facts.
 * Entities are cross-referenced across sessions — e.g., "HueyTheDestroyer"
 * appearing in session A and session B both resolve to the same entity.
 */
export type Entity = {
  /** Unique ID derived from normalized name. */
  id: string;
  /** Display name (preserving original casing). */
  name: string;
  /** Entity category. */
  category: string;
  /** Normalized lowercase aliases (including the name itself). */
  aliases: string[];
  /** First time this entity was seen. */
  firstSeenAt: number;
  /** Most recent time this entity was seen. */
  lastSeenAt: number;
  /** Number of times this entity has been mentioned across all chunks. */
  mentionCount: number;
  /** Chunk IDs where this entity appears. */
  sourceChunkIds: string[];
  /** Arbitrary key-value attributes (e.g., type="docker", ip="..."). */
  attributes: Record<string, string>;
};

/**
 * A link between two chunks that discuss the same topic, detected via
 * embedding similarity. Enables cross-session retrieval expansion.
 */
export type TopicLink = {
  /** The chunk that triggered the link. */
  sourceChunkId: string;
  /** The existing chunk with similar content. */
  targetChunkId: string;
  /** Cosine similarity between the chunk embeddings. */
  similarity: number;
  /** When this link was created. */
  createdAt: number;
};

/**
 * Tracks how often a fact is retrieved, used for dynamic importance scoring.
 * Updated during retrieval, consumed during consolidation.
 */
export type RetrievalSignal = {
  /** The fact ID this signal tracks. */
  factId: string;
  /** Total number of times this fact appeared in top-K results. */
  recallCount: number;
  /** Most recent retrieval timestamp. */
  lastRecalledAt: number;
  /** First retrieval timestamp. */
  firstRecalledAt: number;
};

/**
 * Cost-attribution metric row (arXiv:2608.11879): one append-only record per
 * completed engine cycle (compaction + long-term consolidation passes) so the
 * internal memory cost of serving a session is attributable per session. This
 * is the evidence base for the Q3-2026-deferred decisions (construction
 * admission control at p95 > 5s; sqlite-vec ANN at ~10k chunks).
 */
export type L3MetricEntry = {
  /** Session the cycle ran for. */
  sessionId: string;
  /** Number of consolidation passes represented by this row (compaction + LT tiers). */
  consolidations: number;
  /** Facts promoted to the long-term tiers this cycle (prose + typed). */
  promotions: number;
  /** Facts demoted this cycle (archived prose + superseded typed). */
  demotions: number;
  /** Near-duplicate facts merged this cycle (semantic dedup / overflow abstraction). */
  merges: number;
  /** Best available token-spend proxy for the cycle (compaction input tokens). */
  tokensSpent: number;
};

/**
 * Reacquisition telemetry row (ReFind finding 7, 2026-08-23): one record per
 * after-turn compaction event, capturing the tool-call rate immediately before
 * the compaction and (filled at the session's next compaction event) the rate
 * after it. A post-compaction tool-call rate spike is the measurable cost of
 * context loss — the agent re-fetching/re-deriving information compaction
 * threw away. Detection is deliberately raw call-rate deltas only; no behavior
 * changes key off this signal yet.
 */
export type L3CompactionEventEntry = {
  /** Auto-increment row id (present on rows read back from storage). */
  eventId?: number;
  /** Session the compaction ran for. */
  sessionId: string;
  /** Message-array length at event time (session-scoped cursor). */
  messageCursor: number;
  /** Compaction input tokens (cost proxy for the event). */
  tokensBefore: number;
  /** Number of messages inspected for the before-window. */
  messagesBefore: number;
  /** Executed tool calls (tool-result messages) in the before-window. */
  toolCallsBefore: number;
  /** Messages observed after the event (set at the next event). */
  messagesAfter?: number;
  /** Executed tool calls after the event (set at the next event). */
  toolCallsAfter?: number;
  /** True when the after-rate exceeded the before-rate by the spike ratio. */
  reacquisitionSpike?: boolean;
  /** Row creation time (ms epoch). */
  createdAt: number;
};

/**
 * Gap analysis result from Sufficient Context Agent. Indicates which
 * fields or entities from the query are missing from the retrieved facts.
 */
export type MissingFact = {
  /** Unique identifier for this gap analysis (e.g., query hash). */
  queryId: string;
  /** Field names or entity types that were requested but not found. */
  missingFields: string[];
  /** Suggested follow-up queries to retrieve the missing information. */
  suggestedQueries: string[];
};

// -----------------------------------------------------------------
// G1 reflection: higher-order synthesized insights
// -----------------------------------------------------------------

/**
 * A higher-order insight synthesized by the reflection pass from several facts
 * (Generative Agents-style reflection). Unlike an observed fact, an insight is
 * *generated*, so it carries provenance — `sources`, the dedupKeys it was
 * abstracted from — so retrieval/operators can trace it and a later reflection
 * can build on it. Stored in its own tier, never mixed into the observed-fact
 * tiers whose consolidation/dedup assume verbatim provenance.
 */
export type Insight = {
  id: string;
  text: string;
  /** dedupKeys of the facts this insight was synthesized from (provenance). */
  sources: string[];
  importance: number;
  createdAt: number;
};

export type InsightFrontmatter = {
  version: 1;
  agentId: string | null;
  lastReflectedAt: number;
  insights: Insight[];
};

export const INITIAL_INSIGHT_FRONTMATTER: InsightFrontmatter = {
  version: 1,
  agentId: null,
  lastReflectedAt: 0,
  insights: [],
};
