/**
 * Tests for the passage-level information-density reranker.
 *
 * RARG-inspired (arXiv:2607.24223): passage-level signals like entity
 * density and query novelty improve ranking when BM25 alone over-promotes
 * lexically similar but information-poor facts.
 */

import { describe, expect, it } from "vitest";
import {
  countNamedEntities,
  informationDensity,
  rerankByInformationDensity,
  type RetrievedFact,
} from "./retrieval.js";
import { tokenize } from "./scoring.js";

describe("countNamedEntities", () => {
  it("counts capitalized words as entities", () => {
    // "Joe" = 1 match, "Denver Colorado" = 1 multi-word match (greedy) = 2 total
    expect(countNamedEntities("Joe lives in Denver Colorado")).toBe(2);
  });

  it("counts IP addresses", () => {
    expect(countNamedEntities("server at 192.168.50.128")).toBe(1);
  });

  it("counts version strings", () => {
    expect(countNamedEntities("upgraded to v1.2.3")).toBe(1);
  });

  it("returns 0 for lowercase-only text", () => {
    expect(countNamedEntities("the quick brown fox")).toBe(0);
  });

  it("handles hyphenated CamelCase names", () => {
    expect(countNamedEntities("HueyTheDestroyer is online")).toBe(1);
  });
});

describe("informationDensity", () => {
  it("returns high density for entity-rich text with low query overlap", () => {
    const query = tokenize("what time is it");
    const density = informationDensity(
      "HueyTheDestroyer runs Transmission on port 9091 at 192.168.50.185",
      query,
    );
    expect(density).toBeGreaterThan(0.3);
  });

  it("returns low density for text that parrots query tokens", () => {
    const query = tokenize("what time is it");
    const density = informationDensity("what time is it right now", query);
    // Novelty is ~0 (all tokens in query), so density should be low
    expect(density).toBeLessThan(0.15);
  });

  it("returns 0 novelty when fact text equals query", () => {
    const query = tokenize("morning standups");
    const density = informationDensity("morning standups", query);
    expect(density).toBe(0);
  });

  it("handles empty query tokens gracefully", () => {
    const density = informationDensity("Some fact text", new Set());
    // With no query tokens, novelty is 1 (all tokens are novel)
    expect(density).toBeGreaterThan(0);
  });
});

describe("rerankByInformationDensity", () => {
  const mkFact = (id: string, text: string, score: number): RetrievedFact => ({
    fact: {
      id,
      text,
      importance: 0.5,
      createdAt: Date.UTC(2026, 6, 1),
      dedupKey: id,
    },
    score,
    signals: {
      lexical: 0.5,
      bm25: 0.3,
      importance: 0.5,
      recency: 1,
      l3Boost: 0,
      semantic: 0,
      informationGain: 0,
      goalRelevance: 0,
      reliability: 0,
      semanticEntropy: 1,
      validity: 1,
    },
    chunkId: "chunk-1",
    tier: "l2" as const,
  });

  it("is a no-op when results array has 0 or 1 items", () => {
    const single = [mkFact("f1", "hello world", 1.0)];
    rerankByInformationDensity(single, "hello", 0.15);
    expect(single[0]!.score).toBe(1.0);
  });

  it("is a no-op when weight is 0", () => {
    const results = [mkFact("f1", "hello world", 1.0), mkFact("f2", "Goodbye World", 0.5)];
    rerankByInformationDensity(results, "hello", 0);
    expect(results[0]!.score).toBe(1.0);
  });

  it("is a no-op when query has no tokens", () => {
    const results = [mkFact("f1", "hello world", 1.0), mkFact("f2", "Goodbye World", 0.5)];
    const scoresBefore = results.map((r) => r.score);
    rerankByInformationDensity(results, "", 0.15);
    expect(results.map((r) => r.score)).toEqual(scoresBefore);
  });

  it("boosts entity-rich facts over entity-poor facts at similar scores", () => {
    // Two facts with identical base scores. One has entities, one doesn't.
    const results = [
      mkFact("f-poor", "the thing is somewhere", 0.5),
      mkFact("f-rich", "HueyTheDestroyer at 192.168.50.185 runs Transmission on port 9091", 0.5),
    ];
    rerankByInformationDensity(results, "thing somewhere", 0.15);
    // The rich fact should now be ranked first
    expect(results[0]!.fact.id).toBe("f-rich");
  });

  it("preserves order when scores are very different (doesn't invert)", () => {
    const results = [
      mkFact("f-high", "important fact about Denver", 10.0),
      mkFact("f-low", "trivial note about nothing", 0.01),
    ];
    rerankByInformationDensity(results, "important", 0.15);
    // The high-scoring fact stays on top regardless of density
    expect(results[0]!.fact.id).toBe("f-high");
  });

  it("adjusts scores multiplicatively (never negative)", () => {
    const results = [
      mkFact("f1", "Some entity-free text here", 0.5),
      mkFact("f2", "Denver Colorado HueyTheDestroyer 192.168.50.185", 0.5),
    ];
    const originalScores = results.map((r) => r.score);
    rerankByInformationDensity(results, "text here", 0.15);
    for (let i = 0; i < results.length; i++) {
      expect(results[i]!.score).toBeGreaterThanOrEqual(originalScores[i]!);
    }
  });

  it("integrates with retrieveTopK via rerankByDensity param", async () => {
    // Verify the reranker is reachable through retrieveTopK
    const { retrieveTopK } = await import("./retrieval.js");
    const { Storage } = await import("./storage.js");
    const { mkdtempSync, rmSync } = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");

    const tmp = mkdtempSync(path.join(os.tmpdir(), "rerank-"));
    const storage = new Storage(path.join(tmp, ".openclaw", "l3"));
    const NOW = Date.UTC(2026, 6, 1);

    await storage.writeL2Chunk(
      {
        id: "chunk-1",
        agentId: "test",
        startTurnIndex: 0,
        endTurnIndex: 1,
        createdAt: NOW,
        facts: [
          {
            id: "f-poor",
            text: "the server is running fine",
            importance: 0.5,
            createdAt: NOW,
            dedupKey: "k:poor",
          },
          {
            id: "f-rich",
            text: "HueyTheDestroyer at 192.168.50.185 runs Transmission",
            importance: 0.5,
            createdAt: NOW,
            dedupKey: "k:rich",
          },
        ],
        typedFacts: [],
        dedupKeys: ["k:poor", "k:rich"],
      },
      "",
    );

    // Without reranker
    const { facts: before } = await retrieveTopK({
      query: "server running",
      storage,
      topK: 2,
      now: NOW + 86400000,
    });

    // With reranker
    const { facts: after } = await retrieveTopK({
      query: "server running",
      storage,
      topK: 2,
      now: NOW + 86400000,
      rerankByDensity: true,
    });

    // Both should return results
    expect(before.length).toBe(2);
    expect(after.length).toBe(2);

    // The reranker should not lose any facts
    const beforeIds = new Set(before.map((f) => f.fact.id));
    const afterIds = new Set(after.map((f) => f.fact.id));
    expect(afterIds).toEqual(beforeIds);

    rmSync(tmp, { recursive: true, force: true });
  });
});
