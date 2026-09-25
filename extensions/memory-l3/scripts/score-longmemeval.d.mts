// Type declarations for score-longmemeval.mjs (plain-JS LongMemEval scoring
// script). The .mjs intentionally stays untyped JS; these signatures mirror
// its exports so TS test/import sites type-check against it.
export declare function extractTemporalExpressions(text: string | null | undefined): string[];
export declare function countTemporalPreserved(
  answer: string | null | undefined,
  response: string | null | undefined,
): { total: number; preserved: number };
export declare function parseDimensionScores(
  raw: string,
): {
  faithfulness: number;
  completeness: number;
  factualConsistency: number;
  clarity: number;
} | null;
export declare function computeWeightedComposite(scores: Record<string, number>): number;
