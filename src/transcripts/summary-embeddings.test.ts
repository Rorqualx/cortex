/**
 * Summary embedding generation tests
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { TranscriptsSummary } from "./summary.js";

// Mock the memory embedding provider runtime
const mockAdapter = {
  id: "test-embedding",
  defaultModel: "text-embedding-3-small",
  create: vi.fn(),
};

vi.mock("../plugins/memory-embedding-provider-runtime.js", () => ({
  getMemoryEmbeddingProvider: vi.fn(() => mockAdapter),
}));

describe("Summary Embeddings", () => {
  function createMockSummary(overrides?: Partial<TranscriptsSummary>): TranscriptsSummary {
    return {
      sessionId: "test-session-123",
      title: "Test Session",
      generatedAt: "2024-01-01T00:00:00Z",
      overview: "We discussed the authentication system and decided to use JWT tokens.",
      transcript: ["User: Let's talk about auth", "Agent: Sure, JWT is a good choice"],
      decisions: ["Use JWT for authentication", "Set token expiry to 1 hour"],
      actionItems: ["Implement JWT middleware", "Add token refresh endpoint"],
      risks: ["Token leakage vulnerability", "Revocation strategy needed"],
      utteranceCount: 2,
      ...overrides,
    };
  }

  describe("generateSummaryEmbedding", () => {
    beforeEach(() => {
      // Reset mock state before each test
      mockAdapter.create.mockReset();
      mockAdapter.create.mockResolvedValue({
        provider: {
          id: "test-embedding",
          model: "text-embedding-3-small",
          embedBatch: vi.fn().mockResolvedValue([[0.1, 0.2, 0.3, 0.4, 0.5]]),
        },
      });
    });

    it("throws error when no embedding provider configured", async () => {
      const { getMemoryEmbeddingProvider } =
        await import("../plugins/memory-embedding-provider-runtime.js");
      vi.mocked(getMemoryEmbeddingProvider).mockReturnValueOnce(null as any);

      const { generateSummaryEmbedding } = await import("./summary.js");

      const summary = createMockSummary();
      const cfg = {} as OpenClawConfig;

      await expect(generateSummaryEmbedding({ summary, cfg })).rejects.toThrow(
        "No embedding provider configured",
      );
    });

    it("generates embedding vector when provider available", async () => {
      const { generateSummaryEmbedding } = await import("./summary.js");

      const summary = createMockSummary();
      const cfg = {} as OpenClawConfig;

      const embedding = await generateSummaryEmbedding({ summary, cfg });

      expect(embedding).toEqual([0.1, 0.2, 0.3, 0.4, 0.5]);
      expect(mockAdapter.create).toHaveBeenCalledWith(
        expect.objectContaining({
          model: "text-embedding-3-small",
        }),
      );
    });

    it("passes summary content to embedding provider", async () => {
      const { generateSummaryEmbedding } = await import("./summary.js");

      const summary = createMockSummary();
      const cfg = {} as OpenClawConfig;

      const mockProvider = {
        id: "test-embedding",
        model: "text-embedding-3-small",
        embedBatch: vi.fn().mockResolvedValue([[0.1, 0.2, 0.3, 0.4, 0.5]]),
      };
      mockAdapter.create.mockResolvedValue({ provider: mockProvider });

      await generateSummaryEmbedding({ summary, cfg });

      // Verify embedBatch was called with text containing summary content
      expect(mockProvider.embedBatch).toHaveBeenCalledWith(
        expect.arrayContaining([expect.stringContaining("authentication system")]),
      );
    });

    it("builds embedding text from overview, decisions, actions, and risks", async () => {
      const { generateSummaryEmbedding } = await import("./summary.js");

      const summary = createMockSummary();
      const cfg = {} as OpenClawConfig;

      const mockProvider = {
        id: "test-embedding",
        model: "text-embedding-3-small",
        embedBatch: vi.fn().mockResolvedValue([[0.1, 0.2, 0.3, 0.4, 0.5]]),
      };
      mockAdapter.create.mockResolvedValue({ provider: mockProvider });

      await generateSummaryEmbedding({ summary, cfg });

      const embeddingText = mockProvider.embedBatch.mock.calls[0]![0]![0];
      expect(embeddingText).toContain("authentication system");
      expect(embeddingText).toContain("Decisions:");
      expect(embeddingText).toContain("Use JWT for authentication");
      expect(embeddingText).toContain("Action Items:");
      expect(embeddingText).toContain("Implement JWT middleware");
      expect(embeddingText).toContain("Risks:");
      expect(embeddingText).toContain("Token leakage");
    });

    it("handles summary with minimal content", async () => {
      const { generateSummaryEmbedding } = await import("./summary.js");

      const summary: TranscriptsSummary = {
        sessionId: "minimal",
        title: "Minimal",
        generatedAt: "2024-01-01T00:00:00Z",
        overview: "Brief discussion",
        transcript: [],
        decisions: [],
        actionItems: [],
        risks: [],
        utteranceCount: 0,
      };
      const cfg = {} as OpenClawConfig;

      const mockProvider = {
        id: "test-embedding",
        model: "text-embedding-3-small",
        embedBatch: vi.fn().mockResolvedValue([[0.1, 0.2, 0.3]]),
      };
      mockAdapter.create.mockResolvedValue({ provider: mockProvider });

      const embedding = await generateSummaryEmbedding({ summary, cfg });

      expect(embedding).toEqual([0.1, 0.2, 0.3]);
      const embeddingText = mockProvider.embedBatch.mock.calls[0]![0]![0];
      expect(embeddingText).toContain("Brief discussion");
    });
  });
});
