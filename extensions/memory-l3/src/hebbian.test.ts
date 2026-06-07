import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  type HebbianConfig,
  type HebbianEdge,
  buildEdgeLookup,
  extractEdges,
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
      const config: HebbianConfig = { neighborWeight: 0.05, maxEdgeWeight: 10, enabled: false };
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
      const scores = new Map<string, number>([["k:2", 1.0]]);
      const config: HebbianConfig = { neighborWeight: 0.05, maxEdgeWeight: 5, enabled: true };
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

  describe("edgeKey", () => {
    it("sorts keys deterministically", () => {
      assert.strictEqual(edgeKey("b", "a"), "a::b");
      assert.strictEqual(edgeKey("a", "b"), "a::b");
    });
  });
});
