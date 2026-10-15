// Type declarations for sweep-topk.mjs (LongMemEval accuracy-vs-budget sweep
// driver). The .mjs intentionally stays untyped JS; these signatures mirror
// its exports so TS test/import sites type-check against it.
export declare function parseBudgets(raw: string): string[];
export declare function parseEngineOverall(
  stdout: string,
): { exactMatchPct: number; answerInContextPct: number } | null;
export declare function parseJudgeOverall(
  stdout: string,
): { hits: number; total: number; pct: number } | null;
export declare function parseWroteHypothesis(stdout: string): string | null;
export declare function parseTokenLine(stdout: string): {
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  estimatedCostUsd: number;
} | null;
