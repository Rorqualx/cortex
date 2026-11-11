export declare function parseArgs(argv: string[]): Record<string, string | true>;
export interface TelemetryEvent {
  ts: number;
  sessionId: string;
  sessionKey?: string | null;
  intentClass?: string | null;
  preset?: string | null;
  topK?: number | null;
  factIds: string[];
  estTokens?: number | null;
  source: string;
}
export interface TelemetryOutcome {
  sessionKey: string;
  ts: number;
  ok: boolean;
  detail?: string | null;
}
export interface AggregateBucket {
  intentClass: string;
  preset: string;
  n: number;
  joined: number;
  okCount: number;
  successRate: number | null;
  meanTokens: number | null;
}
export interface AggregateResult {
  buckets: AggregateBucket[];
  unjoinedRate: number;
}
export declare function loadOutcomesJsonl(text: string): TelemetryOutcome[];
export declare function aggregate(
  events: TelemetryEvent[],
  outcomes: TelemetryOutcome[],
): AggregateResult;
export declare function verdictLine(buckets: AggregateBucket[], minN: number): string;
export declare function readEventsDb(dbPath: string, sinceTs?: number): TelemetryEvent[];
export declare function readOutcomesDb(dbPath: string): TelemetryOutcome[];
export declare function pruneEventsDb(dbPath: string, beforeTs: number): number;
export declare function renderReport(
  agg: AggregateResult,
  meta: { sinceDays: number; minN: number; outcomeSource: string },
): string;
export declare function main(argv: string[]): number;
