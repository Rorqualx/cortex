/**
 * Tests for cache-aware compaction chunking.
 *
 * Verifies that cache boundary detection and cache-aware chunking:
 * - Correctly identifies cache boundaries in messages
 * - Preserves cache-carryover content
 * - Applies aggressive chunking to dynamic content
 * - Improves cache hit rates by respecting boundaries
 */

// SKIP: detectCacheBoundaries, buildCacheAwareChunkPlan, isCacheAwareChunkingBeneficial,
// and CacheAwareChunkingOptions are fork-only additions to compaction-planning.ts that
// were not merged into production. Tests are skipped until these APIs are exported from
// compaction-planning.ts.
import { describe, it, expect } from "vitest";
import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "./system-prompt-cache-boundary.js";

// Stub types and functions so the skipped block type-checks cleanly.
type AgentMessage = {
  role: string;
  content: unknown;
  timestamp: number;
  usage?: unknown;
  stopReason?: unknown;
};
type CacheAwareChunkingOptions = {
  maxTokens?: number;
  preserveCacheCarryover?: boolean;
  cacheBufferMultiplier?: number;
};
type CacheBoundaryResult = {
  hasBoundary: boolean;
  positions: Array<{
    messageIndex: number;
    isCacheStart?: boolean;
    isCacheEnd?: boolean;
    charOffset?: number;
  }>;
  firstDynamicIndex?: number;
  cachedTokens?: number;
  dynamicTokens?: number;
};
type CacheAwareChunkPlan = {
  cachePreserved: boolean;
  chunks: AgentMessage[][];
  detection: CacheBoundaryResult;
};
const detectCacheBoundaries = (_messages: AgentMessage[]): CacheBoundaryResult => ({
  hasBoundary: false,
  positions: [],
});
const buildCacheAwareChunkPlan = (
  _messages: AgentMessage[],
  _options?: CacheAwareChunkingOptions,
): CacheAwareChunkPlan => ({
  cachePreserved: false,
  chunks: [],
  detection: { hasBoundary: false, positions: [] },
});
const isCacheAwareChunkingBeneficial = (
  _messages: AgentMessage[],
  _contextWindow: number,
): boolean => false;

/**
 * Helper to create a simple user message with text content.
 */
function makeUserMessage(id: number, content: string): AgentMessage {
  return {
    role: "user",
    content,
    timestamp: id,
  };
}

/**
 * Helper to create an assistant message with text content.
 *
 * NOTE: Assistant messages require content as an array of blocks per AgentMessage spec.
 * estimateTokens() expects this format for accurate token calculation.
 */
function makeAssistantMessage(id: number, text: string): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    timestamp: id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
  };
}

describe.skip("compaction: cache-aware chunking", () => {
  describe("detectCacheBoundaries", () => {
    it("should detect no boundaries in messages without cache marker", () => {
      const messages: AgentMessage[] = [
        makeUserMessage(1, "Hello world"),
        makeAssistantMessage(2, "Hi there!"),
      ];

      const result = detectCacheBoundaries(messages);

      expect(result.hasBoundary).toBe(false);
      expect(result.positions).toHaveLength(0);
      expect(result.firstDynamicIndex).toBeUndefined();
    });

    it("should detect single cache boundary in system prompt", () => {
      const systemPrompt = `You are a helpful assistant.${SYSTEM_PROMPT_CACHE_BOUNDARY}\nCurrent context follows.`;
      const messages: AgentMessage[] = [
        makeUserMessage(1, systemPrompt),
        makeAssistantMessage(2, "Response"),
      ];

      const result = detectCacheBoundaries(messages);

      expect(result.hasBoundary).toBe(true);
      expect(result.positions).toHaveLength(1);
      expect(result.positions[0].messageIndex).toBe(0);
      expect(result.positions[0].isCacheStart).toBe(true);
      expect(result.positions[0].isCacheEnd).toBe(true);
      expect(result.firstDynamicIndex).toBe(0);
    });

    it("should detect cache boundary in middle message", () => {
      const messages: AgentMessage[] = [
        makeUserMessage(1, "First message"),
        makeAssistantMessage(
          2,
          `System instructions${SYSTEM_PROMPT_CACHE_BOUNDARY}\nDynamic context`,
        ),
        makeUserMessage(3, "Follow up"),
      ];

      const result = detectCacheBoundaries(messages);

      expect(result.hasBoundary).toBe(true);
      expect(result.positions).toHaveLength(1);
      expect(result.positions[0].messageIndex).toBe(1);
      expect(result.firstDynamicIndex).toBe(1);
    });

    it("should calculate token counts for cached and dynamic content", () => {
      const cachedContent = "A".repeat(1000); // ~250 tokens
      const dynamicContent = "B".repeat(2000); // ~500 tokens

      const messages: AgentMessage[] = [
        makeUserMessage(1, `${cachedContent}${SYSTEM_PROMPT_CACHE_BOUNDARY}\n${dynamicContent}`),
      ];

      const result = detectCacheBoundaries(messages);

      expect(result.hasBoundary).toBe(true);
      expect(result.cachedTokens).toBeGreaterThan(0);
      expect(result.dynamicTokens).toBeGreaterThan(0);
      expect(result.cachedTokens).toBeLessThan(result.dynamicTokens ?? 0);
    });

    it("should handle messages with non-string bodies gracefully", () => {
      const messages: AgentMessage[] = [
        {
          role: "user",
          content: [{ type: "text", text: "No boundary here" }],
          timestamp: 1,
        },
        {
          role: "assistant",
          content: null,
          timestamp: 2,
        },
      ];

      const result = detectCacheBoundaries(messages);

      expect(result.hasBoundary).toBe(false);
      expect(result.positions).toHaveLength(0);
    });

    it("should detect character offset of boundary", () => {
      const prefix = "Repeated prefix ";
      const content = `${prefix.repeat(10)}${SYSTEM_PROMPT_CACHE_BOUNDARY}\nSuffix`;
      const messages: AgentMessage[] = [makeUserMessage(1, content)];

      const result = detectCacheBoundaries(messages);

      expect(result.hasBoundary).toBe(true);
      expect(result.positions[0].charOffset).toBe(prefix.length * 10);
    });
  });

  describe("buildCacheAwareChunkPlan", () => {
    it("should use standard chunking when no cache boundary exists", () => {
      // Use substantial content to ensure chunking is triggered
      const messageContent = "This is message content that should be chunked. ".repeat(10);
      const messages: AgentMessage[] = Array.from({ length: 50 }, (_, i) => ({
        role: i % 2 === 0 ? "user" : "assistant",
        content: `Message ${i}: ${messageContent}`,
        timestamp: i + 1,
      }));

      const options: CacheAwareChunkingOptions = { maxTokens: 500 };
      const result = buildCacheAwareChunkPlan(messages, options);

      expect(result.cachePreserved).toBe(false);
      expect(result.chunks.length).toBeGreaterThan(1);
    });

    it("should preserve cache-carryover content when boundary exists", () => {
      const cachedContent = Array.from({ length: 10 }, (_, i) => ({
        role: "user" as const,
        content: `Cached instruction ${i}`,
        timestamp: i + 1,
      }));

      const dynamicContent = Array.from({ length: 20 }, (_, i) => ({
        role: "user" as const,
        content: `Dynamic message ${i} that should be chunked aggressively`,
        timestamp: i + 11,
      }));

      const boundaryMessage: AgentMessage = {
        role: "assistant",
        content: `System prompt${SYSTEM_PROMPT_CACHE_BOUNDARY}\nDynamic follows`,
        timestamp: 11,
      };

      const messages: AgentMessage[] = [...cachedContent, boundaryMessage, ...dynamicContent];

      const options: CacheAwareChunkingOptions = {
        maxTokens: 500,
        preserveCacheCarryover: true,
      };

      const result = buildCacheAwareChunkPlan(messages, options);

      expect(result.cachePreserved).toBe(true);
      expect(result.chunks.length).toBeGreaterThanOrEqual(2);

      // First chunk should contain cache-carryover content
      const firstChunk = result.chunks[0];
      expect(firstChunk.length).toBeGreaterThan(10);
    });

    it("should chunk dynamic content with maxTokens limit", () => {
      const cachedMessage: AgentMessage = {
        role: "user",
        content: `Cached content${SYSTEM_PROMPT_CACHE_BOUNDARY}\n`,
        timestamp: 1,
      };

      const dynamicContent: AgentMessage[] = Array.from({ length: 100 }, (_, i) => ({
        role: "user" as const,
        content: `Dynamic message ${i} with enough content to trigger chunking`,
        timestamp: i + 2,
      }));

      const messages: AgentMessage[] = [cachedMessage, ...dynamicContent];

      const options: CacheAwareChunkingOptions = { maxTokens: 300 };
      const result = buildCacheAwareChunkPlan(messages, options);

      expect(result.cachePreserved).toBe(true);
      expect(result.chunks.length).toBeGreaterThan(2);

      // Verify first chunk has cached content
      expect(result.chunks[0]).toHaveLength(1);

      // Verify dynamic content is chunked
      const dynamicChunks = result.chunks.slice(1);
      const totalDynamicMessages = dynamicChunks.reduce((sum, chunk) => sum + chunk.length, 0);
      expect(totalDynamicMessages).toBe(100);
    });

    it("should handle empty dynamic content", () => {
      const messages: AgentMessage[] = [
        {
          role: "assistant",
          content: `Only cached content${SYSTEM_PROMPT_CACHE_BOUNDARY}`,
          timestamp: 1,
        },
      ];

      const options: CacheAwareChunkingOptions = { maxTokens: 500 };
      const result = buildCacheAwareChunkPlan(messages, options);

      expect(result.cachePreserved).toBe(true);
      expect(result.chunks).toHaveLength(1);
      expect(result.chunks[0]).toHaveLength(1);
    });

    it("should respect preserveCacheCarryover flag when false", () => {
      const messages: AgentMessage[] = [
        {
          role: "assistant",
          content: `Cached${SYSTEM_PROMPT_CACHE_BOUNDARY}\nDynamic`,
          timestamp: 1,
        },
        { role: "user", content: "Dynamic message", timestamp: 2 },
      ];

      const options: CacheAwareChunkingOptions = {
        maxTokens: 500,
        preserveCacheCarryover: false,
      };

      const result = buildCacheAwareChunkPlan(messages, options);

      expect(result.cachePreserved).toBe(false);
    });

    it("should use cache buffer multiplier for cached content", () => {
      const largeCachedContent = Array.from({ length: 50 }, (_, i) => ({
        role: "user" as const,
        content: `Cached instruction ${i} with substantial content`,
        timestamp: i + 1,
      }));

      const boundaryMessage: AgentMessage = {
        role: "assistant",
        content: `End of cached${SYSTEM_PROMPT_CACHE_BOUNDARY}\nStart of dynamic`,
        timestamp: 51,
      };

      const dynamicContent: AgentMessage[] = [
        { role: "user", content: "Dynamic message", timestamp: 52 },
      ];

      const messages: AgentMessage[] = [...largeCachedContent, boundaryMessage, ...dynamicContent];

      const options: CacheAwareChunkingOptions = {
        maxTokens: 500,
        preserveCacheCarryover: true,
        cacheBufferMultiplier: 1.5,
      };

      const result = buildCacheAwareChunkPlan(messages, options);

      expect(result.cachePreserved).toBe(true);
      // With buffer multiplier, large cached content should be preserved
      expect(result.chunks[0].length).toBeGreaterThanOrEqual(50);
    });
  });

  describe("isCacheAwareChunkingBeneficial", () => {
    it("should return false when no cache boundary exists", () => {
      const messages: AgentMessage[] = [
        makeUserMessage(1, "No boundary here"),
        makeAssistantMessage(2, "Response"),
      ];

      const result = isCacheAwareChunkingBeneficial(messages, 500);

      expect(result).toBe(false);
    });

    it("should return false when cached content ratio is too small", () => {
      const messages: AgentMessage[] = [
        makeAssistantMessage(
          1,
          `Tiny${SYSTEM_PROMPT_CACHE_BOUNDARY}\n${"Large dynamic content ".repeat(100)}`,
        ),
      ];

      const result = isCacheAwareChunkingBeneficial(messages, 500);

      expect(result).toBe(false);
    });

    it("should return false when dynamic content is too small", () => {
      const messages: AgentMessage[] = [
        makeAssistantMessage(
          1,
          `${"Large cached content ".repeat(100)}${SYSTEM_PROMPT_CACHE_BOUNDARY}\nTiny dynamic`,
        ),
      ];

      const result = isCacheAwareChunkingBeneficial(messages, 10000);

      expect(result).toBe(false);
    });

    it("should return true when conditions are met", () => {
      const cachedContent = "Moderate cached content ".repeat(50);
      const dynamicContent = "Moderate dynamic content ".repeat(50);

      const messages: AgentMessage[] = [
        makeAssistantMessage(
          1,
          `${cachedContent}${SYSTEM_PROMPT_CACHE_BOUNDARY}\n${dynamicContent}`,
        ),
      ];

      const result = isCacheAwareChunkingBeneficial(messages, 500);

      expect(result).toBe(true);
    });

    it("should handle empty message array", () => {
      const result = isCacheAwareChunkingBeneficial([], 500);

      expect(result).toBe(false);
    });

    it("should handle maxTokens of zero", () => {
      const messages: AgentMessage[] = [
        makeAssistantMessage(1, `Content${SYSTEM_PROMPT_CACHE_BOUNDARY}\nMore content`),
      ];

      const result = isCacheAwareChunkingBeneficial(messages, 0);

      expect(result).toBe(false);
    });
  });

  describe("integration: cache-aware compaction preserves cache hits", () => {
    it("should maintain cache structure through compaction cycle", () => {
      // Simulate a realistic session with system prompt cache boundary
      const systemPrompt = `You are OpenClaw, an AI coding assistant.
Your core principles are accuracy and helpfulness.

${SYSTEM_PROMPT_CACHE_BOUNDARY}

Current session context and recent activity:`;

      const conversation = Array.from({ length: 30 }, (_, i) => ({
        role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
        content: `Turn ${i}: ${i % 2 === 0 ? "User request" : "Assistant response"} with sufficient content`,
        timestamp: i + 2,
      }));

      const messages: AgentMessage[] = [makeUserMessage(1, systemPrompt), ...conversation];

      // Build cache-aware chunking plan
      const options: CacheAwareChunkingOptions = {
        maxTokens: 1000,
        preserveCacheCarryover: true,
        cacheBufferMultiplier: 1.2,
      };

      const result = buildCacheAwareChunkPlan(messages, options);

      // Verify cache-aware behavior
      expect(result.cachePreserved).toBe(true);
      expect(result.detection.hasBoundary).toBe(true);

      // First chunk should have the system prompt with cache boundary intact
      const firstChunk = result.chunks[0];
      expect(firstChunk.length).toBeGreaterThan(0);

      // Verify boundary is preserved in first chunk
      const firstChunkContent = (firstChunk[0] as { content?: string }).content ?? "";
      expect(firstChunkContent).toContain(SYSTEM_PROMPT_CACHE_BOUNDARY);

      // Dynamic content should be chunked across multiple chunks
      expect(result.chunks.length).toBeGreaterThan(1);

      // Verify total message count is preserved
      const totalMessages = result.chunks.reduce((sum, chunk) => sum + chunk.length, 0);
      expect(totalMessages).toBe(messages.length);
    });

    it("should handle multiple compaction cycles with cache preservation", () => {
      const baseSystemPrompt = `Core instructions${SYSTEM_PROMPT_CACHE_BOUNDARY}\n`;
      let messages: AgentMessage[] = [
        makeUserMessage(1, baseSystemPrompt),
        ...Array.from({ length: 20 }, (_, i) => ({
          role: "user" as const,
          content: `Message ${i}`,
          timestamp: i + 2,
        })),
      ];

      // First compaction cycle
      const plan1 = buildCacheAwareChunkPlan(messages, { maxTokens: 800 });
      expect(plan1.cachePreserved).toBe(true);

      // Simulate adding new messages and compacting again
      messages = [
        messages[0], // Keep system prompt
        ...plan1.chunks.slice(1).flat(), // Add compacted conversation
        ...Array.from({ length: 10 }, (_, i) => ({
          role: "user" as const,
          content: `New message ${i}`,
          timestamp: i + 22,
        })),
      ];

      // Second compaction cycle
      const plan2 = buildCacheAwareChunkPlan(messages, { maxTokens: 800 });
      expect(plan2.cachePreserved).toBe(true);

      // System prompt should still be in first chunk
      const firstChunkContent = (plan2.chunks[0][0] as { content?: string }).content ?? "";
      expect(firstChunkContent).toContain(SYSTEM_PROMPT_CACHE_BOUNDARY);
    });
  });
});
