import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  type HebbianConfig,
  type HebbianEdge,
  buildEdgeLookup,
  extractEdges,
  extractEdgesFromRetrieval,
  hebbianBoost,
  mergeEdges,
  edgeKey,
} from "./hebbian.js";
import type { L2Fact } from "./types.js";

function makeFact(id: string, dedupKey: string): L2Fact {
  return {
    id,
    text: `Fact ${id}`,
    importance: 0.5,
    createdAt: Date.now(),
    dedupKey,
  };
}

describe("hebbian", () => {
  describe("extractEdges", () => {
    it("returns empty for 0 or 1 facts", () => {
      assert.deepStrictEqual(extractEdges([]), []);
      assert.deepStrictEqual(extractEdges([makeFact("a", "key:a")]), []);
    });

    it("creates one edge for two facts", () => {
      const facts = [makeFact("a", "key:alpha"), makeFact("b", "key:beta")];
      const edges = extractEdges(facts);
      assert.strictEqual(edges.length, 1);
      assert.strictEqual(edges[0].weight, 1);
      // Keys sorted
      assert.strictEqual(edges[0].a, "key:alpha");
      assert.strictEqual(edges[0].b, "key:beta");
    });

    it("creates N*(N-1)/2 edges for N facts", () => {
      const facts = [
        makeFact("a", "k:1"),
        makeFact("b", "k:2"),
        makeFact("c", "k:3"),
        makeFact("d", "k:4"),
      ];
      const edges = extractEdges(facts);
      assert.strictEqual(edges.length, 6); // 4*3/2
    });

    it("skips edges between facts with same dedupKey", () => {
      const facts = [makeFact("a", "same"), makeFact("b", "same")];
      const edges = extractEdges(facts);
      assert.strictEqual(edges.length, 0);
    });

    it("sorts keys in edges canonically", () => {
      const facts = [makeFact("z", "key:zebra"), makeFact("a", "key:ant")];
      const edges = extractEdges(facts);
      assert.strictEqual(edges[0].a, "key:ant");
      assert.strictEqual(edges[0].b, "key:zebra");
    });
  });

  describe("mergeEdges", () => {
    it("returns new edges when existing is empty", () => {
      const newEdges: HebbianEdge[] = [{ a: "k:1", b: "k:2", weight: 1 }];
      const result = mergeEdges([], newEdges);
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].weight, 1);
    });

    it("increments weight for repeated co-occurrence", () => {
      const existing: HebbianEdge[] = [{ a: "k:1", b: "k:2", weight: 2 }];
      const newEdges: HebbianEdge[] = [{ a: "k:1", b: "k:2", weight: 1 }];
      const result = mergeEdges(existing, newEdges);
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].weight, 3);
    });

    it("adds new edges alongside existing", () => {
      const existing: HebbianEdge[] = [{ a: "k:1", b: "k:2", weight: 1 }];
      const newEdges: HebbianEdge[] = [{ a: "k:2", b: "k:3", weight: 1 }];
      const result = mergeEdges(existing, newEdges);
      assert.strictEqual(result.length, 2);
    });

    it("handles empty new edges", () => {
      const existing: HebbianEdge[] = [{ a: "k:1", b: "k:2", weight: 5 }];
      const result = mergeEdges(existing, []);
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].weight, 5);
    });
  });

  describe("buildEdgeLookup", () => {
    it("builds bidirectional lookup", () => {
      const edges: HebbianEdge[] = [
        { a: "k:1", b: "k:2", weight: 1 },
        { a: "k:1", b: "k:3", weight: 2 },
      ];
      const lookup = buildEdgeLookup(edges);
      assert.strictEqual(lookup.get("k:1")!.length, 2);
      assert.strictEqual(lookup.get("k:2")!.length, 1);
      assert.strictEqual(lookup.get("k:3")!.length, 1);
      assert.strictEqual(lookup.has("k:4"), false);
    });
  });

  describe("hebbianBoost", () => {
    it("returns 0 when disabled", () => {
      const lookup = buildEdgeLookup([{ a: "k:1", b: "k:2", weight: 5 }]);
      const scores = new Map<string, number>([["k:2", 0.8]]);
      const config: HebbianConfig = {
        neighborWeight: 0.05,
        maxEdgeWeight: 10,
        enabled: false,
        twoHopDecay: 0,
      };
      assert.strictEqual(hebbianBoost("k:1", lookup, scores, config), 0);
    });

    it("returns 0 when fact has no edges", () => {
      const lookup = new Map<string, HebbianEdge[]>();
      const scores = new Map<string, number>();
      assert.strictEqual(hebbianBoost("k:lonely", lookup, scores), 0);
    });

    it("computes boost from neighbor scores", () => {
      const lookup = buildEdgeLookup([{ a: "k:1", b: "k:2", weight: 3 }]);
      const scores = new Map<string, number>([["k:2", 0.8]]);
      // boost = 0.8 * min(3, 10) * 0.05 = 0.8 * 3 * 0.05 = 0.12
      const boost = hebbianBoost("k:1", lookup, scores);
      assert.ok(Math.abs(boost - 0.12) < 1e-10);
    });

    it("caps edge weight at maxEdgeWeight", () => {
      const lookup = buildEdgeLookup([{ a: "k:1", b: "k:2", weight: 100 }]);
      const scores = new Map<string, number>([["k:2", 1]]);
      const config: HebbianConfig = {
        neighborWeight: 0.05,
        maxEdgeWeight: 5,
        enabled: true,
        twoHopDecay: 0,
      };
      // boost = 1.0 * min(100, 5) * 0.05 = 1.0 * 5 * 0.05 = 0.25
      const boost = hebbianBoost("k:1", lookup, scores, config);
      assert.strictEqual(boost, 0.25);
    });

    it("sums contributions from multiple neighbors", () => {
      const lookup = buildEdgeLookup([
        { a: "k:1", b: "k:2", weight: 2 },
        { a: "k:1", b: "k:3", weight: 3 },
      ]);
      const scores = new Map<string, number>([
        ["k:2", 0.5],
        ["k:3", 0.4],
      ]);
      // boost = (0.5 * 2 * 0.05) + (0.4 * 3 * 0.05) = 0.05 + 0.06 = 0.11
      const boost = hebbianBoost("k:1", lookup, scores);
      assert.ok(Math.abs(boost - 0.11) < 1e-10);
    });

    it("walks two hops with decay when enabled", () => {
      // k:1 - k:2 - k:3 chain; k:3 only reachable at hop 2.
      const lookup = buildEdgeLookup([
        { a: "k:1", b: "k:2", weight: 4 },
        { a: "k:2", b: "k:3", weight: 2 },
      ]);
      const scores = new Map<string, number>([
        ["k:2", 0.5],
        ["k:3", 0.8],
      ]);
      const config: HebbianConfig = {
        neighborWeight: 0.05,
        maxEdgeWeight: 10,
        enabled: true,
        twoHopDecay: 0.3,
      };
      // hop1: 0.5 * 4 * 0.05 = 0.1
      // hop2: 0.8 * min(4, 2) * 0.05 * 0.3 = 0.8 * 2 * 0.015 = 0.024
      const boost = hebbianBoost("k:1", lookup, scores, config);
      assert.ok(Math.abs(boost - 0.124) < 1e-10);
      // Default config keeps the second hop dark.
      const oneHopOnly = hebbianBoost("k:1", lookup, scores);
      assert.ok(Math.abs(oneHopOnly - 0.1) < 1e-10);
    });

    it("never double-counts direct neighbors or the origin through hop two", () => {
      // Triangle: every node is a direct neighbor of every other.
      const lookup = buildEdgeLookup([
        { a: "k:1", b: "k:2", weight: 1 },
        { a: "k:1", b: "k:3", weight: 1 },
        { a: "k:2", b: "k:3", weight: 1 },
      ]);
      const scores = new Map<string, number>([
        ["k:2", 1],
        ["k:3", 1],
      ]);
      const config: HebbianConfig = {
        neighborWeight: 0.05,
        maxEdgeWeight: 10,
        enabled: true,
        twoHopDecay: 1,
      };
      // Only the two direct contributions: 1 * 1 * 0.05 each.
      const boost = hebbianBoost("k:1", lookup, scores, config);
      assert.ok(Math.abs(boost - 0.1) < 1e-10);
    });

    it("ignores neighbors with non-positive scores", () => {
      const lookup = buildEdgeLookup([
        { a: "k:1", b: "k:2", weight: 2 },
        { a: "k:1", b: "k:3", weight: 3 },
      ]);
      const scores = new Map<string, number>([["k:3", 0.4]]);
      // k:2 has no score (0), only k:3 contributes
      const boost = hebbianBoost("k:1", lookup, scores);
      assert.ok(Math.abs(boost - 0.06) < 1e-10); // 0.4 * 3 * 0.05
    });
  });

  describe("extractEdgesFromRetrieval", () => {
    it("returns empty for 0 or 1 results", () => {
      assert.deepStrictEqual(extractEdgesFromRetrieval([]), []);
      assert.deepStrictEqual(extractEdgesFromRetrieval([{ fact: { dedupKey: "k:a" } }]), []);
    });

    it("creates one edge for two retrieval results", () => {
      const results = [{ fact: { dedupKey: "key:alpha" } }, { fact: { dedupKey: "key:beta" } }];
      const edges = extractEdgesFromRetrieval(results);
      assert.strictEqual(edges.length, 1);
      assert.strictEqual(edges[0].weight, 1);
      assert.strictEqual(edges[0].a, "key:alpha");
      assert.strictEqual(edges[0].b, "key:beta");
    });

    it("creates N*(N-1)/2 edges for N results", () => {
      const results = [
        { fact: { dedupKey: "k:1" } },
        { fact: { dedupKey: "k:2" } },
        { fact: { dedupKey: "k:3" } },
        { fact: { dedupKey: "k:4" } },
      ];
      const edges = extractEdgesFromRetrieval(results);
      assert.strictEqual(edges.length, 6); // 4*3/2
    });

    it("skips edges between facts with same dedupKey", () => {
      const results = [{ fact: { dedupKey: "same" } }, { fact: { dedupKey: "same" } }];
      const edges = extractEdgesFromRetrieval(results);
      assert.strictEqual(edges.length, 0);
    });

    it("sorts keys canonically", () => {
      const results = [{ fact: { dedupKey: "key:zebra" } }, { fact: { dedupKey: "key:ant" } }];
      const edges = extractEdgesFromRetrieval(results);
      assert.strictEqual(edges[0].a, "key:ant");
      assert.strictEqual(edges[0].b, "key:zebra");
    });
  });

  describe("edgeKey", () => {
    it("sorts keys deterministically", () => {
      assert.strictEqual(edgeKey("b", "a"), "a::b");
      assert.strictEqual(edgeKey("a", "b"), "a::b");
    });
  });
});
