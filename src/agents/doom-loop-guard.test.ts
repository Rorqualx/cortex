import { describe, expect, it, vi } from "vitest";
import {
  cosineSimilarity,
  createDoomLoopGuard,
  DoomLoopDetectedError,
  meanPairwiseCosineSimilarity,
} from "./doom-loop-guard.js";

describe("createDoomLoopGuard", () => {
  it("starts unarmed and does not count failures", () => {
    const guard = createDoomLoopGuard();
    const result = guard.recordFailure("tool_error", Date.now());
    expect(result.shouldAbort).toBe(false);
    expect(result.consecutiveFailures).toBe(0);
  });

  it("counts failures after arming", () => {
    const guard = createDoomLoopGuard({ maxConsecutiveFailures: 3 });
    guard.arm();
    guard.recordFailure("tool_error", Date.now());
    guard.recordFailure("tool_error", Date.now());
    const result = guard.recordFailure("tool_error", Date.now());
    expect(result.shouldAbort).toBe(true);
    expect(result.consecutiveFailures).toBe(3);
  });

  it("reset clears failures and records lastSuccessAt", () => {
    const guard = createDoomLoopGuard({ maxConsecutiveFailures: 3 });
    guard.arm();
    guard.recordFailure("tool_error", Date.now());
    guard.reset();
    const snapshot = guard.snapshot();
    expect(snapshot.consecutiveFailures).toBe(0);
    expect(snapshot.lastSuccessAt).toBeTypeOf("number");
    expect(snapshot.lastFailureAt).toBeUndefined();
  });

  it("getFailureBoundary returns lastSuccessAt after reset", () => {
    const guard = createDoomLoopGuard();
    expect(guard.getFailureBoundary()).toBeUndefined();
    guard.reset();
    const boundary = guard.getFailureBoundary();
    expect(boundary).toBeTypeOf("number");
    expect(boundary).toBeGreaterThan(0);
  });

  it("snapshot includes lastSuccessAt", () => {
    const guard = createDoomLoopGuard();
    guard.reset();
    const snap = guard.snapshot();
    expect(snap.lastSuccessAt).toBeTypeOf("number");
  });

  it("createRevisePrompt includes checkpoint when boundary exists", () => {
    const guard = createDoomLoopGuard();
    guard.arm();
    guard.reset();
    const prompt = guard.createRevisePrompt();
    expect(prompt).toContain("Doom-loop recovery triggered");
    expect(prompt).toContain("last successful checkpoint:");
    expect(prompt).toContain("Do NOT retry the same strategy");
    expect(prompt).toContain("try a different strategy");
  });

  it("createRevisePrompt works without boundary", () => {
    const guard = createDoomLoopGuard();
    guard.arm();
    const prompt = guard.createRevisePrompt();
    expect(prompt).toContain("Doom-loop recovery triggered");
    expect(prompt).not.toContain("last successful checkpoint:");
  });

  it("DoomLoopDetectedError.fromVerdict captures details", () => {
    const verdict = {
      shouldAbort: true as const,
      consecutiveFailures: 5,
      reason: "test doom",
      detector: "doom_loop" as const,
    };
    const err = DoomLoopDetectedError.fromVerdict(verdict);
    expect(err.name).toBe("DoomLoopDetectedError");
    expect(err.consecutiveFailures).toBe(5);
    expect(err.detector).toBe("doom_loop");
  });

  it("recordConfidenceSignal treats low confidence as a countable failure", () => {
    const guard = createDoomLoopGuard({ maxConsecutiveFailures: 3 });
    guard.arm();
    const r1 = guard.recordConfidenceSignal(0.3);
    expect(r1.shouldAbort).toBe(false);
    expect(r1.consecutiveFailures).toBe(1);
    const r2 = guard.recordConfidenceSignal(0.4);
    expect(r2.consecutiveFailures).toBe(2);
    const r3 = guard.recordConfidenceSignal(0.2);
    expect(r3.shouldAbort).toBe(true);
  });

  it("recordConfidenceSignal ignores high confidence", () => {
    const guard = createDoomLoopGuard({ maxConsecutiveFailures: 3 });
    guard.arm();
    guard.recordFailure("tool_error", Date.now());
    const r = guard.recordConfidenceSignal(0.9);
    expect(r.shouldAbort).toBe(false);
    expect(r.consecutiveFailures).toBe(1); // unchanged from the tool_error
  });

  it("recordConfidenceSignal uses custom threshold", () => {
    const guard = createDoomLoopGuard({ maxConsecutiveFailures: 2 });
    guard.arm();
    const r1 = guard.recordConfidenceSignal(0.6, 0.7);
    expect(r1.consecutiveFailures).toBe(1);
    const r2 = guard.recordConfidenceSignal(0.6, 0.7);
    expect(r2.shouldAbort).toBe(true);
  });

  it("failure window expiration resets counter", () => {
    const now = 1_000_000;
    const guard = createDoomLoopGuard({
      maxConsecutiveFailures: 3,
      failureWindowMs: 100,
    });
    guard.arm();
    guard.recordFailure("tool_error", now);
    guard.recordFailure("tool_error", now + 50);
    // Third failure is outside the window
    const result = guard.recordFailure("tool_error", now + 200);
    expect(result.shouldAbort).toBe(false);
    expect(result.consecutiveFailures).toBe(1);
  });
});

describe("cosineSimilarity", () => {
  it("returns 1.0 for identical vectors", () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 6);
  });

  it("returns 0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
  });

  it("returns 0 when lengths mismatch", () => {
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
  });

  it("returns 0 when empty", () => {
    expect(cosineSimilarity([], [])).toBe(0);
  });

  it("returns negative for opposite vectors", () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1, 6);
  });
});

describe("meanPairwiseCosineSimilarity", () => {
  it("returns 0 for buffer with < 2 items", () => {
    expect(meanPairwiseCosineSimilarity([[1, 0]])).toBe(0);
    expect(meanPairwiseCosineSimilarity([])).toBe(0);
  });

  it("returns 1.0 when all vectors are identical", () => {
    expect(
      meanPairwiseCosineSimilarity([
        [1, 2, 3],
        [1, 2, 3],
        [1, 2, 3],
      ]),
    ).toBeCloseTo(1, 6);
  });

  it("returns 0 when all vectors are orthogonal", () => {
    expect(
      meanPairwiseCosineSimilarity([
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ]),
    ).toBeCloseTo(0, 6);
  });
});

describe("recordResponseEmbedding (semantic convergence)", () => {
  it("returns undefined when convergence is not configured", () => {
    const guard = createDoomLoopGuard();
    guard.arm();
    const result = guard.recordResponseEmbedding([1, 2, 3]);
    expect(result).toBeUndefined();
  });

  it("returns non-abort when buffer is below threshold", () => {
    const guard = createDoomLoopGuard({
      semanticConvergence: { bufferSize: 5, similarityThreshold: 0.95, consecutiveRounds: 3 },
    });
    guard.arm();
    // First embedding — not enough to compare
    const r1 = guard.recordResponseEmbedding([1, 2, 3]);
    expect(r1).toBeUndefined();
    // Second embedding — very different, won't converge
    const r2 = guard.recordResponseEmbedding([-1, -2, -3]);
    expect(r2?.shouldAbort).toBe(false);
  });

  it("fires when embeddings are nearly identical for enough consecutive rounds", () => {
    const guard = createDoomLoopGuard({
      semanticConvergence: { bufferSize: 2, similarityThreshold: 0.95, consecutiveRounds: 2 },
    });
    guard.arm();

    const emb = [1, 2, 3];
    // Fill buffer with 2 identical embeddings: mean pairwise cosine = 1.0
    guard.recordResponseEmbedding(emb);
    guard.recordResponseEmbedding(emb);
    // This is round 1 of high similarity: mean similarity 1.0 ≥ 0.95
    // But consecutiveRounds is 2, so it won't fire yet

    // Add another — buffer shifts, still full, still high similarity
    // This is round 2, should fire
    const result = guard.recordResponseEmbedding(emb);
    expect(result?.shouldAbort).toBe(true);
    expect(result?.detector).toBe("semantic_convergence");
  });

  it("resets consecutive count when similarity drops", () => {
    const guard = createDoomLoopGuard({
      semanticConvergence: { bufferSize: 3, similarityThreshold: 0.95, consecutiveRounds: 3 },
    });
    guard.arm();

    const emb = [1, 2, 3];
    // Build up high similarity
    guard.recordResponseEmbedding(emb);
    guard.recordResponseEmbedding(emb);
    guard.recordResponseEmbedding(emb);

    // Then break with a different embedding
    const result = guard.recordResponseEmbedding([-1, -2, -3]);
    expect(result?.shouldAbort).toBe(false);
  });

  it("reset clears the embedding buffer and convergence counter", () => {
    const guard = createDoomLoopGuard({
      semanticConvergence: { bufferSize: 3, similarityThreshold: 0.95, consecutiveRounds: 2 },
    });
    guard.arm();

    const emb = [1, 2, 3];
    guard.recordResponseEmbedding(emb);
    guard.recordResponseEmbedding(emb);
    guard.recordResponseEmbedding(emb);
    // should be at convergenceCount 1 now
    guard.reset();
    // After reset, buffer is cleared — first embedding back
    const r = guard.recordResponseEmbedding(emb);
    expect(r).toBeUndefined();
  });
});
