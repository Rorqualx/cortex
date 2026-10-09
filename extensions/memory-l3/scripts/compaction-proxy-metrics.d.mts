// Type declarations for compaction-proxy-metrics.mjs (REMORY proxy-metric
// script). The .mjs intentionally stays untyped JS; these signatures mirror
// its exports so TS import sites (run-longmemeval-engine.ts) type-check.
export declare function isToolErrorToolResult(
  payloadText: string | unknown,
  flags?: { isError?: boolean | string; is_error?: boolean },
): boolean;
export declare function computeCompactionProxyMetrics(
  messages: ReadonlyArray<Record<string, unknown> | null | undefined> | null | undefined,
): {
  toolMessages: number;
  distinctToolOutputs: number;
  repeatedToolOutputs: number;
  repeatedToolOutputRate: number;
  toolErrors: number;
  toolErrorRate: number;
};
export declare function sumCompactionProxyMetrics(
  list:
    | ReadonlyArray<{
        toolMessages: number;
        distinctToolOutputs: number;
        repeatedToolOutputs: number;
        repeatedToolOutputRate: number;
        toolErrors: number;
        toolErrorRate: number;
      }>
    | null
    | undefined,
): {
  toolMessages: number;
  distinctToolOutputs: number;
  repeatedToolOutputs: number;
  repeatedToolOutputRate: number;
  toolErrors: number;
  toolErrorRate: number;
};
