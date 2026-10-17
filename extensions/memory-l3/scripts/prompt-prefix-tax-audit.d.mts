export declare const MEMORY_RECALL_SECTION: string;
export declare const BOUNDARY_BREAK_CAUSES: string[];
export declare function parseArgs(argv: string[]): Record<string, string | true>;
export declare function parseFeed(text: string): Array<Record<string, unknown>>;
export declare function estTokensFromChars(chars: number): number;
export interface RecordMetrics {
  turn: number;
  suffixTokens: number;
  recallTokens: number;
  recallShare: number | null;
  cacheHitRatio: number | null;
  rePrefillTaxTokens: number | null;
  costUsd: number | null;
  dropCause: string | null;
  boundaryBreak: boolean;
}
export declare function computeRecordMetrics(
  rec: Record<string, unknown>,
  pricingInPerM?: number,
): RecordMetrics;
export interface Aggregate {
  n: number;
  suffixTokensMean: number | null;
  suffixTokensMedian: number | null;
  cacheHitRatioMean: number | null;
  rePrefillTaxTotal: number | null;
  rePrefillTaxMean: number | null;
  recallShareMean: number | null;
  telemetryRecords: number;
  boundaryBreaks: number;
  dropCauseHistogram: Record<string, number>;
  metrics: RecordMetrics[];
}
export declare function aggregate(
  records: Array<Record<string, unknown>>,
  pricingInPerM?: number,
): Aggregate;
export declare function renderReport(
  agg: Aggregate,
  meta: { feed: string; date?: string; pricingInPerM?: number },
): string;
export declare function main(argv: string[]): void;
