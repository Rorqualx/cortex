import { describe, expect, it } from "vitest";
import {
  generateHypeQueries,
  bestHypeMatch,
  buildHypeLookup,
  type StoredHypeQuery,
} from "./hype.js";

describe("generateHypeQueries", () => {
  it("generates slot-oriented queries for typed facts", () => {
    const queries = generateHypeQueries("192.168.50.128", "pi_hole:ip");
    expect(queries).toHaveLength(3);
    expect(queries[0]).toContain("pi hole ip");
    expect(queries.some((q) => q.includes("What"))).toBe(true);
  });

  it("humanizes slot names with colons and underscores", () => {
    const queries = generateHypeQueries("value", "network:router_ip");
    expect(queries.some((q) => q.includes("network router ip"))).toBe(true);
  });

  it("handles slot names with hyphens", () => {
    const queries = generateHypeQueries("value", "server-host-name");
    expect(queries.some((q) => q.includes("server host name"))).toBe(true);
  });

  it("generates prose-oriented queries for non-typed facts", () => {
    const queries = generateHypeQueries(
      "Joe prefers Rust over TypeScript for systems programming.",
    );
    expect(queries).toHaveLength(3);
    expect(queries[0]).toContain("Joe prefers Rust");
  });

  it("extracts entity-based queries for prose facts", () => {
    const queries = generateHypeQueries(
      "Joe prefers Rust over TypeScript for systems programming.",
    );
    expect(queries.some((q) => q.includes("Tell me about"))).toBe(true);
  });

  it("handles empty or very short text", () => {
    const queries = generateHypeQueries("Hi");
    expect(queries.length).toBeGreaterThan(0);
  });
});

describe("bestHypeMatch", () => {
  it("returns 0 for empty embeddings", () => {
    expect(bestHypeMatch([1, 2, 3], [{ embedding: [] }])).toBe(0);
  });

  it("returns 0 for mismatched dimensions", () => {
    expect(bestHypeMatch([1, 2, 3], [{ embedding: [1, 2] }])).toBe(0);
  });

  it("returns max cosine similarity across queries", () => {
    const query = [1, 0, 0];
    const hypeQueries = [
      { embedding: [0.9, 0.1, 0] }, // close to query
      { embedding: [0.1, 0.9, 0.1] }, // orthogonal-ish
      { embedding: [1, 0, 0] }, // exact match
    ];
    const result = bestHypeMatch(query, hypeQueries);
    expect(result).toBeCloseTo(1.0, 5); // exact match → cosine = 1
  });

  it("returns 0 when all embeddings are empty", () => {
    expect(bestHypeMatch([1, 2], [{ embedding: [] }, { embedding: [] }])).toBe(0);
  });
});

describe("buildHypeLookup", () => {
  it("groups queries by factId", () => {
    const queries: StoredHypeQuery[] = [
      { factId: "fact-1", querySeq: 0, queryText: "q1", embedding: [1] },
      { factId: "fact-1", querySeq: 1, queryText: "q2", embedding: [2] },
      { factId: "fact-2", querySeq: 0, queryText: "q3", embedding: [3] },
    ];
    const lookup = buildHypeLookup(queries);
    expect(lookup.get("fact-1")).toHaveLength(2);
    expect(lookup.get("fact-2")).toHaveLength(1);
    expect(lookup.get("fact-3")).toBeUndefined();
  });

  it("handles empty array", () => {
    const lookup = buildHypeLookup([]);
    expect(lookup.size).toBe(0);
  });

  it("preserves query ordering within each fact", () => {
    const queries: StoredHypeQuery[] = [
      { factId: "f", querySeq: 2, queryText: "third", embedding: [] },
      { factId: "f", querySeq: 0, queryText: "first", embedding: [] },
      { factId: "f", querySeq: 1, queryText: "second", embedding: [] },
    ];
    const lookup = buildHypeLookup(queries);
    const list = lookup.get("f")!;
    expect(list).toHaveLength(3);
    // Queries are in array order (as returned by DB ORDER BY)
  });
});
