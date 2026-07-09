/**
 * Semantic epoch segmentation and message-level embedding index.
 *
 * Phase 2 enhancements:
 * - Detects topic shifts via embedding cosine similarity between consecutive
 *   message windows, replacing fixed-size 50-message epochs.
 * - Builds message-level embedding chunks so retrieval can fall through
 *   from fact-based search to raw conversation when facts miss.
 */

import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { EmbeddingProvider } from "./engine.js";
import { cosineSimilarity } from "./scoring.js";
import type { MessageChunk, TopicBoundary } from "./types.js";

const DEBUG_ENABLED = process.env.OPENCLAW_MEMORY_L3_DEBUG === "1";
function l3debug(msg: string): void {
  if (DEBUG_ENABLED) {
    console.error(`[memory-l3/segmentation] ${msg}`);
  }
}

// -----------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------

/** Window size for message-level chunks. */
export const MESSAGE_WINDOW_SIZE = 10;

/** Overlap between consecutive windows for continuity. */
export const MESSAGE_WINDOW_OVERLAP = 2;

/**
 * Cosine similarity threshold below which a topic boundary is detected.
 * Empirically, 0.5 is a good balance: higher splits too aggressively,
 * lower misses real topic shifts.
 */
export const TOPIC_SHIFT_THRESHOLD = 0.5;

// -----------------------------------------------------------------
// Semantic epoch segmentation
// -----------------------------------------------------------------

/**
 * Detect topic boundaries in a sequence of messages by computing cosine
 * similarity between consecutive sliding-window embeddings. When similarity
 * drops below the threshold, a topic boundary is marked.
 *
 * Returns an array of message indices where topic shifts occur, plus
 * the similarity score at each boundary.
 */
export async function detectTopicBoundaries(params: {
  messages: ReadonlyArray<AgentMessage>;
  embeddingProvider: EmbeddingProvider;
  windowSize?: number;
  threshold?: number;
}): Promise<TopicBoundary[]> {
  const windowSize = params.windowSize ?? MESSAGE_WINDOW_SIZE;
  const threshold = params.threshold ?? TOPIC_SHIFT_THRESHOLD;

  if (params.messages.length < windowSize * 2) {
    // Not enough messages for meaningful boundary detection
    return [];
  }

  // Build text windows (non-overlapping for boundary detection)
  const windows: string[] = [];
  for (let i = 0; i < params.messages.length; i += windowSize) {
    const slice = params.messages.slice(i, Math.min(i + windowSize, params.messages.length));
    const text = slice
      .map((m) => {
        const content = (m as { content?: unknown }).content;
        if (typeof content === "string") {
          return content;
        }
        if (Array.isArray(content)) {
          return content
            .filter((b): b is { type: string; text?: string } => typeof b === "object" && b != null)
            .map((b) => b.text ?? "")
            .join(" ");
        }
        return "";
      })
      .filter((s) => s.length > 0)
      .join(" ");
    if (text.length > 0) {
      windows.push(text);
    }
  }

  if (windows.length < 2) {
    return [];
  }

  // Batch-embed all windows at once
  const embeddings = await params.embeddingProvider.embedBatch(windows);

  const boundaries: TopicBoundary[] = [];
  for (let i = 1; i < embeddings.length; i++) {
    if (!embeddings[i - 1] || !embeddings[i]) {
      continue;
    }
    const sim = cosineSimilarity(embeddings[i - 1], embeddings[i]);
    if (sim < threshold) {
      boundaries.push({
        messageIndex: i * windowSize,
        similarity: sim,
        threshold,
      });
    }
  }

  if (boundaries.length > 0) {
    l3debug(
      `detectTopicBoundaries: ${boundaries.length} boundary(ies) in ${params.messages.length} messages (threshold=${threshold})`,
    );
  }

  return boundaries;
}

/**
 * Split messages into epochs based on detected topic boundaries.
 * Returns arrays of message indices, each representing one epoch.
 * Falls back to a single epoch covering all messages when no boundaries
 * are detected.
 */
export function splitByBoundaries(
  totalMessages: number,
  boundaries: ReadonlyArray<TopicBoundary>,
): Array<{ start: number; end: number }> {
  if (boundaries.length === 0) {
    return [{ start: 0, end: totalMessages }];
  }

  const epochs: Array<{ start: number; end: number }> = [];
  let prev = 0;
  for (const boundary of boundaries) {
    if (boundary.messageIndex > prev) {
      epochs.push({ start: prev, end: boundary.messageIndex });
    }
    prev = boundary.messageIndex;
  }
  if (prev < totalMessages) {
    epochs.push({ start: prev, end: totalMessages });
  }

  return epochs;
}

// -----------------------------------------------------------------
// Segment-type classification (topic-aware compaction)
// -----------------------------------------------------------------

/** Segment type for topic-aware extraction density. */
export type SegmentType = "technical" | "procedural" | "conversational";

// Heuristic signals for cheap segment-type classification.
const CODE_BLOCK_RE = /```[\s\S]*?```/g;
const CODE_FENCE_RE = /```/;
const FILE_PATH_RE = /(?:\/[\w.-]+)+\.[a-z]{1,5}\b/i;
const SHELL_COMMAND_RE = /^\s*[$>]\s|\b(npm|pnpm|pip|git|docker|kubectl|curl|wget|ssh|scp)\s/u;
const NUMBERED_LIST_RE = /^\s*\d+[.)]/mu;
const INSTRUCTION_VERB_RE =
  /\b(run|execute|install|configure|deploy|build|compile|test|check|verify|validate|commit|push|merge|rebase|backup|restore|migrate|generate|create|update|delete|remove|replace)\b/iu;
const QUESTION_RE = /\?/;
const GREETING_RE =
  /\b(hi|hey|hello|thanks|thank you|bye|good morning|good evening|good night|see you|cheers|no problem|you'?re welcome|np)\b/iu;

export function classifySegmentType(messages: ReadonlyArray<AgentMessage>): SegmentType {
  const joined = messages
    .map((m) => {
      const content = (m as { content?: unknown }).content;
      if (typeof content === "string") {
        return content;
      }
      if (Array.isArray(content)) {
        return content
          .filter((b): b is { type: string; text?: string } => typeof b === "object" && b != null)
          .map((b) => b.text ?? "")
          .join(" ");
      }
      return "";
    })
    .join("\n");

  // Count signals per type
  let technical = 0;
  let procedural = 0;
  let conversational = 0;

  // Technical: code blocks, file paths, shell commands, URLs
  const codeBlocks = joined.match(CODE_BLOCK_RE);
  if (codeBlocks) {
    technical += codeBlocks.length * 3; // code blocks are strong signals
  }
  if (CODE_FENCE_RE.test(joined)) {
    technical += 1;
  }
  const filePaths = joined.match(FILE_PATH_RE);
  if (filePaths) {
    technical += filePaths.length * 2;
  }
  const shellMatches = joined.match(SHELL_COMMAND_RE);
  if (shellMatches) {
    technical += shellMatches.length * 2;
  }

  // Procedural: numbered lists, instruction verbs, tool-call patterns
  const numLists = joined.match(NUMBERED_LIST_RE);
  if (numLists) {
    procedural += numLists.length * 1.5;
  }
  const instrVerbs = joined.match(INSTRUCTION_VERB_RE);
  if (instrVerbs) {
    procedural += Math.min(instrVerbs.length, 10); // cap to avoid overflow on long segments
  }

  // Conversational: question marks, greetings, short messages
  const questions = joined.match(QUESTION_RE);
  if (questions) {
    conversational += questions.length;
  }
  const greetings = joined.match(GREETING_RE);
  if (greetings) {
    conversational += greetings.length * 1.5;
  }

  // Normalize by message count to avoid bias against long segments
  const msgCount = Math.max(1, messages.length);
  const techNorm = technical / msgCount;
  const procNorm = procedural / msgCount;
  const convNorm = conversational / msgCount;

  // Classification thresholds
  if (techNorm >= 0.5) {
    return "technical";
  }
  if (convNorm >= 0.8 && convNorm > procNorm && convNorm > techNorm) {
    return "conversational";
  }
  if (procNorm >= 0.3) {
    return "procedural";
  }

  // Default: conversational for low-signal segments
  return "conversational";
}

// Per-segment-type extraction prompt suffixes for topic-aware compaction.
// Technical segments: ask for full detail (no suffix — current behavior).
// Procedural segments: emphasize actionable steps and tool-call documentation.
// Conversational segments: compress aggressively — only decisions, preferences, high-importance.
const SEGMENT_TYPE_PROMPT_SUFFIX: Record<SegmentType, string> = {
  technical: "", // current behavior — full detail
  procedural:
    "\nEXTRACTION MODE: PROCEDURAL. Emphasize actionable steps, tool-call sequences, and verification checkpoints. Extract all facts.",
  conversational:
    "\nEXTRACTION MODE: CONVERSATIONAL. Compress aggressively. Extract only decisions, explicit user preferences (importance 0.7+), and safety-critical facts. Omit casual banter.",
};

export function getSegmentTypePromptSuffix(type: SegmentType): string {
  return SEGMENT_TYPE_PROMPT_SUFFIX[type] ?? "";
}

// -----------------------------------------------------------------
// Message-level embedding index
// -----------------------------------------------------------------

/**
 * Build message-level embedding chunks from a sequence of messages.
 * Each chunk covers a sliding window of MESSAGE_WINDOW_SIZE messages
 * with MESSAGE_WINDOW_OVERLAP overlap for continuity.
 *
 * Returns chunks with pre-computed embeddings ready for storage and
 * retrieval.
 */
export async function buildMessageChunks(params: {
  messages: ReadonlyArray<AgentMessage>;
  embeddingProvider: EmbeddingProvider;
  chunkId: string;
  now?: number;
  windowSize?: number;
  overlap?: number;
}): Promise<MessageChunk[]> {
  const windowSize = params.windowSize ?? MESSAGE_WINDOW_SIZE;
  const overlap = params.overlap ?? MESSAGE_WINDOW_OVERLAP;
  const now = params.now ?? Date.now();
  const step = Math.max(1, windowSize - overlap);

  if (params.messages.length === 0) {
    return [];
  }

  const chunks: Array<{ start: number; end: number; text: string }> = [];
  for (let i = 0; i < params.messages.length; i += step) {
    const end = Math.min(i + windowSize, params.messages.length);
    const slice = params.messages.slice(i, end);
    const text = slice
      .map((m) => {
        const content = (m as { content?: unknown }).content;
        if (typeof content === "string") {
          return content;
        }
        if (Array.isArray(content)) {
          return content
            .filter((b): b is { type: string; text?: string } => typeof b === "object" && b != null)
            .map((b) => b.text ?? "")
            .join(" ");
        }
        return "";
      })
      .filter((s) => s.length > 0)
      .join("\n");
    if (text.length > 0) {
      chunks.push({ start: i, end, text });
    }
  }

  if (chunks.length === 0) {
    return [];
  }

  // Batch-embed all chunk texts at once
  const texts = chunks.map((c) => c.text);
  let embeddings: number[][];
  try {
    embeddings = await params.embeddingProvider.embedBatch(texts);
  } catch (err) {
    l3debug(`buildMessageChunks: embedding failed: ${(err as Error).message}`);
    return [];
  }

  return chunks.map((c, i) => ({
    id: `msg-${params.chunkId}-${i}`,
    seq: i,
    startMsgIndex: c.start,
    endMsgIndex: c.end,
    text: c.text,
    embedding: embeddings[i] ?? [],
    createdAt: now,
    chunkId: params.chunkId,
  }));
}
