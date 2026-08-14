import { describe, expect, it } from "vitest";

// Mirror of the diagnostic function in run-longmemeval-engine.ts
function checkAnswerInContext(answer: string | number, context: string): boolean {
  const normCtx = context.toLowerCase();
  const raw = String(answer).trim().toLowerCase();
  if (normCtx.includes(raw)) return true;
  const stripped = raw.replace(/[,\s]/g, "");
  if (normCtx.includes(stripped)) return true;
  return false;
}

// Mirror of the percentile helper in run-longmemeval-engine.ts (linear
// interpolation over an ascending-sorted array).
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0] ?? 0;
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const loV = sorted[lo] ?? 0;
  const hiV = sorted[hi] ?? 0;
  return loV + (hiV - loV) * (idx - lo);
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

describe("percentile (retrieval latency / context-token rollup)", () => {
  it("returns 0 on empty input", () => {
    expect(percentile([], 50)).toBe(0);
    expect(percentile([], 95)).toBe(0);
  });

  it("returns the single value for length-1 input", () => {
    expect(percentile([42], 50)).toBe(42);
    expect(percentile([42], 95)).toBe(42);
  });

  it("interpolates linearly between neighbors", () => {
    // p50 of [10,20] -> idx 0.5 -> 15
    expect(percentile([10, 20], 50)).toBe(15);
    // p95 of [10,20] -> idx 0.95 -> 19.5
    expect(percentile([10, 20], 95)).toBe(19.5);
  });

  it("hits exact array elements when p aligns", () => {
    const sorted = [5, 10, 15, 20, 25];
    expect(percentile(sorted, 50)).toBe(15);
    expect(percentile(sorted, 100)).toBe(25);
    expect(percentile(sorted, 0)).toBe(5);
  });

  it("keeps p95 below max for a latency-shaped distribution", () => {
    const latencies = [12, 18, 22, 31, 44, 58, 90, 140, 310, 1800].sort((a, b) => a - b);
    const p50 = percentile(latencies, 50);
    const p95 = percentile(latencies, 95);
    expect(p50).toBeLessThan(p95);
    expect(p95).toBeLessThanOrEqual(1800);
    expect(p95).toBeGreaterThanOrEqual(310);
  });
});
