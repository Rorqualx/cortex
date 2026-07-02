import { describe, expect, it } from "vitest";
import { submodularSelect } from "./retrieval.js";
import type { RetrievedFact, Signals } from "./retrieval.js";

function rf(text: string, score: number): RetrievedFact {
  return {
    fact: {
      id: `f-${text.slice(0, 10)}`,
      text,
      importance: 0.5,
      createdAt: Date.now(),
      dedupKey: `dk-${text}`,
    },
    score,
    signals: {} as Signals,
    chunkId: "c1",
    tier: "l2",
  };
}

describe("submodularSelect", () => {
  it("returns top-K by relevance when diversity/coverage weights are 0", () => {
    const items = [
      rf("alpha beta gamma", 0.9),
      rf("beta gamma delta", 0.8),
      rf("gamma delta epsilon", 0.7),
    ];
    const result = submodularSelect(items, new Set(["alpha"]), 2, 0, 0, null);
    expect(result.length).toBe(2);
    expect(result[0].fact.text).toBe("alpha beta gamma");
    expect(result[1].fact.text).toBe("beta gamma delta");
  });

  it("prefers diverse items when diversityWeight > 0", () => {
    // Two nearly-identical high-scorers and one distinct lower-scorer
    const items = [
      rf("the quick brown fox", 0.95),
      rf("the quick brown fox jumps", 0.94),
      rf("completely different topic", 0.5),
    ];
    const result = submodularSelect(items, new Set(["fox"]), 2, 1.0, 0, null);
    // Should pick the top one and then the diverse one, skipping the near-duplicate
    const texts = result.map((r) => r.fact.text);
    expect(texts).toContain("the quick brown fox");
    expect(texts).toContain("completely different topic");
  });

  it("rewards coverage of uncovered query tokens", () => {
    const items = [rf("apple banana", 0.6), rf("cherry date", 0.55), rf("apple cherry", 0.5)];
    const query = new Set(["apple", "banana", "cherry", "date"]);
    const result = submodularSelect(items, query, 4, 0, 1.0, null);
    // With high coverage weight, should try to cover all 4 tokens across 2-3 items
    const allText = result.map((r) => r.fact.text).join(" ");
    expect(allText).toContain("apple");
    expect(allText).toContain("banana");
    expect(allText).toContain("cherry");
    expect(allText).toContain("date");
  });

  it("respects token budget when set", () => {
    const items = [
      rf("short", 0.9),
      rf("this is a much longer fact text that consumes tokens", 0.8),
      rf("tiny", 0.7),
    ];
    // Budget ~10 tokens (40 chars)
    const result = submodularSelect(items, new Set([]), 10, 0, 0, 10);
    // Should stop when budget is exceeded
    const totalChars = result.reduce((s, r) => s + r.fact.text.length, 0);
    expect(totalChars).toBeLessThanOrEqual(10 * 4 + 10); // budget + slack for last item
  });

  it("respects topK count cap even with large budget", () => {
    const items = Array.from({ length: 10 }, (_, i) => rf(`fact ${i}`, 1.0 - i * 0.05));
    const result = submodularSelect(items, new Set([]), 3, 0, 0, 10_000);
    expect(result.length).toBe(3);
  });

  it("handles empty pool", () => {
    const result = submodularSelect([], new Set(["x"]), 5, 0.3, 0.3, null);
    expect(result).toEqual([]);
  });
});
