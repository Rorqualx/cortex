import { randomUUID } from "node:crypto";
import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import { dedupWithinChunk, dropAlreadyKnown, liftToL2Fact } from "./dedup.js";
import { maybeWriteEpoch } from "./epoch.js";
import type { IngestBuffer } from "./ingest.js";
import { extractFacts, type LlmCaller } from "./llm.js";
import type { Storage } from "./storage.js";
import type { L2ChunkFrontmatter, L2Fact, L3State } from "./types.js";

export type CompactionResult = {
  chunkId: string | null;
  factsAdded: number;
  tokensBefore: number;
  messagesIngested: number;
  epochId: string | null;
};

const RECENT_DEDUP_KEYS_LIMIT = 50;
const RECENT_CHUNKS_TO_SCAN = 10;

export async function compactSession(params: {
  sessionId: string;
  buffer: IngestBuffer;
  storage: Storage;
  caller: LlmCaller;
  state: L3State;
}): Promise<CompactionResult> {
  const messages = [...params.buffer.peek(params.sessionId)];
  const tokensBefore = params.buffer.tokens(params.sessionId);
  if (messages.length === 0) {
    return { chunkId: null, factsAdded: 0, tokensBefore: 0, messagesIngested: 0, epochId: null };
  }

  const alreadyKnownKeys = await readRecentDedupKeys(params.storage);
  const alreadyKnownSet = new Set(alreadyKnownKeys);

  const extracted = await extractFacts({
    messages,
    alreadyKnownKeys,
    caller: params.caller,
  });

  const filtered = dropAlreadyKnown(extracted, alreadyKnownSet);
  const deduped = dedupWithinChunk(filtered);

  const now = Date.now();
  const chunkId = nextChunkId(params.state);
  const facts: L2Fact[] = deduped.map((f) => liftToL2Fact(f, now));

  const frontmatter: L2ChunkFrontmatter = {
    id: chunkId,
    agentId: params.state.agentId,
    startTurnIndex: 0,
    endTurnIndex: messages.length,
    createdAt: now,
    facts,
    dedupKeys: facts.map((f) => f.dedupKey),
  };

  await params.storage.writeL2Chunk(frontmatter, formatChunkBody(messages, facts));

  for (const message of messages) {
    await params.storage.appendL1Archive(chunkId, message);
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
    tokensBefore,
    messagesIngested: messages.length,
    epochId,
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
): string {
  const factSection =
    facts.length > 0
      ? `## Facts\n${facts.map((f) => `- [${f.importance.toFixed(2)}] ${f.text}`).join("\n")}`
      : "## Facts\n(none extracted)";
  const summarySection = `## Conversation\n${messages.length} message(s) compacted.`;
  return `${factSection}\n\n${summarySection}`;
}
