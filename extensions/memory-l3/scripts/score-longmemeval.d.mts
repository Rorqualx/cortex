// Type declarations for score-longmemeval.mjs (plain-JS LongMemEval scoring
// script). The .mjs intentionally stays untyped JS; these signatures mirror
// its exports so TS test/import sites type-check against it.
export declare function extractTemporalExpressions(text: string | null | undefined): string[];
export declare function countTemporalPreserved(
  answer: string | null | undefined,
  response: string | null | undefined,
): { total: number; preserved: number };
export declare function parseDimensionScores(raw: string): {
  faithfulness: number;
  completeness: number;
  factualConsistency: number;
  clarity: number;
} | null;
export declare function computeWeightedComposite(scores: Record<string, number>): number;
export declare function pickStabilitySample<T>(
  items: readonly T[],
  size: number,
  seed: number,
): T[];
export declare function summarizeStabilityRuns(verdicts: Array<boolean | null>): {
  repeats: number;
  distinctVerdicts: number;
  flipped: boolean;
  unparseable: number;
};
export declare function buildAttributionPrompt(
  question: string,
  answer: string,
  packet: string,
): string;
export declare function parseAttribution(
  raw: string | null | undefined,
): "retrieval-miss" | "reader-miss" | null;

// QW1 (2026-11-14): slate-completeness decomposition of LongMemEval accuracy.
export type SlateCompletenessVerdict =
  | "all-evidence-admitted"
  | "partial"
  | "retrieval-miss"
  | "window-overflow"
  | "approx-present"
  | "approx-absent";
export declare function classifySlateCompleteness(input: {
  goldSessions: readonly string[];
  admittedSessions: ReadonlySet<string>;
  storeSessions: ReadonlySet<string>;
  answerInContext: boolean;
}): {
  verdict: SlateCompletenessVerdict;
  exact: boolean;
  goldSessions: string[];
  admittedGold: number;
  inStoreGold: number;
};
export declare function summarizeSlateCompleteness(
  rows: ReadonlyArray<{
    slate_completeness?: {
      verdict: string;
      exact: boolean;
    } | null;
  }>,
): { probed: number; exact: number; approximate: number; counts: Record<string, number> };
