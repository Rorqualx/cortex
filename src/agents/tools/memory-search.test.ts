/**
 * Memory search tool tests
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { MemorySearchResult } from "./memory-search.js";
import {
  cosineSimilarity,
  executeMemorySearch,
  executeMemorySearchTool,
  memorySearchTool,
} from "./memory-search.js";

// Mock the memory embedding provider runtime
const mockAdapter = {
  id: "test-embedding",
  defaultModel: "text-embedding-3-small",
  create: vi.fn(),
};

vi.mock("../../plugins/memory-embedding-provider-runtime.js", () => ({
  getMemoryEmbeddingProvider: vi.fn(() => mockAdapter),
}));

// Mock the path resolution
vi.mock("../../config/paths.js", () => ({
  resolveStateDir: vi.fn(() => "/mock/state/dir"),
}));

// Mock fs.readdir and fs.readFile for transcript summaries
const mockReaddir = vi.fn();
const mockReadFile = vi.fn();
const mockStat = vi.fn();

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    promises: {
      ...actual.promises,
      readdir: mockReaddir,
      readFile: mockReadFile,
      stat: mockStat,
    },
  };
});

vi.mock("node:path", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:path")>();
  return {
    ...actual,
    join: (...parts: string[]) => parts.join("/"),
  };
});

// Mock summaries with embeddings
const mockSummaries = [
  {
    sessionId: "session-1",
    title: "Authentication Discussion",
    summary: "We discussed JWT authentication and decided to use it",
    decisions: ["Use JWT for authentication", "Set token expiry to 1 hour"],
    actionItems: ["Implement JWT middleware"],
    risks: ["Token leakage"],
    embedding: [0.1, 0.2, 0.3, 0.4, 0.5],
  },
  {
    sessionId: "session-2",
    title: "Database Planning",
    summary: "Planned PostgreSQL schema for user data",
    decisions: ["Use PostgreSQL"],
    actionItems: ["Create schema migration"],
    risks: ["Migration downtime"],
    embedding: [0.5, 0.4, 0.3, 0.2, 0.1],
  },
  {
    sessionId: "session-3",
    title: "Deployment Pipeline",
    summary: "Set up CI/CD pipeline with GitHub Actions",
    decisions: ["Use GitHub Actions"],
    actionItems: ["Create workflow files"],
    risks: ["Pipeline failure alerts"],
    embedding: [0.2, 0.3, 0.4, 0.5, 0.6],
  },
];

function setupMocksWithSummaries(summaries: typeof mockSummaries = mockSummaries) {
  mockReaddir.mockImplementation((path: string) => {
    if (path.endsWith("/transcripts")) {
      return Promise.resolve(["2024-01-01", "2024-01-02"]);
    }
    if (path.includes("/2024-01-01") || path.includes("/2024-01-02")) {
      return Promise.resolve(summaries.map((s) => s.sessionId));
    }
    return Promise.resolve([]);
  });

  mockStat.mockResolvedValue({ isDirectory: () => true } as any);

  mockReadFile.mockImplementation((path: string) => {
    if (path.endsWith("summary.json")) {
      const sessionId = path.split("/").slice(-2, -1)[0];
      const summary = summaries.find((s) => s.sessionId === sessionId);
      if (summary) {
        return Promise.resolve(JSON.stringify(summary));
      }
    }
    return Promise.reject(new Error("File not found"));
  });
}

describe("cosineSimilarity", () => {
  it("returns 1 for identical vectors", () => {
    const vec = [0.5, 0.5, 0.5, 0.5];
    expect(cosineSimilarity(vec, vec)).toBe(1);
  });

  it("returns 0 for orthogonal vectors", () => {
    const a = [1, 0, 0];
    const b = [0, 1, 0];
    expect(cosineSimilarity(a, b)).toBe(0);
  });

  it("returns -1 for opposite vectors", () => {
    const a = [1, 0, 0];
    const b = [-1, 0, 0];
    expect(cosineSimilarity(a, b)).toBe(-1);
  });

  it("handles vectors of different magnitudes", () => {
    const a = [1, 1];
    const b = [2, 2]; // Same direction, different magnitude
    const result = cosineSimilarity(a, b);
    expect(result).toBeCloseTo(1, 5);
  });

  it("throws for mismatched dimensions", () => {
    const a = [1, 2, 3];
    const b = [1, 2];
    expect(() => cosineSimilarity(a, b)).toThrow("Vector dimension mismatch");
  });

  it("returns 0 for zero magnitude vectors", () => {
    expect(cosineSimilarity([0, 0, 0], [1, 1, 1])).toBe(0);
    expect(cosineSimilarity([1, 1, 1], [0, 0, 0])).toBe(0);
  });
});

describe("memorySearchTool", () => {
  it("has correct tool definition", () => {
    expect(memorySearchTool.name).toBe("memory_search");
    expect(memorySearchTool.description).toContain("semantic similarity");
    expect(memorySearchTool.parameters).toMatchObject({
      type: "object",
      required: ["query"],
    });
    expect(memorySearchTool.parameters.properties).toHaveProperty("query");
    expect(memorySearchTool.parameters.properties).toHaveProperty("topK");
    expect(memorySearchTool.parameters.properties).toHaveProperty("minScore");
  });
});

describe("executeMemorySearch", () => {
  beforeEach(() => {
    // Reset mock state before each test
    mockAdapter.create.mockReset();
    mockAdapter.create.mockResolvedValue({
      provider: {
        id: "test-embedding",
        model: "text-embedding-3-small",
        embedBatch: vi.fn().mockResolvedValue([[0.3, 0.3, 0.3, 0.3, 0.3]]),
      },
    });
    setupMocksWithSummaries();
  });

  it("generates query embedding and searches summaries", async () => {
    const cfg = {} as OpenClawConfig;
    const results = await executeMemorySearch({
      query: "authentication",
      cfg,
    });

    expect(results).toBeInstanceOf(Array);
    expect(mockAdapter.create).toHaveBeenCalled();
  });

  it("filters results by minScore threshold", async () => {
    const cfg = {} as OpenClawConfig;
    const results = await executeMemorySearch({
      query: "test",
      minScore: 0.9, // High threshold
      cfg,
    });

    // With high threshold and mock query embedding, expect fewer or no results
    expect(results.every((r) => r.similarityScore >= 0.9)).toBe(true);
  });

  it("limits results to topK", async () => {
    const cfg = {} as OpenClawConfig;
    const results = await executeMemorySearch({
      query: "test",
      topK: 2,
      cfg,
    });

    expect(results.length).toBeLessThanOrEqual(2);
  });

  it("returns results sorted by similarity score descending", async () => {
    const cfg = {} as OpenClawConfig;
    const results = await executeMemorySearch({
      query: "test",
      cfg,
    });

    for (let i = 1; i < results.length; i++) {
      const current = results[i];
      const previous = results[i - 1];
      if (!current || !previous) {
        throw new Error("missing result row");
      }
      expect(current.similarityScore).toBeLessThanOrEqual(previous.similarityScore);
    }
  });

  it("includes summary fields in results", async () => {
    const cfg = {} as OpenClawConfig;
    const results = await executeMemorySearch({
      query: "test",
      cfg,
    });

    if (results.length > 0) {
      const first = results[0];
      expect(first).toMatchObject({
        sessionId: expect.any(String),
        title: expect.any(String),
        summary: expect.any(String),
        decisions: expect.any(Array),
        actionItems: expect.any(Array),
        risks: expect.any(Array),
        similarityScore: expect.any(Number),
      });
    }
  });

  it("returns empty array when no embeddings found", async () => {
    setupMocksWithSummaries([]);

    const cfg = {} as OpenClawConfig;
    const results = await executeMemorySearch({
      query: "test",
      cfg,
    });

    expect(results).toEqual([]);
  });
});

describe("executeMemorySearchTool", () => {
  beforeEach(() => {
    mockAdapter.create.mockReset();
    mockAdapter.create.mockResolvedValue({
      provider: {
        id: "test-embedding",
        model: "text-embedding-3-small",
        embedBatch: vi.fn().mockResolvedValue([[0.3, 0.3, 0.3, 0.3, 0.3]]),
      },
    });
    setupMocksWithSummaries();
  });

  it("formats results as text", async () => {
    const cfg = {} as OpenClawConfig;
    const { text, results } = await executeMemorySearchTool({
      query: "authentication",
      cfg,
    });

    expect(text).toContain("relevant");
    expect(results).toBeInstanceOf(Array);
  });

  it("shows no results message when empty", async () => {
    setupMocksWithSummaries([]);

    const cfg = {} as OpenClawConfig;
    const { text, results } = await executeMemorySearchTool({
      query: "unrelated topic",
      cfg,
    });

    expect(text).toContain("No relevant summaries found");
    expect(results).toEqual([]);
  });

  it("caps topK at 20", async () => {
    const cfg = {} as OpenClawConfig;
    const { results } = await executeMemorySearchTool({
      query: "test",
      topK: 100, // Request more than max
      cfg,
    });

    // Should cap at 20, but we only have 3 mock entries
    expect(results.length).toBeLessThanOrEqual(20);
  });

  it("uses default topK of 5 when not specified", async () => {
    const cfg = {} as OpenClawConfig;
    const { results } = await executeMemorySearchTool({
      query: "test",
      cfg,
    });

    // With 3 mock entries, expect at most 3
    expect(results.length).toBeLessThanOrEqual(5);
  });

  it("uses default minScore of 0.3 when not specified", async () => {
    const cfg = {} as OpenClawConfig;
    const { results } = await executeMemorySearchTool({
      query: "test",
      cfg,
    });

    expect(results.every((r) => r.similarityScore >= 0.3)).toBe(true);
  });

  it("formats result with summary, decisions, and actions", async () => {
    const cfg = {} as OpenClawConfig;
    const { text } = await executeMemorySearchTool({
      query: "authentication",
      cfg,
    });

    // Should have formatted results
    expect(text).toBeDefined();
    if (text.includes("relevant")) {
      expect(text).toMatch(/## .+ \(/); // Title header
      expect(text).toMatch(/Similarity:/);
    }
  });
});

describe("Memory Search Integration", () => {
  beforeEach(() => {
    setupMocksWithSummaries();
  });

  it("handles real-world search scenario", async () => {
    // Query embedding - calculate actual similarities:
    // session-1 [0.1,0.2,0.3,0.4,0.5]: cos ≈ 0.34
    // session-2 [0.5,0.4,0.3,0.2,0.1]: cos ≈ 0.80 (highest - reversed order of session-1)
    // session-3 [0.2,0.3,0.4,0.5,0.6]: cos ≈ 0.41
    const mockQueryEmbedding = [0.9, 0.1, 0.1, 0.1, 0.1];
    mockAdapter.create.mockResolvedValue({
      provider: {
        id: "test-embedding",
        model: "text-embedding-3-small",
        embedBatch: vi.fn().mockResolvedValue([mockQueryEmbedding]),
      },
    });

    const cfg = {} as OpenClawConfig;
    const results = await executeMemorySearch({
      query: "What decisions did we make about authentication?",
      cfg,
    });

    // Results should be returned
    expect(results.length).toBeGreaterThan(0);

    // All results should have sessionId, title, and other fields
    expect(results[0]).toHaveProperty("sessionId");
    expect(results[0]).toHaveProperty("title");
    expect(results[0]).toHaveProperty("decisions");
  });

  it("ranks results by semantic similarity", async () => {
    // Query that's exactly opposite to session-2 (database)
    // session-1: [0.1,0.2,0.3,0.4,0.5], cos with [0.5,0.4,0.3,0.2,0.1] = 0.55/0.68 ≈ 0.81 (highest - reverse)
    // session-2: [0.5,0.4,0.3,0.2,0.1], cos with [0.5,0.4,0.3,0.2,0.1] = 1.0 (exact match)
    // session-3: [0.2,0.3,0.4,0.5,0.6], cos with [0.5,0.4,0.3,0.2,0.1] = 0.40/0.9 ≈ 0.44
    const mockQueryEmbedding = [0.5, 0.4, 0.3, 0.2, 0.1];
    mockAdapter.create.mockResolvedValue({
      provider: {
        id: "test-embedding",
        model: "text-embedding-3-small",
        embedBatch: vi.fn().mockResolvedValue([mockQueryEmbedding]),
      },
    });

    const cfg = {} as OpenClawConfig;
    const results = await executeMemorySearch({
      query: "PostgreSQL database schema",
      cfg,
    });

    // Should have results
    expect(results.length).toBeGreaterThan(0);

    // Results should be sorted by similarity
    for (let i = 1; i < results.length; i++) {
      const current = results[i];
      const previous = results[i - 1];
      if (!current || !previous) {
        throw new Error("missing result row");
      }
      expect(current.similarityScore).toBeLessThanOrEqual(previous.similarityScore);
    }
  });

  it("filters out results below minScore", async () => {
    // Query with very low similarity to all mock sessions
    const mockQueryEmbedding = [0.01, 0.01, 0.01, 0.01, 0.99];
    mockAdapter.create.mockResolvedValue({
      provider: {
        id: "test-embedding",
        model: "text-embedding-3-small",
        embedBatch: vi.fn().mockResolvedValue([mockQueryEmbedding]),
      },
    });

    const cfg = {} as OpenClawConfig;
    const results = await executeMemorySearch({
      query: "unrelated topic",
      minScore: 0.9, // High threshold
      cfg,
    });

    // With high threshold, expect no results or very few
    expect(results.length).toBe(0);
  });
});
