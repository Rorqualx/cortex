import { describe, expect, it } from "vitest";
// Imported from harness-metrics.ts — the pure rollup helpers the runner uses.
import { percentile, summarizeRetrievalLatency } from "./harness-metrics.js";

// Mirror of the diagnostic function in run-longmemeval-engine.ts
function checkAnswerInContext(answer: string | number, context: string): boolean {
  const normCtx = context.toLowerCase();
  const raw = String(answer).trim().toLowerCase();
  if (normCtx.includes(raw)) {
    return true;
  }
  const stripped = raw.replace(/[,\s]/g, "");
  if (normCtx.includes(stripped)) {
    return true;
  }
  return false;
}

describe("checkAnswerInContext", () => {
  it("matches exact substring", () => {
    expect(checkAnswerInContext("Paris", "The capital of France is Paris.")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(checkAnswerInContext("paris", "The capital of France is PARIS.")).toBe(true);
  });

  it("matches numbers", () => {
    expect(checkAnswerInContext(42, "The answer is 42.")).toBe(true);
  });

  it("normalises comma separators", () => {
    expect(checkAnswerInContext("1,234", "There are 1234 entries.")).toBe(true);
  });

  it("returns false when absent", () => {
    expect(checkAnswerInContext("London", "The capital of France is Paris.")).toBe(false);
  });

  it("handles empty context", () => {
    expect(checkAnswerInContext("foo", "")).toBe(false);
  });
});

describe("percentile", () => {
  it("returns 0 for empty input", () => {
    expect(percentile([], 50)).toBe(0);
  });

  it("computes nearest-rank p50", () => {
    // sorted: [10, 20, 30, 40, 50, 60, 70, 80, 90, 100] — nearest-rank p50 = ceil(5) = 5th = 50
    const ms = [40, 10, 60, 20, 80, 30, 100, 50, 70, 90];
    expect(percentile(ms, 50)).toBe(50);
  });

  it("computes nearest-rank p95", () => {
    const ms = [40, 10, 60, 20, 80, 30, 100, 50, 70, 90];
    // ceil(0.95 * 10) = 10th (clamped to max rank) = 100
    expect(percentile(ms, 95)).toBe(100);
  });

  it("clamps rank into range for small inputs", () => {
    expect(percentile([7], 50)).toBe(7);
    expect(percentile([3, 9], 95)).toBe(9);
    expect(percentile([9, 3], 1)).toBe(3);
  });
});

describe("summarizeRetrievalLatency", () => {
  it("summarizes count/mean/p50/p95", () => {
    const s = summarizeRetrievalLatency([100, 300, 200]);
    expect(s).toEqual({ count: 3, mean: 200, p50: 200, p95: 300 });
  });

  it("handles the empty (all-error) run", () => {
    expect(summarizeRetrievalLatency([])).toEqual({ count: 0, mean: 0, p50: 0, p95: 0 });
  });
});
