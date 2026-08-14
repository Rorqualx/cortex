// Pure metric rollup helpers shared by the LongMemEval harness runner
// (run-longmemeval-engine.ts) and its tests. Kept in a shebang-free module so
// vitest can import it directly (vite import-analysis rejects hashbangs).

/** Nearest-rank percentile over an UNSORTED list; 0 for empty input. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].toSorted((a, b) => a - b);
  const rank = Math.min(Math.max(Math.ceil((p / 100) * sorted.length), 1), sorted.length);
  return sorted[rank - 1] ?? 0;
}

/** Per-arm retrieval latency summary (ms). Unmeasured (error) questions are excluded. */
export function summarizeRetrievalLatency(ms: number[]): {
  count: number;
  mean: number;
  p50: number;
  p95: number;
} {
  const count = ms.length;
  const mean = count > 0 ? Math.round(ms.reduce((s, v) => s + v, 0) / count) : 0;
  return { count, mean, p50: percentile(ms, 50), p95: percentile(ms, 95) };
}
