import { randomUUID } from "node:crypto";
import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import { dedupWithinChunk, dropAlreadyKnown, liftToL2Fact } from "./dedup.js";
import type { EmbeddingProvider } from "./engine.js";
import { extractEntitiesFromFacts, mergeEntities, findTopicLinks } from "./entities.js";
import { maybeWriteEpoch } from "./epoch.js";
import { groundAndDedupTypedFacts } from "./grounding.js";
import { extractEdges, mergeEdges, type HebbianEdge } from "./hebbian.js";
import type { IngestBuffer } from "./ingest.js";
import {
  extractFacts,
  extractFactsNative,
  type ExtractResult,
  type ExtractedDecision,
  type ExtractedActionItem,
  type ExtractedTypedFact,
  formatTranscriptForPrompt,
  type LlmCaller,
} from "./llm.js";
import { cosineSimilarity } from "./scoring.js";
import { buildMessageChunks, detectTopicBoundaries, splitByBoundaries } from "./segmentation.js";
import type { Storage } from "./storage.js";
import type { L2ChunkFrontmatter, L2Fact, L3State, TypedFact } from "./types.js";

const DEBUG_ENABLED = process.env.OPENCLAW_MEMORY_L3_DEBUG === "1";
function l3debug(msg: string): void {
  if (DEBUG_ENABLED) {
    console.error(`[memory-l3/compaction] ${msg}`);
  }
}

export type CompactionResult = {
  chunkId: string | null;
  factsAdded: number;
  typedFactsAdded: number;
  tokensBefore: number;
  messagesIngested: number;
  epochId: string | null;
};

const RECENT_DEDUP_KEYS_LIMIT = 200;
const RECENT_CHUNKS_TO_SCAN = 50;

export async function compactSession(params: {
  sessionId: string;
  buffer: IngestBuffer;
  storage: Storage;
  caller: LlmCaller;
  state: L3State;
  /** Override the wall clock (for deterministic regression tests). */
  now?: number;
  /** Embedding provider for message-level chunk embeddings. Optional. */
  embeddingProvider?: EmbeddingProvider;
  /**
   * Per-topic extraction (C-DIC-style): segment the buffer at embedding
   * topic boundaries and run one extraction call per segment. Defaults to
   * the OPENCLAW_MEMORY_L3_SEGMENTED_COMPACTION=1 env flag. Costs one LLM
   * call per segment instead of one per tick — keep flagged until the
   * fact-quality gain is measured against that spend.
   */
  segmentedCompaction?: boolean;
  /**
   * Native compaction (BabelTele-style): use a dense, token-efficient
   * extraction prompt that drops articles/filler and abbreviates where
   * possible. Flag-gated A/B test; defaults to the
   * OPENCLAW_MEMORY_L3_NATIVE_COMPACTION=1 env flag.
   */
  nativeCompaction?: boolean;
}): Promise<CompactionResult> {
  const messages = [...params.buffer.peek(params.sessionId)];
  const tokensBefore = params.buffer.tokens(params.sessionId);
  if (messages.length === 0) {
    return {
      chunkId: null,
      factsAdded: 0,
      typedFactsAdded: 0,
      tokensBefore: 0,
      messagesIngested: 0,
      epochId: null,
    };
  }

  const alreadyKnownSet = new Set(await readRecentDedupKeys(params.storage));

  const { extracted, topicSegments } = await extractWithOptionalSegmentation({
    messages,
    caller: params.caller,
    embeddingProvider: params.embeddingProvider,
    segmentedCompaction: params.segmentedCompaction,
    nativeCompaction: params.nativeCompaction,
  });

  const filtered = dropAlreadyKnown(extracted.facts, alreadyKnownSet);
  const deduped = dedupWithinChunk(filtered);

  // Verbatim source-grounding for typed facts: the LLM's claimed values
  // must appear inside the original transcript character-for-character.
  // Anything that fails grounding is hallucinated and dropped silently.
  const transcript = formatTranscriptForPrompt(messages);
  const groundedTyped = groundAndDedupTypedFacts(extracted.typedFacts, transcript);

  const now = params.now ?? Date.now();
  const eventTime = (messages[0] as { timestamp?: number })?.timestamp ?? now;
  const participants = [
    ...new Set(messages.map((m) => (m as { role?: string }).role).filter(Boolean)),
  ];
  const chunkId = nextChunkId(params.state);
  const facts: L2Fact[] = deduped.map((f) => liftToL2Fact(f, now));
  const typedFacts: TypedFact[] = groundedTyped.map((t) =>
    liftToTypedFact(t, now, {
      eventTime,
      sessionId: params.sessionId,
      participants,
      mentionTime: now,
    }),
  );

  // One chunk embedding serves both the information-gain metric (persisted
  // on the chunk frontmatter) and cross-session topic linking below.
  // Non-fatal: any failure here just means the chunk persists without them.
  let chunkEmbedding: number[] | undefined;
  let linkCandidates: Array<{ chunkId: string; embedding: number[] }> = [];
  let informationGain: number | undefined;
  if (params.embeddingProvider && facts.length > 0) {
    try {
      const chunkText = facts.map((f) => f.text).join(" ");
      [chunkEmbedding] = await params.embeddingProvider.embedBatch([chunkText]);
      if (chunkEmbedding && chunkEmbedding.length > 0) {
        const longterm = await params.storage.readLongTerm();
        const withEmbeddings = longterm.facts.filter(
          (f) => !f.archived && f.embedding && f.embedding.length > 0,
        );
        linkCandidates = withEmbeddings.map((f) => ({
          chunkId: f.sourceChunkIds[0] ?? f.id,
          embedding: f.embedding!,
        }));
        // Novelty vs long-term memory: an empty long-term tier means the
        // session covered entirely new ground (gain = 1).
        const maxSimilarity = withEmbeddings.reduce(
          (max, f) => Math.max(max, cosineSimilarity(chunkEmbedding!, f.embedding!)),
          0,
        );
        informationGain = 1 - maxSimilarity;
      }
    } catch (gainErr) {
      if (DEBUG_ENABLED) {
        console.error(`[memory-l3] information-gain embedding failed: ${String(gainErr)}`);
      }
    }
  }

  const frontmatter: L2ChunkFrontmatter = {
    id: chunkId,
    agentId: params.state.agentId,
    startTurnIndex: 0,
    endTurnIndex: messages.length,
    createdAt: now,
    facts,
    typedFacts,
    dedupKeys: facts.map((f) => f.dedupKey),
    decisions: extracted.decisions.length > 0 ? extracted.decisions : undefined,
    actionItems: extracted.actions.length > 0 ? extracted.actions : undefined,
    informationGain,
    topicSegments,
  };

  await params.storage.writeL2Chunk(
    frontmatter,
    formatChunkBody(messages, facts, typedFacts, extracted.decisions, extracted.actions),
  );

  // Hebbian co-occurrence: extract edges from facts in this chunk and
  // merge with existing edge map.
  if (facts.length >= 2) {
    try {
      const newEdges = extractEdges(facts);
      if (newEdges.length > 0) {
        const existingEdges = (await params.storage.readEdgeMap()) as HebbianEdge[];
        const merged = mergeEdges(existingEdges, newEdges);
        await params.storage.writeEdgeMap(merged);
      }
    } catch (edgeErr) {
      // Edge extraction failures are non-fatal — the chunk is already written.
      if (process.env.OPENCLAW_MEMORY_L3_DEBUG === "1") {
        console.error(`[memory-l3] hebbian edge extraction failed: ${(edgeErr as Error).message}`);
      }
    }
  }

  for (const message of messages) {
    await params.storage.appendL1Archive(chunkId, message);
  }

  // Build and store message-level embedding chunks for raw conversation
  // retrieval. Non-fatal: failures just mean no message-level index.
  if (params.embeddingProvider && messages.length >= 4) {
    try {
      const msgChunks = await buildMessageChunks({
        messages,
        embeddingProvider: params.embeddingProvider,
        chunkId,
        now,
      });
      if (msgChunks.length > 0) {
        await params.storage.writeMessageChunks(msgChunks);
        l3debug(`compactSession: wrote ${msgChunks.length} message-level chunks for ${chunkId}`);
      }
    } catch (msgChunkErr) {
      if (process.env.OPENCLAW_MEMORY_L3_DEBUG === "1") {
        console.error(
          `[memory-l3] message chunk building failed: ${(msgChunkErr as Error).message}`,
        );
      }
    }
  }

  // Entity extraction — heuristic extraction from facts (zero LLM cost)
  try {
    const extractedEntities = extractEntitiesFromFacts({
      facts,
      typedFacts,
      agentId: params.state.agentId,
      chunkId,
      now,
    });
    if (extractedEntities.length > 0) {
      const existingEntities = await params.storage.readEntityIndex();
      const merged = mergeEntities(existingEntities, extractedEntities);
      await params.storage.writeEntityIndex(merged);
      l3debug(
        `compactSession: extracted ${extractedEntities.length} entities, index now ${merged.length} total`,
      );
    }
  } catch (entityErr) {
    if (process.env.OPENCLAW_MEMORY_L3_DEBUG === "1") {
      console.error(`[memory-l3] entity extraction failed: ${(entityErr as Error).message}`);
    }
  }

  // Cross-session topic linking — reuses the chunk embedding and long-term
  // candidates computed for the information-gain metric above.
  if (chunkEmbedding && chunkEmbedding.length > 0 && linkCandidates.length > 0) {
    try {
      const links = await findTopicLinks({
        chunkId,
        chunkEmbedding,
        existingChunks: linkCandidates,
      });
      if (links.length > 0) {
        await params.storage.appendTopicLinks(links);
      }
    } catch (linkErr) {
      if (process.env.OPENCLAW_MEMORY_L3_DEBUG === "1") {
        console.error(`[memory-l3] topic linking failed: ${(linkErr as Error).message}`);
      }
    }
  }

  params.buffer.drain(params.sessionId);
  params.state.l2ChunkIndex += 1;
  params.state.lastChunkId = chunkId;
  params.state.bufferTokenCount = params.buffer.totalTokens();

  const epochId = await maybeWriteEpoch({
    storage: params.storage,
    state: params.state,
    now,
  });

  return {
    chunkId,
    factsAdded: facts.length,
    typedFactsAdded: typedFacts.length,
    tokensBefore,
    messagesIngested: messages.length,
    epochId,
  };
}

function liftToTypedFact(
  extracted: ExtractedTypedFact,
  createdAt: number,
  episodic?: {
    eventTime?: number;
    sessionId?: string;
    participants?: string[];
    mentionTime?: number;
  },
): TypedFact {
  return {
    id: `tf-${randomUUID().slice(0, 8)}`,
    slot: extracted.slot,
    value: extracted.value,
    sourceSpan: extracted.sourceSpan,
    unit: extracted.unit,
    confidence: extracted.confidence,
    createdAt,
    eventTime: episodic?.eventTime,
    sessionId: episodic?.sessionId,
    participants: episodic?.participants,
    mentionTime: episodic?.mentionTime,
  };
}

async function readRecentDedupKeys(storage: Storage): Promise<string[]> {
  const paths = await storage.listL2ChunkPaths();
  if (paths.length === 0) {
    return [];
  }
  const tail = paths.slice(-RECENT_CHUNKS_TO_SCAN);
  const keys: string[] = [];
  for (const filePath of tail) {
    const doc = await storage.readL2ChunkAtPath(filePath);
    if (!doc) {
      continue;
    }
    for (const key of doc.frontmatter.dedupKeys) {
      keys.push(key);
    }
  }
  return keys.slice(-RECENT_DEDUP_KEYS_LIMIT);
}

function nextChunkId(state: L3State): string {
  const seq = String(state.l2ChunkIndex).padStart(6, "0");
  return `chunk-${seq}-${randomUUID().slice(0, 8)}`;
}

function formatChunkBody(
  messages: ReadonlyArray<AgentMessage>,
  facts: ReadonlyArray<L2Fact>,
  typedFacts: ReadonlyArray<TypedFact>,
  decisions?: ReadonlyArray<ExtractedDecision>,
  actions?: ReadonlyArray<ExtractedActionItem>,
): string {
  const factSection =
    facts.length > 0
      ? `## Facts\n${facts.map((f) => `- [${f.importance.toFixed(2)}] ${f.text}`).join("\n")}`
      : "## Facts\n(none extracted)";
  const typedSection =
    typedFacts.length > 0
      ? `## Typed facts (verbatim)\n${typedFacts
          .map(
            (t) =>
              `- \`${t.slot}\` = \`${t.value}\`${t.unit ? ` ${t.unit}` : ""} (conf ${t.confidence.toFixed(2)})`,
          )
          .join("\n")}`
      : "";
  const decisionsSection =
    decisions && decisions.length > 0
      ? `## Decisions\n${decisions.map((d) => `- (${d.maker}) ${d.text}`).join("\n")}`
      : "";
  const actionsSection =
    actions && actions.length > 0
      ? `## Action Items\n${actions.map((a) => `- (${a.owner}) ${a.text}${a.deadline ? ` [${a.deadline}]` : ""}`).join("\n")}`
      : "";
  const summarySection = `## Conversation\n${messages.length} message(s) compacted.`;
  return [factSection, typedSection, decisionsSection, actionsSection, summarySection]
    .filter((s) => s.length > 0)
    .join("\n\n");
}

// -----------------------------------------------------------------
// Segmented (per-topic) extraction — C-DIC-style incremental step
// -----------------------------------------------------------------

/** Bound on extraction calls per tick so a boundary-happy session cannot multiply LLM spend unbounded. */
const MAX_COMPACTION_SEGMENTS = 4;

/** Merge trailing ranges into one so capping never drops messages. */
function capSegmentRanges(
  ranges: Array<{ start: number; end: number }>,
  max: number,
): Array<{ start: number; end: number }> {
  if (ranges.length <= max) {
    return ranges;
  }
  const head = ranges.slice(0, max - 1);
  const tail = ranges.slice(max - 1);
  return [...head, { start: tail[0].start, end: tail[tail.length - 1].end }];
}

/**
 * Run fact extraction either monolithically (default) or per topic segment
 * when segmented compaction is enabled and an embedding provider is present.
 * Boundary-detection failures fall back to the monolithic path — extraction
 * must never fail because segmentation did.
 */
async function extractWithOptionalSegmentation(params: {
  messages: ReadonlyArray<AgentMessage>;
  caller: LlmCaller;
  embeddingProvider?: EmbeddingProvider;
  segmentedCompaction?: boolean;
  nativeCompaction?: boolean;
}): Promise<{
  extracted: ExtractResult;
  topicSegments?: Array<{ startMsgIndex: number; endMsgIndex: number }>;
}> {
  const enabled =
    params.segmentedCompaction ?? process.env.OPENCLAW_MEMORY_L3_SEGMENTED_COMPACTION === "1";
  const native =
    params.nativeCompaction ?? process.env.OPENCLAW_MEMORY_L3_NATIVE_COMPACTION === "1";
  const extractFn = native ? extractFactsNative : extractFacts;
  if (enabled && params.embeddingProvider) {
    try {
      const boundaries = await detectTopicBoundaries({
        messages: params.messages,
        embeddingProvider: params.embeddingProvider,
      });
      const ranges = capSegmentRanges(
        splitByBoundaries(params.messages.length, boundaries),
        MAX_COMPACTION_SEGMENTS,
      );
      if (ranges.length > 1) {
        const merged: ExtractResult = { facts: [], typedFacts: [], decisions: [], actions: [] };
        for (const range of ranges) {
          const segmentMessages = params.messages.slice(range.start, range.end);
          if (segmentMessages.length === 0) {
            continue;
          }
          const segment = await extractFn({ messages: segmentMessages, caller: params.caller });
          merged.facts.push(...segment.facts);
          merged.typedFacts.push(...segment.typedFacts);
          merged.decisions.push(...segment.decisions);
          merged.actions.push(...segment.actions);
        }
        l3debug(
          `extractWithOptionalSegmentation: ${ranges.length} topic segments over ${params.messages.length} messages`,
        );
        return {
          extracted: merged,
          topicSegments: ranges.map((r) => ({ startMsgIndex: r.start, endMsgIndex: r.end })),
        };
      }
    } catch (segErr) {
      if (DEBUG_ENABLED) {
        console.error(`[memory-l3] segmented extraction failed: ${String(segErr)}`);
      }
    }
  }
  return { extracted: await extractFn({ messages: params.messages, caller: params.caller }) };
}
