/**
 * Memory search tool for semantic transcript search
 *
 * Provides semantic search across session summaries using cosine similarity
 * on embedding vectors.
 */

import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { TranscriptsSummary } from "../../transcripts/summary.js";

/**
 * Memory search result containing matched summary with similarity score
 */
export type MemorySearchResult = {
  sessionId: string;
  title: string;
  summary: string;
  decisions: string[];
  actionItems: string[];
  risks: string[];
  similarityScore: number;
};

/**
 * Cosine similarity between two vectors
 *
 * Returns a value between -1 (opposite) and 1 (identical).
 * For normalized embedding vectors, this is effectively the dot product.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(`Vector dimension mismatch: ${a.length} vs ${b.length}`);
  }

  const dotProduct = a.reduce((sum, val, i) => sum + val * (b[i] ?? 0), 0);
  const magnitudeA = Math.sqrt(a.reduce((sum, val) => sum + val * val, 0));
  const magnitudeB = Math.sqrt(b.reduce((sum, val) => sum + val * val, 0));

  if (magnitudeA === 0 || magnitudeB === 0) {
    return 0;
  }

  return dotProduct / (magnitudeA * magnitudeB);
}

/**
 * Generate embedding for search query
 *
 * Uses the same embedding provider as transcript summaries to ensure
 * compatible vector space.
 */
async function generateQueryEmbedding(params: {
  query: string;
  cfg: OpenClawConfig;
}): Promise<number[]> {
  const { getMemoryEmbeddingProvider } =
    await import("../../plugins/memory-embedding-provider-runtime.js");

  const providerId = "openai";
  const adapter = getMemoryEmbeddingProvider(providerId, params.cfg);
  if (!adapter) {
    throw new Error(`No embedding provider configured for memory search: ${providerId} not found`);
  }

  const createResult = await adapter.create({
    config: params.cfg,
    model: adapter.defaultModel || "text-embedding-3-small",
  });
  const provider = createResult.provider;
  if (!provider) {
    throw new Error(`Failed to create embedding provider instance: ${providerId}`);
  }

  const embeddings = await provider.embedBatch([params.query]);
  const embedding = embeddings[0];
  if (!embedding) {
    throw new Error(`Embedding provider returned no embedding for query: ${providerId}`);
  }
  return embedding;
}

/**
 * Load summaries with embeddings from storage
 *
 * Reads all transcript summaries and filters to those with embedding vectors.
 */
async function loadSummariesWithEmbeddings(): Promise<Array<SessionSummaryWithEmbedding>> {
  const { resolveStateDir } = await import("../../config/paths.js");
  const path = await import("node:path");

  // Use transcripts directory from state dir
  const stateDir = resolveStateDir();
  const transcriptsDir = path.join(stateDir, "transcripts");

  try {
    const summaries: Array<SessionSummaryWithEmbedding> = [];
    const fs = await import("node:fs");

    // Scan transcripts directory for session directories
    const dateDirs = await fs.promises.readdir(transcriptsDir).catch(() => []);
    for (const dateDir of dateDirs) {
      const datePath = path.join(transcriptsDir, dateDir);
      const stat = await fs.promises.stat(datePath).catch(() => null);
      if (!stat?.isDirectory()) {
        continue;
      }

      // Read session directories within date directory
      const sessionDirs = await fs.promises.readdir(datePath).catch(() => []);
      for (const sessionDir of sessionDirs) {
        const sessionPath = path.join(datePath, sessionDir);
        const summaryPath = path.join(sessionPath, "summary.json");

        // Try to read summary.json
        const summaryContent = await fs.promises.readFile(summaryPath, "utf-8").catch(() => null);
        if (!summaryContent) {
          continue;
        }

        const summary = JSON.parse(summaryContent) as TranscriptsSummary;
        if (summary.embedding) {
          summaries.push({
            sessionId: summary.sessionId,
            title: summary.title || "Untitled",
            summary: summary.overview || "",
            decisions: summary.decisions || [],
            actionItems: summary.actionItems || [],
            risks: summary.risks || [],
            embedding: summary.embedding,
          });
        }
      }
    }
    return summaries;
  } catch {
    // If store doesn't exist or can't be read, return empty
    return [];
  }
}

type SessionSummaryWithEmbedding = {
  sessionId: string;
  title: string;
  summary: string;
  decisions: string[];
  actionItems: string[];
  risks: string[];
  embedding: number[];
};

/**
 * Execute semantic search across transcript summaries
 *
 * @param params - Search parameters including query, topK, minScore
 * @returns Array of results sorted by similarity score (descending)
 */
export async function executeMemorySearch(params: {
  query: string;
  topK?: number;
  minScore?: number;
  cfg: OpenClawConfig;
}): Promise<MemorySearchResult[]> {
  const { query, topK = 5, minScore = 0.3, cfg } = params;

  // 1. Generate query embedding
  const queryEmbedding = await generateQueryEmbedding({ query, cfg });

  // 2. Load all summaries with embeddings
  const summaries = await loadSummariesWithEmbeddings();

  // 3. Compute cosine similarity for each summary
  const results = summaries
    .map((summary) => ({
      sessionId: summary.sessionId,
      title: summary.title,
      summary: summary.summary,
      decisions: summary.decisions,
      actionItems: summary.actionItems,
      risks: summary.risks,
      similarityScore: cosineSimilarity(queryEmbedding, summary.embedding),
    }))
    .filter((result) => result.similarityScore >= minScore)
    .toSorted((a, b) => b.similarityScore - a.similarityScore)
    .slice(0, topK);

  return results;
}

/**
 * Memory search tool definition
 *
 * Can be registered as an agent tool for semantic transcript search.
 */
export const memorySearchTool = {
  name: "memory_search",
  description:
    "Search across session summaries using semantic similarity. Finds relevant past conversations based on meaning, not just keywords.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Search query for semantic similarity search",
      },
      topK: {
        type: "number",
        description: "Number of results to return (default: 5, max: 20)",
      },
      minScore: {
        type: "number",
        description: "Minimum similarity score (0-1, default: 0.3)",
      },
    },
    required: ["query"],
  },
};

/**
 * Execute memory search from tool invocation
 *
 * Formats results as tool output text.
 */
export async function executeMemorySearchTool(params: {
  query: string;
  topK?: number;
  minScore?: number;
  cfg: OpenClawConfig;
}): Promise<{ text: string; results: MemorySearchResult[] }> {
  const topK = Math.min(params.topK ?? 5, 20);
  const results = await executeMemorySearch({
    query: params.query,
    topK,
    minScore: params.minScore ?? 0.3,
    cfg: params.cfg,
  });

  if (results.length === 0) {
    return {
      text: `No relevant summaries found for query: "${params.query}"`,
      results,
    };
  }

  const lines = [
    `Found ${results.length} relevant summary${results.length === 1 ? "" : "ies"} for: "${params.query}"`,
    "",
  ];

  for (const result of results) {
    lines.push(`## ${result.title} (${result.sessionId})`);
    lines.push(`Similarity: ${(result.similarityScore * 100).toFixed(1)}%`);
    lines.push("");
    lines.push(result.summary);
    if (result.decisions.length > 0) {
      lines.push("");
      lines.push("Decisions:");
      for (const decision of result.decisions.slice(0, 3)) {
        lines.push(`- ${decision}`);
      }
    }
    if (result.actionItems.length > 0) {
      lines.push("");
      lines.push("Action Items:");
      for (const action of result.actionItems.slice(0, 3)) {
        lines.push(`- ${action}`);
      }
    }
    lines.push("");
  }

  return {
    text: lines.join("\n"),
    results,
  };
}
