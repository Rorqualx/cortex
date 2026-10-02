// Type declarations for run-lmeb.mjs (plain-JS LMEB embedding-provider gate
// script). The .mjs intentionally stays untyped JS; these signatures mirror
// its exports so TS test/import sites type-check against it.
export declare function tokenizeText(text: string | null | undefined): string[];
export declare function buildProbeQuery(
  docText: string | null | undefined,
  maxTerms?: number,
): string;
export declare function hashEmbed(text: string | null | undefined, dim?: number): number[];
export declare function cosineSim(a: readonly number[], b: readonly number[]): number;
export declare function rankMetrics(
  goldRank: number,
  k?: number,
): { recallAt1: 0 | 1; recallAtK: 0 | 1; reciprocalRank: number };
export declare function parseProviderSpec(spec: string): {
  kind: "hash" | "openai-compatible";
  model: string;
};
