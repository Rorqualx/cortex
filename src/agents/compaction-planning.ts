import { stripRuntimeContextCustomMessages } from "./internal-runtime-context.js";
import type { AgentMessage } from "./runtime/index.js";
import { repairToolUseResultPairing, stripToolResultDetails } from "./session-transcript-repair.js";
import { estimateTokens } from "./sessions/index.js";
import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "./system-prompt-cache-boundary.js";
import { extractToolCallsFromAssistant, extractToolResultId } from "./tool-call-id.js";

export const BASE_CHUNK_RATIO = 0.4;
export const MIN_CHUNK_RATIO = 0.15;
export const SAFETY_MARGIN = 1.2; // 20% buffer for estimateTokens() inaccuracy
const DEFAULT_PARTS = 2;

// Overhead reserved for summarization prompt, system prompt, previous summary,
// and serialization wrappers (<conversation> tags, instructions, etc.).
// generateSummary uses reasoning: "high" which also consumes context budget.
export const SUMMARIZATION_OVERHEAD_TOKENS = 4096;

export type StageSplitPlan =
  | {
      mode: "single";
    }
  | {
      mode: "split";
      chunks: AgentMessage[][];
    };

export type OversizedFallbackPlan = {
  smallMessages: AgentMessage[];
  oversizedNotes: string[];
};

export type HistoryPrunePlan = {
  summarizableTokens: number;
  newContentTokens: number;
  maxHistoryTokens: number;
  pruned?: ReturnType<typeof pruneHistoryForContextShare>;
};

export function estimateMessagesTokens(messages: AgentMessage[]): number {
  // SECURITY: toolResult.details and runtime-context transcript entries must never enter LLM-facing compaction.
  const safe = sanitizeCompactionMessages(messages);
  return safe.reduce((sum, message) => sum + estimateTokens(message), 0);
}

export function sanitizeCompactionMessages(messages: AgentMessage[]): AgentMessage[] {
  return stripToolResultDetails(stripRuntimeContextCustomMessages(messages));
}

export function estimateCompactionMessageTokens(message: AgentMessage): number {
  return estimateMessagesTokens([message]);
}

export function normalizeCompactionParts(parts: number, messageCount: number): number {
  if (!Number.isFinite(parts) || parts <= 1) {
    return 1;
  }
  return Math.min(Math.max(1, Math.floor(parts)), Math.max(1, messageCount));
}

export function splitMessagesByTokenShare(
  messages: AgentMessage[],
  parts = DEFAULT_PARTS,
): AgentMessage[][] {
  if (messages.length === 0) {
    return [];
  }
  const normalizedParts = normalizeCompactionParts(parts, messages.length);
  if (normalizedParts <= 1) {
    return [messages];
  }

  const totalTokens = estimateMessagesTokens(messages);
  const targetTokens = totalTokens / normalizedParts;
  const chunks: AgentMessage[][] = [];
  let current: AgentMessage[] = [];
  let currentTokens = 0;

  let pendingToolCallIds = new Set<string>();
  let pendingChunkStartIndex: number | null = null;

  const splitCurrentAtPendingBoundary = (): boolean => {
    if (
      pendingChunkStartIndex === null ||
      pendingChunkStartIndex <= 0 ||
      chunks.length >= normalizedParts - 1
    ) {
      return false;
    }
    chunks.push(current.slice(0, pendingChunkStartIndex));
    current = current.slice(pendingChunkStartIndex);
    currentTokens = current.reduce((sum, msg) => sum + estimateCompactionMessageTokens(msg), 0);
    pendingChunkStartIndex = 0;
    return true;
  };

  for (const message of messages) {
    const messageTokens = estimateCompactionMessageTokens(message);

    if (
      pendingToolCallIds.size === 0 &&
      chunks.length < normalizedParts - 1 &&
      current.length > 0 &&
      currentTokens + messageTokens > targetTokens
    ) {
      chunks.push(current);
      current = [];
      currentTokens = 0;
      pendingChunkStartIndex = null;
    }

    current.push(message);
    currentTokens += messageTokens;

    if (message.role === "assistant") {
      const toolCalls = extractToolCallsFromAssistant(message);
      const stopReason = (message as { stopReason?: unknown }).stopReason;
      const keepsPending =
        stopReason !== "aborted" && stopReason !== "error" && toolCalls.length > 0;
      pendingToolCallIds = new Set();
      if (keepsPending) {
        for (const toolCall of toolCalls) {
          pendingToolCallIds.add(toolCall.id);
        }
      }
      pendingChunkStartIndex = keepsPending ? current.length - 1 : null;
    } else if (message.role === "toolResult" && pendingToolCallIds.size > 0) {
      const resultId = extractToolResultId(message);
      if (!resultId) {
        pendingToolCallIds = new Set();
        pendingChunkStartIndex = null;
      } else {
        pendingToolCallIds.delete(resultId);
      }
      if (
        pendingToolCallIds.size === 0 &&
        chunks.length < normalizedParts - 1 &&
        currentTokens > targetTokens
      ) {
        splitCurrentAtPendingBoundary();
        pendingChunkStartIndex = null;
      }
    }
  }

  if (pendingToolCallIds.size > 0 && currentTokens > targetTokens) {
    splitCurrentAtPendingBoundary();
  }

  if (current.length > 0) {
    chunks.push(current);
  }

  return chunks;
}

export function chunkMessagesByMaxTokens(
  messages: AgentMessage[],
  maxTokens: number,
): AgentMessage[][] {
  if (messages.length === 0) {
    return [];
  }

  // Apply safety margin to compensate for estimateTokens() underestimation
  // (chars/4 heuristic misses multi-byte chars, special tokens, code tokens, etc.)
  const effectiveMax = Math.max(1, Math.floor(maxTokens / SAFETY_MARGIN));

  const chunks: AgentMessage[][] = [];
  let currentChunk: AgentMessage[] = [];
  let currentTokens = 0;

  for (const message of messages) {
    const messageTokens = estimateCompactionMessageTokens(message);
    if (currentChunk.length > 0 && currentTokens + messageTokens > effectiveMax) {
      chunks.push(currentChunk);
      currentChunk = [];
      currentTokens = 0;
    }

    currentChunk.push(message);
    currentTokens += messageTokens;

    if (messageTokens > effectiveMax) {
      // Split oversized messages to avoid unbounded chunk growth.
      chunks.push(currentChunk);
      currentChunk = [];
      currentTokens = 0;
    }
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }

  return chunks;
}

/**
 * Compute adaptive chunk ratio based on average message size.
 * When messages are large, we use smaller chunks to avoid exceeding model limits.
 */
export function computeAdaptiveChunkRatio(messages: AgentMessage[], contextWindow: number): number {
  if (messages.length === 0) {
    return BASE_CHUNK_RATIO;
  }

  const totalTokens = estimateMessagesTokens(messages);
  const avgTokens = totalTokens / messages.length;

  // Apply safety margin to account for estimation inaccuracy
  const safeAvgTokens = avgTokens * SAFETY_MARGIN;
  const avgRatio = safeAvgTokens / contextWindow;

  // If average message is > 10% of context, reduce chunk ratio
  if (avgRatio > 0.1) {
    const reduction = Math.min(avgRatio * 2, BASE_CHUNK_RATIO - MIN_CHUNK_RATIO);
    return Math.max(MIN_CHUNK_RATIO, BASE_CHUNK_RATIO - reduction);
  }

  return BASE_CHUNK_RATIO;
}

/**
 * Check if a single message is too large to summarize.
 * If single message > 50% of context, it can't be summarized safely.
 */
export function isOversizedForSummary(msg: AgentMessage, contextWindow: number): boolean {
  const tokens = estimateCompactionMessageTokens(msg) * SAFETY_MARGIN;
  return tokens > contextWindow * 0.5;
}

export function buildSummaryChunks(params: {
  messages: AgentMessage[];
  maxChunkTokens: number;
}): AgentMessage[][] {
  // SECURITY: never feed toolResult.details or runtime-context transcript entries into summarization prompts.
  const safeMessages = sanitizeCompactionMessages(params.messages);
  return chunkMessagesByMaxTokens(safeMessages, params.maxChunkTokens);
}

export function buildOversizedFallbackPlan(params: {
  messages: AgentMessage[];
  contextWindow: number;
}): OversizedFallbackPlan {
  const smallMessages: AgentMessage[] = [];
  const oversizedNotes: string[] = [];

  for (const msg of params.messages) {
    if (isOversizedForSummary(msg, params.contextWindow)) {
      const role = (msg as { role?: string }).role ?? "message";
      const tokens = estimateCompactionMessageTokens(msg);
      oversizedNotes.push(
        `[Large ${role} (~${Math.round(tokens / 1000)}K tokens) omitted from summary]`,
      );
    } else {
      smallMessages.push(msg);
    }
  }

  return { smallMessages, oversizedNotes };
}

export function buildStageSplitPlan(params: {
  messages: AgentMessage[];
  maxChunkTokens: number;
  parts?: number;
  minMessagesForSplit?: number;
}): StageSplitPlan {
  const minMessagesForSplit = Math.max(2, params.minMessagesForSplit ?? 4);
  const parts = normalizeCompactionParts(params.parts ?? DEFAULT_PARTS, params.messages.length);
  const totalTokens = estimateMessagesTokens(params.messages);

  if (
    parts <= 1 ||
    params.messages.length < minMessagesForSplit ||
    totalTokens <= params.maxChunkTokens
  ) {
    return { mode: "single" };
  }

  const chunks = splitMessagesByTokenShare(params.messages, parts).filter(
    (chunk) => chunk.length > 0,
  );
  return chunks.length > 1 ? { mode: "split", chunks } : { mode: "single" };
}

export function pruneHistoryForContextShare(params: {
  messages: AgentMessage[];
  maxContextTokens: number;
  maxHistoryShare?: number;
  parts?: number;
  mode?: "share" | "handoff";
}): {
  messages: AgentMessage[];
  droppedMessagesList: AgentMessage[];
  droppedChunks: number;
  droppedMessages: number;
  droppedTokens: number;
  keptTokens: number;
  budgetTokens: number;
} {
  const isHandoff = params.mode === "handoff";
  const defaultShare = isHandoff ? 0.2 : 0.5; // Stricter budget for handoff snapshots
  const maxHistoryShare = params.maxHistoryShare ?? defaultShare;
  const budgetTokens = Math.max(1, Math.floor(params.maxContextTokens * maxHistoryShare));
  let keptMessages = params.messages;
  const allDroppedMessages: AgentMessage[] = [];
  let droppedChunks = 0;
  let droppedMessages = 0;
  let droppedTokens = 0;

  const parts = normalizeCompactionParts(params.parts ?? DEFAULT_PARTS, keptMessages.length);

  while (keptMessages.length > 0 && estimateMessagesTokens(keptMessages) > budgetTokens) {
    const chunks = splitMessagesByTokenShare(keptMessages, parts);
    if (chunks.length <= 1) {
      break;
    }
    const [dropped, ...rest] = chunks;
    const flatRest = rest.flat();

    // After dropping a chunk, repair tool_use/tool_result pairing to handle
    // orphaned tool_results (whose tool_use was in the dropped chunk).
    // repairToolUseResultPairing drops orphaned tool_results, preventing
    // "unexpected tool_use_id" errors from Anthropic's API.
    const repairReport = repairToolUseResultPairing(flatRest);
    const repairedKept = repairReport.messages;

    // Track orphaned tool_results as dropped (they were in kept but their tool_use was dropped)
    const orphanedCount = repairReport.droppedOrphanCount;

    droppedChunks += 1;
    droppedMessages += dropped.length + orphanedCount;
    droppedTokens += estimateMessagesTokens(dropped);
    // Note: We don't have the actual orphaned messages to add to droppedMessagesList
    // since repairToolUseResultPairing doesn't return them. This is acceptable since
    // the dropped messages are used for summarization, and orphaned tool_results
    // without their tool_use context aren't useful for summarization anyway.
    allDroppedMessages.push(...dropped);
    keptMessages = repairedKept;
  }

  return {
    messages: keptMessages,
    droppedMessagesList: allDroppedMessages,
    droppedChunks,
    droppedMessages,
    droppedTokens,
    keptTokens: estimateMessagesTokens(keptMessages),
    budgetTokens,
  };
}

export function buildHistoryPrunePlan(params: {
  messagesToSummarize: AgentMessage[];
  turnPrefixMessages: AgentMessage[];
  tokensBefore: number;
  contextWindowTokens: number;
  maxHistoryShare: number;
  parts?: number;
}): HistoryPrunePlan {
  const summarizableTokens =
    estimateMessagesTokens(params.messagesToSummarize) +
    estimateMessagesTokens(params.turnPrefixMessages);
  const newContentTokens = Math.max(0, Math.floor(params.tokensBefore - summarizableTokens));
  // Apply SAFETY_MARGIN so token underestimates don't trigger unnecessary pruning.
  const maxHistoryTokens = Math.floor(
    params.contextWindowTokens * params.maxHistoryShare * SAFETY_MARGIN,
  );

  if (newContentTokens <= maxHistoryTokens) {
    return {
      summarizableTokens,
      newContentTokens,
      maxHistoryTokens,
    };
  }

  return {
    summarizableTokens,
    newContentTokens,
    maxHistoryTokens,
    pruned: pruneHistoryForContextShare({
      messages: params.messagesToSummarize,
      maxContextTokens: params.contextWindowTokens,
      maxHistoryShare: params.maxHistoryShare,
      parts: params.parts,
    }),
  };
}

/**
 * Cache-aware compaction: Detect and preserve prompt cache boundaries.
 *
 * When a system prompt contains the cache boundary marker, content before
 * the marker is cached by the model. Content after is not cached and is
 * re-processed on each request.
 *
 * Cache-aware compaction preserves cache-carryover content (before boundary)
 * and applies more aggressive compaction to dynamic content (after boundary).
 * This improves cache hit rates and reduces token costs.
 */

/**
 * Position of a cache boundary within messages.
 */
export type CacheBoundaryPosition = {
  /** Index of the message containing the boundary */
  messageIndex: number;
  /** Whether this is the start of cache-carryover content */
  isCacheStart: boolean;
  /** Whether this is the end of cache-carryover content */
  isCacheEnd: boolean;
  /** Approximate character offset within the message body */
  charOffset?: number;
};

/**
 * Result of cache boundary detection.
 */
export type CacheBoundaryDetection = {
  /** Whether any cache boundaries were detected */
  hasBoundary: boolean;
  /** All detected boundary positions */
  positions: CacheBoundaryPosition[];
  /** Index of the first message after the cache boundary (dynamic content) */
  firstDynamicIndex?: number;
  /** Token count before boundary (cache-carryover) */
  cachedTokens?: number;
  /** Token count after boundary (dynamic) */
  dynamicTokens?: number;
};

/**
 * Detect cache boundaries in a list of messages.
 *
 * Scans message bodies for the cache boundary marker and returns
 * position information for chunking decisions.
 */
export function detectCacheBoundaries(messages: AgentMessage[]): CacheBoundaryDetection {
  const positions: CacheBoundaryPosition[] = [];
  let firstDynamicIndex: number | undefined;
  let boundarySeen = false;

  for (const [index, msg] of messages.entries()) {
    const body = extractMessageBody(msg);
    if (!body) continue;

    const boundaryIndex = body.indexOf(SYSTEM_PROMPT_CACHE_BOUNDARY);
    if (boundaryIndex !== -1) {
      positions.push({
        messageIndex: index,
        isCacheStart: !boundarySeen,
        isCacheEnd: true, // The boundary marks the end of cached content
        charOffset: boundaryIndex,
      });
      boundarySeen = true;

      // First message after boundary is dynamic content
      if (firstDynamicIndex === undefined) {
        firstDynamicIndex = index;
      }
    }
  }

  // Calculate token counts
  let cachedTokens = 0;
  let dynamicTokens = 0;

  if (firstDynamicIndex !== undefined) {
    const boundaryMsg = messages[firstDynamicIndex];
    const boundaryBody = extractMessageBody(boundaryMsg);
    const boundaryPos = positions.find((p) => p.messageIndex === firstDynamicIndex);

    // Messages fully before the boundary are cached
    cachedTokens = estimateMessagesTokens(messages.slice(0, firstDynamicIndex));

    // For the boundary message, estimate tokens for cached portion (before boundary)
    if (boundaryBody && boundaryPos?.charOffset !== undefined) {
      const cachedPortion = boundaryBody.slice(0, boundaryPos.charOffset);
      cachedTokens += estimateTokens({ role: "user", content: cachedPortion });
    }

    // For the boundary message, estimate tokens for dynamic portion (after boundary)
    if (boundaryBody && boundaryPos?.charOffset !== undefined) {
      const boundaryMarkerLength = SYSTEM_PROMPT_CACHE_BOUNDARY.length;
      const dynamicPortion = boundaryBody.slice(boundaryPos.charOffset + boundaryMarkerLength);
      // Assistant messages require content as an array of blocks for estimateTokens
      dynamicTokens += estimateTokens({
        role: "assistant",
        content: [{ type: "text", text: dynamicPortion }],
      });
    } else {
      // If we can't split, count the whole boundary message as dynamic
      dynamicTokens += estimateCompactionMessageTokens(boundaryMsg);
    }

    // Messages after the boundary are fully dynamic
    dynamicTokens += estimateMessagesTokens(messages.slice(firstDynamicIndex + 1));
  }

  return {
    hasBoundary: boundarySeen,
    positions,
    firstDynamicIndex,
    cachedTokens,
    dynamicTokens,
  };
}

/**
 * Extract message body as string for boundary detection.
 *
 * Handles both string content and array content (for assistant messages).
 * For array content, concatenates text blocks together.
 */
function extractMessageBody(msg: AgentMessage): string | undefined {
  if (typeof msg === "string") return msg;
  if (typeof msg === "object" && msg !== null) {
    const content = (msg as { content?: string | unknown }).content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      // Handle assistant message content blocks
      const textBlocks = content
        .filter((block) => block?.type === "text" && typeof block?.text === "string")
        .map((block) => block.text as string);
      if (textBlocks.length > 0) return textBlocks.join("");
    }
  }
  return undefined;
}

/**
 * Cache-aware chunking options.
 */
export type CacheAwareChunkingOptions = {
  /** Maximum tokens per chunk */
  maxTokens: number;
  /** Whether to preserve cache-carryover content */
  preserveCacheCarryover?: boolean;
  /** Extra buffer for cache-carryover content (default: 1.2x) */
  cacheBufferMultiplier?: number;
};

/**
 * Cache-aware chunking result.
 */
export type CacheAwareChunkPlan = {
  /** Chunks respecting cache boundaries */
  chunks: AgentMessage[][];
  /** Cache boundary detection result */
  detection: CacheBoundaryDetection;
  /** Whether cache content was preserved */
  cachePreserved: boolean;
};

/**
 * Build cache-aware chunking plan.
 *
 * When cache boundaries are detected, this function:
 * 1. Preserves cache-carryover content (before boundary)
 * 2. Splits dynamic content (after boundary) using maxTokens
 * 3. Prefers splitting at cache boundaries when possible
 *
 * This improves cache hit rates by keeping cached content intact
 * and only compressing dynamic conversation content.
 */
export function buildCacheAwareChunkPlan(
  messages: AgentMessage[],
  options: CacheAwareChunkingOptions,
): CacheAwareChunkPlan {
  const detection = detectCacheBoundaries(messages);
  const { maxTokens, preserveCacheCarryover = true, cacheBufferMultiplier = 1.2 } = options;

  // No cache boundary detected - use standard chunking
  if (!detection.hasBoundary) {
    return {
      chunks: chunkMessagesByMaxTokens(messages, maxTokens),
      detection,
      cachePreserved: false,
    };
  }

  const chunks: AgentMessage[][] = [];

  // Preserve cache-carryover content
  if (preserveCacheCarryover && detection.firstDynamicIndex !== undefined) {
    const cachedContent = messages.slice(0, detection.firstDynamicIndex + 1);
    chunks.push(cachedContent);
  }

  // Chunk dynamic content
  const dynamicContent =
    detection.firstDynamicIndex !== undefined
      ? messages.slice(detection.firstDynamicIndex + 1)
      : messages;

  if (dynamicContent.length > 0) {
    const dynamicChunks = chunkMessagesByMaxTokens(dynamicContent, maxTokens);
    chunks.push(...dynamicChunks);
  }

  return {
    chunks,
    detection,
    cachePreserved: preserveCacheCarryover,
  };
}

/**
 * Check if cache-aware chunking is beneficial for this message set.
 *
 * Returns true when:
 * - Cache boundary exists
 * - Cached content is substantial (>10% of total)
 * - Dynamic content exceeds chunk threshold
 */
export function isCacheAwareChunkingBeneficial(
  messages: AgentMessage[],
  maxTokens: number,
): boolean {
  const detection = detectCacheBoundaries(messages);
  if (!detection.hasBoundary) return false;

  // No benefit if maxTokens is zero or negative
  if (maxTokens <= 0) return false;

  const totalTokens = estimateMessagesTokens(messages);
  if (totalTokens === 0) return false;

  // Check if cached content is substantial
  const cachedRatio =
    detection.cachedTokens !== undefined && totalTokens > 0
      ? detection.cachedTokens / totalTokens
      : 0;

  // Use pre-calculated dynamicTokens from detection which correctly includes
  // the dynamic portion of the boundary message plus all subsequent messages
  const dynamicTokens = detection.dynamicTokens ?? 0;

  return cachedRatio > 0.1 && dynamicTokens > maxTokens * 0.5;
}
