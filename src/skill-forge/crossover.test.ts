import { describe, expect, it } from "vitest";
import {
  CROSSOVER_SUCCESS_THRESHOLD,
  CROSSOVER_TOOL_OVERLAP_MIN,
  generateCrossoverCandidates,
  mergeToolSequences,
} from "./crossover.js";
import type { Candidate, RepetitionCandidate } from "./detector.js";

function makeRepCandidate(
  id: string,
  tools: string[],
  score: number,
  occurrences = 3,
  captureDirs: string[] = ["/tmp/a"],
): RepetitionCandidate {
  return {
    lane: "tool-shape",
    candidateId: id,
    toolShapeHash: `hash-${id}`,
    toolSequence: tools,
    captureDirs,
    occurrences,
    successScore: score,
  };
}

describe("mergeToolSequences", () => {
  it("merges two sequences preserving order and deduplicating", () => {
    expect(mergeToolSequences(["read", "write", "exec"], ["read", "edit", "exec"])).toEqual([
      "read",
      "write",
      "exec",
      "edit",
    ]);
  });

  it("returns the first sequence when second is subset", () => {
    expect(mergeToolSequences(["read", "write"], ["read"])).toEqual(["read", "write"]);
  });

  it("handles empty sequences", () => {
    expect(mergeToolSequences([], ["read"])).toEqual(["read"]);
    expect(mergeToolSequences(["read"], [])).toEqual(["read"]);
    expect(mergeToolSequences([], [])).toEqual([]);
  });
});

describe("generateCrossoverCandidates", () => {
  it("returns empty when fewer than 2 eligible candidates", () => {
    const candidates = [makeRepCandidate("a", ["read", "write"], 0.8)];
    expect(generateCrossoverCandidates(candidates)).toEqual([]);
  });

  it("returns empty when candidates are below success threshold", () => {
    const candidates = [
      makeRepCandidate("a", ["read", "write"], 0.3),
      makeRepCandidate("b", ["read", "exec"], 0.4),
    ];
    expect(generateCrossoverCandidates(candidates)).toEqual([]);
  });

  it("generates crossover for high-score overlapping pairs", () => {
    const candidates = [
      makeRepCandidate("a", ["read", "write", "exec"], 0.8),
      makeRepCandidate("b", ["read", "edit", "exec"], 0.7),
    ];
    const result = generateCrossoverCandidates(candidates);
    expect(result).toHaveLength(1);
    expect(result[0]!.candidateId).toMatch(/^xover-/);
    expect(result[0]!.toolSequence).toEqual(["read", "write", "exec", "edit"]);
    expect(result[0]!.successScore).toBeGreaterThan(0.7);
    expect(result[0]!.successScore).toBeLessThanOrEqual(1);
  });

  it("skips pairs with identical tool sequences (overlap = 1.0)", () => {
    const candidates = [
      makeRepCandidate("a", ["read", "write"], 0.9),
      makeRepCandidate("b", ["read", "write"], 0.9),
    ];
    const result = generateCrossoverCandidates(candidates);
    // overlap is 1.0 — no crossover value
    expect(result).toEqual([]);
  });

  it("skips pairs with no tool overlap", () => {
    const candidates = [
      makeRepCandidate("a", ["read", "write"], 0.9),
      makeRepCandidate("b", ["exec", "shell"], 0.9),
    ];
    const result = generateCrossoverCandidates(candidates);
    expect(result).toEqual([]);
  });

  it("respects maxOutput limit", () => {
    const candidates: Candidate[] = [];
    for (let i = 0; i < 10; i++) {
      candidates.push(
        makeRepCandidate(
          `c${i}`,
          i % 2 === 0 ? ["read", `tool-${i}`, "exec"] : ["read", `tool-${i}`, "write"],
          0.8,
        ),
      );
    }
    const result = generateCrossoverCandidates(candidates, { maxOutput: 3 });
    expect(result.length).toBeLessThanOrEqual(3);
  });

  it("uses configurable successThreshold", () => {
    const candidates = [
      makeRepCandidate("a", ["read", "write", "exec"], 0.5),
      makeRepCandidate("b", ["read", "edit", "exec"], 0.5),
    ];
    // Default threshold is 0.6 — these should NOT crossover
    expect(generateCrossoverCandidates(candidates)).toEqual([]);
    // Lower threshold — should crossover
    const result = generateCrossoverCandidates(candidates, { successThreshold: 0.4 });
    expect(result).toHaveLength(1);
  });

  it("deduplicates pair combinations (symmetric)", () => {
    const candidates = [
      makeRepCandidate("a", ["read", "write", "exec"], 0.8),
      makeRepCandidate("b", ["read", "edit", "exec"], 0.7),
    ];
    const r1 = generateCrossoverCandidates(candidates);
    const r2 = generateCrossoverCandidates([...candidates].reverse());
    expect(r1).toHaveLength(1);
    expect(r2).toHaveLength(1);
    expect(r1[0]!.candidateId).toBe(r2[0]!.candidateId);
  });

  it("merged candidate has correct lane and shape", () => {
    const candidates = [
      makeRepCandidate("a", ["read", "write", "exec"], 0.9, 3, ["/tmp/a"]),
      makeRepCandidate("b", ["read", "edit", "exec"], 0.8, 2, ["/tmp/b"]),
    ];
    const [result] = generateCrossoverCandidates(candidates);
    expect(result).toBeDefined();
    expect(result!.lane).toBe("tool-shape");
    expect(result!.occurrences).toBe(5); // 3 + 2
    expect(result!.captureDirs).toContain("/tmp/a");
    expect(result!.captureDirs).toContain("/tmp/b");
    expect(result!.captureDirs).toHaveLength(2);
  });

  it("handles candidates with empty tool sequences gracefully", () => {
    const empty: Candidate = {
      lane: "tool-shape",
      candidateId: "empty",
      toolShapeHash: "x",
      toolSequence: [],
      captureDirs: [],
      occurrences: 0,
      successScore: 0.9,
    };
    const real = makeRepCandidate("real", ["read", "write"], 0.8);
    expect(generateCrossoverCandidates([empty, real])).toEqual([]);
  });
});
