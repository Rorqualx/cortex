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
  type ExtractedDecision,
  type ExtractedActionItem,
  type ExtractedTypedFact,
  formatTranscriptForPrompt,
  type LlmCaller,
} from "./llm.js";
import { buildMessageChunks } from "./segmentation.js";
import type { Storage } from "./storage.js";
import type { L2ChunkFrontmatter, L2Fact, L3State, TypedFact } from "./types.js";

const DEBUG_ENABLED = process.env.OPENCLAW_MEMORY_L3_DEBUG === "1";
function l3debug(msg: string): void {
  if (DEBUG_ENABLED) console.error(`[memory-l3/compaction] ${msg}`);
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

  const extracted = await extractFacts({
    messages,
    caller: params.caller,
  });

  const filtered = dropAlreadyKnown(extracted.facts, alreadyKnownSet);
  const deduped = dedupWithinChunk(filtered);

  // Verbatim source-grounding for typed facts: the LLM's claimed values
  // must appear inside the original transcript character-for-character.
  // Anything that fails grounding is hallucinated and dropped silently.
  const transcript = formatTranscriptForPrompt(messages);
  const groundedTyped = groundAndDedupTypedFacts(extracted.typedFacts, transcript);

  const now = params.now ?? Date.now();
  const chunkId = nextChunkId(params.state);
  const facts: L2Fact[] = deduped.map((f) => liftToL2Fact(f, now));
  const typedFacts: TypedFact[] = groundedTyped.map((t) => liftToTypedFact(t, now));

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

  // Cross-session topic linking — find related chunks via embedding similarity
  if (params.embeddingProvider && facts.length > 0) {
    try {
      const chunkText = facts.map((f) => f.text).join(" ");
      const [chunkEmbedding] = await params.embeddingProvider.embedBatch([chunkText]);
      if (chunkEmbedding && chunkEmbedding.length > 0) {
        // Get long-term facts with embeddings as candidate targets
        const longterm = await params.storage.readLongTerm();
        const candidates = longterm.facts
          .filter((f) => !f.archived && f.embedding && f.embedding.length > 0)
          .map((f) => ({
            chunkId: f.sourceChunkIds[0] ?? f.id,
            embedding: f.embedding!,
          }));
        if (candidates.length > 0) {
          const links = await findTopicLinks({
            chunkId,
            chunkEmbedding,
            existingChunks: candidates,
          });
          if (links.length > 0) {
            await params.storage.appendTopicLinks(links);
          }
        }
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

function liftToTypedFact(extracted: ExtractedTypedFact, createdAt: number): TypedFact {
  return {
    id: `tf-${randomUUID().slice(0, 8)}`,
    slot: extracted.slot,
    value: extracted.value,
    sourceSpan: extracted.sourceSpan,
    unit: extracted.unit,
    confidence: extracted.confidence,
    createdAt,
  };
}

async function readRecentDedupKeys(storage: Storage): Promise<string[]> {
  const paths = await storage.listL2ChunkPaths();
  if (paths.length === 0) return [];
  const tail = paths.slice(-RECENT_CHUNKS_TO_SCAN);
  const keys: string[] = [];
  for (const filePath of tail) {
    const doc = await storage.readL2ChunkAtPath(filePath);
    if (!doc) continue;
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
